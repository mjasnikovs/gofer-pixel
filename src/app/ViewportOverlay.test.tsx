import {expect, test} from 'bun:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {basisFor, createCamera} from '../render/camera'
import {createVolume, setVoxel, type Volume} from '../render/volume'
import {BrushGhost, GroundGrid, HintBar, ViewCube, type GhostHover} from './ViewportOverlay'
import type {Blocked} from './state'

const volume = createVolume(8, 8, 8, new Uint8Array(256 * 4))
setVoxel(volume, 3, 3, 3, 1)

/**
 * The cube is drawn from the live basis, so its projected size is not constant: a corner-on view
 * spreads the eight corners over `sqrt(3)` times the half-diagonal, an axis-aligned one over `1`.
 * The `viewBox` has to hold the widest of those, not the narrowest, or the artist sees a cube with
 * its corners sliced off at exactly the angles they orbit to most.
 */
const cubeExtent = async (yaw: number, pitch: number): Promise<number> => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
        root.render(
            <ViewCube
                volume={volume}
                camera={createCamera(volume, yaw, pitch)}
            />
        )
    })

    const svg = host.querySelector('svg.view-cube')
    if (!svg) throw new Error('no view cube')
    const [, , width] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number)
    const stroke = Number(svg.querySelector('line')?.getAttribute('stroke-width') ?? 1)

    let reach = 0
    for (const line of svg.querySelectorAll('line'))
        for (const name of ['x1', 'y1', 'x2', 'y2'])
            reach = Math.max(reach, Math.abs(Number(line.getAttribute(name))) + stroke / 2)

    await act(async () => {
        root.unmount()
    })
    host.remove()
    return reach / ((width ?? 0) / 2)
}

test('the view cube fits inside its viewBox from every angle', async () => {
    const overflowing: string[] = []
    for (let yaw = 0; yaw < 360; yaw += 15)
        for (let pitch = -90; pitch <= 90; pitch += 15) {
            const fill = await cubeExtent((yaw * Math.PI) / 180, (pitch * Math.PI) / 180)
            if (fill > 1)
                overflowing.push(`yaw ${String(yaw)}° pitch ${String(pitch)}°: ${fill.toFixed(2)}×`)
        }
    expect(overflowing).toEqual([])
})

test('the view cube still fills its viewBox at the angle that spreads it widest', async () => {
    // A wireframe that never touches its box is a cube drawn small, which is the other failure.
    expect(await cubeExtent(Math.PI / 4, Math.atan(Math.SQRT1_2))).toBeGreaterThan(0.9)
})

/** The hint bar, rendered on its own, so the message can be read the way an artist reads it. */
const hintText = async (
    blocked: Blocked | undefined,
    blocking: string | undefined
): Promise<string> => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
        root.render(
            <HintBar
                tool='Erase'
                hover={{cell: [1, 2, 3], blocked}}
                blocking={blocking}
                height={8}
                losing={0}
                onCapture={() => undefined}
            />
        )
    })
    const said = host.querySelector('.hint-blocked')?.textContent ?? ''
    const reason = host.querySelector('.hint-blocked')?.getAttribute('data-reason') ?? ''
    await act(async () => {
        root.unmount()
    })
    host.remove()
    return `${reason}: ${said}`
}

/**
 * The bar has to name the lock, not merely register that something is off.
 *
 * This is the whole fix for a defect that cost an afternoon: erase over a locked object did nothing,
 * and the only sign was a dashed outline that means three different things. Words, and the object's
 * own name, are what tell "this is locked" from "there is nothing here to rub out".
 */
test('the hint bar says which silence this is, and names the object when there is one', async () => {
    expect(await hintText({reason: 'locked', object: 2}, 'Roof')).toBe('locked: Roof is locked')
    expect(await hintText({reason: 'outside', object: undefined}, undefined)).toBe(
        'outside: Outside the grid'
    )
    expect(await hintText({reason: 'nothing', object: undefined}, undefined)).toBe(
        'nothing: Nothing to change here'
    )
    // A press that will land says nothing at all. A bar with a permanent slot for "fine" is a bar
    // the artist stops reading.
    expect(await hintText(undefined, undefined)).toBe(': ')
})

/*
 * The brush ghost — the promise the press is making, drawn before it is kept.
 *
 * Three paths come out of it: the near skin, the wireframe, and the drop to the floor. Each one has
 * a rule about what it may *not* draw, and those rules are what these tests hold: no face that is
 * buried inside the block, no line ruled across a flat slab, no shadow under something standing on
 * the ground.
 */
const ghost = async (
    hover: GhostHover | undefined,
    camera = createCamera(volume, 0.6, 0.5),
    grid = volume
) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
        root.render(
            <BrushGhost
                volume={grid}
                camera={camera}
                hover={hover}
            />
        )
    })
    const svg = host.querySelector('svg.brush-ghost')
    const path = (name: string): string =>
        host.querySelector(`.brush-ghost-${name}`)?.getAttribute('d') ?? ''
    return {
        host,
        svg,
        path,
        /** How many subpaths a path holds — one `M` each. */
        moves: (name: string): number => (path(name).match(/M/g) ?? []).length,
        done: async () => {
            await act(async () => {
                root.unmount()
            })
            host.remove()
        }
    }
}

const hovering = (cells: readonly [number, number, number][], extra: Partial<GhostHover> = {}) => ({
    kind: 'draw',
    cells,
    bounds: undefined,
    paint: 1,
    blocked: undefined,
    ...extra
})

test('no hover means no ghost at all', async () => {
    const drawn = await ghost(undefined)

    expect(drawn.svg).toBeNull()
    await drawn.done()
})

test('a single floating cell draws three faces, twelve edges and a shadow', async () => {
    const drawn = await ghost(hovering([[3, 3, 4]]))

    // Half the cube faces away and the near side already covers it.
    expect(drawn.moves('fill')).toBe(3)
    // Nothing next to it, so no edge is coplanar with anything.
    expect(drawn.moves('outline')).toBe(12)
    // The footprint on the floor, plus a line down to it from each of its four corners.
    expect(drawn.moves('drop')).toBe(5)

    await drawn.done()
})

test('a cell standing on the floor casts no shadow, because there is nowhere to drop to', async () => {
    const drawn = await ghost(hovering([[3, 3, 0]]))

    expect(drawn.path('drop')).toBe('')
    expect(drawn.moves('fill')).toBe(3)

    await drawn.done()
})

/*
 * The face between two touching cells is inside the block. Drawing it costs nothing visible and
 * everything in trust: a preview with internal faces in it is not a preview of a solid.
 */
test('two cells side by side hide the face they share', async () => {
    const one = await ghost(hovering([[3, 3, 4]]))
    const two = await ghost(
        hovering([
            [3, 3, 4],
            [4, 3, 4]
        ])
    )

    // Six near faces if they were drawn separately; five, because the shared pair is one of them
    // and only the visible half is drawn at all.
    expect(two.moves('fill')).toBeLessThan(one.moves('fill') * 2)

    await one.done()
    await two.done()
})

test('a flat run of cells is not ruled into a lattice', async () => {
    const run = await ghost(
        hovering([
            [2, 3, 4],
            [3, 3, 4],
            [4, 3, 4]
        ])
    )

    /*
     * Edges are drawn a cell at a time, so a 3 × 1 × 1 bar is four long edges cut into three
     * segments each — twelve — plus four around each end cap. Twenty. Three loose cubes would be
     * thirty-six, and the sixteen missing are exactly the cross-sections `FLAT` refuses to rule
     * across a straight run.
     */
    expect(run.moves('outline')).toBe(20)

    await run.done()
})

test('two cells touching only at a corner keep the pinch between them', async () => {
    const pinched = await ghost(
        hovering([
            [3, 3, 4],
            [4, 4, 4]
        ])
    )

    // The edge where the two meet is a genuine crease, so it survives where a side-by-side pair's
    // would not: more edges than the 12 of a solid bar.
    expect(pinched.moves('outline')).toBeGreaterThan(12)

    await pinched.done()
})

test('the ghost is the colour the press would actually put down', async () => {
    const painted = new Uint8Array(256 * 4)
    painted.set([10, 120, 230, 255], 3 * 4)
    const grid = createVolume(8, 8, 8, painted)

    const drawn = await ghost(hovering([[3, 3, 4]], {paint: 3}), createCamera(grid, 0.6, 0.5), grid)
    expect(drawn.svg?.getAttribute('style')).toContain('rgb(10 120 230)')
    await drawn.done()

    // Erase and the four tools that only take hold of voxels put no paint anywhere, so they fall
    // back to the theme rather than promising a colour.
    const plain = await ghost(hovering([[3, 3, 4]], {kind: 'erase', paint: undefined}))
    expect(plain.svg?.getAttribute('style') ?? '').not.toContain('rgb')
    expect(plain.svg?.getAttribute('data-kind')).toBe('erase')
    await plain.done()
})

test('a blocked press says why on the element, so the stylesheet can tell the three apart', async () => {
    const drawn = await ghost(hovering([[3, 3, 4]], {blocked: {reason: 'locked', object: 2}}))

    expect(drawn.svg?.getAttribute('data-blocked')).toBe('locked')
    await drawn.done()
})

/*
 * Past a cap, the footprint stops being one cube each and becomes its own bounding box — a region
 * that size is not floating anywhere, so it drops the shadow and keeps the twelve edges.
 */
test('a footprint too large to draw cell by cell becomes its box', async () => {
    const drawn = await ghost(
        hovering([], {bounds: {min: [0, 0, 0], max: [6, 6, 6]}, kind: 'fill'})
    )

    expect(drawn.svg).not.toBeNull()
    expect(drawn.moves('outline')).toBe(12)
    expect(drawn.host.querySelector('.brush-ghost-fill')).toBeNull()
    expect(drawn.host.querySelector('.brush-ghost-drop')).toBeNull()
    expect(drawn.svg?.getAttribute('data-kind')).toBe('fill')

    await drawn.done()
})

test('a capped footprint with no bounds to fall back on draws nothing', async () => {
    const drawn = await ghost(hovering([]))

    expect(drawn.svg).toBeNull()
    await drawn.done()
})

test('the ghost turns with the model rather than being a decal of one angle', async () => {
    const one = await ghost(hovering([[3, 3, 4]]), createCamera(volume, 0, 0))
    const first = one.path('outline')
    await one.done()

    const other = await ghost(hovering([[3, 3, 4]]), createCamera(volume, 0.9, 0.4))
    expect(other.path('outline')).not.toBe(first)
    await other.done()
})

/**
 * The floor is two lattices, and the seam between them is the promise the grid makes.
 *
 * Inside the volume, one line per voxel, stopping dead on the boundary — a cell drawn is a cell that
 * can be filled. Outside, a coarser lattice that fades away, so the ground is still there to judge
 * height against without offering squares that answer a press with "Outside the grid".
 */
const floor = async (
    box: Volume
): Promise<{
    fine: SVGLineElement[]
    ground: SVGLineElement[]
    project: (p: readonly [number, number, number]) => {x: number; y: number}
    done: () => Promise<void>
}> => {
    const camera = createCamera(box, 0.9, 0.5)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
        root.render(
            <GroundGrid
                volume={box}
                camera={camera}
            />
        )
    })

    const fade = host.querySelector('g[mask="url(#ground-grid-fade)"]')
    const ground = [...(fade?.querySelectorAll('line') ?? [])]
    const fine = [...host.querySelectorAll('line')].filter(line => !ground.includes(line))

    const {right, up, center} = basisFor(camera, box, 1)
    const project = (p: readonly [number, number, number]) => {
        const d = [p[0] - center[0], p[1] - center[1], p[2] - center[2]] as const
        return {
            x: d[0] * right[0] + d[1] * right[1] + d[2] * right[2],
            y: -(d[0] * up[0] + d[1] * up[1] + d[2] * up[2])
        }
    }

    return {
        fine,
        ground,
        project,
        done: async () => {
            await act(async () => {
                root.unmount()
            })
            host.remove()
        }
    }
}

const ends = (lines: SVGLineElement[]): {x: number; y: number}[] =>
    lines.flatMap(line => [
        {x: Number(line.getAttribute('x1')), y: Number(line.getAttribute('y1'))},
        {x: Number(line.getAttribute('x2')), y: Number(line.getAttribute('y2'))}
    ])

test('the fine lattice stops exactly on the boundary of the volume', async () => {
    const box = createVolume(32, 32, 32, new Uint8Array(256 * 4))
    const drawn = await floor(box)

    expect(drawn.fine.length).toBeGreaterThan(0)

    // The corners of the floor the artist may actually draw on, projected.
    const corners = [
        drawn.project([0, 0, 0]),
        drawn.project([box.sx, 0, 0]),
        drawn.project([0, box.sy, 0]),
        drawn.project([box.sx, box.sy, 0])
    ]
    const limit = Math.max(...corners.map(c => Math.hypot(c.x, c.y)))
    const reach = Math.max(...ends(drawn.fine).map(p => Math.hypot(p.x, p.y)))

    expect(reach).toBeLessThanOrEqual(limit + 1e-6)
    // And it reaches the boundary rather than stopping short of it.
    expect(reach).toBeGreaterThan(limit - 1e-6)

    await drawn.done()
})

test('the ground beyond the volume is coarser than the cells inside it, and reaches further', async () => {
    const box = createVolume(32, 32, 32, new Uint8Array(256 * 4))
    const drawn = await floor(box)

    const spacing = (lines: SVGLineElement[]): number => {
        const seen = [...new Set(ends(lines).map(p => p.x.toFixed(4)))].map(Number).sort((a, b) => a - b) // prettier-ignore
        let gap = Infinity
        for (let i = 1; i < seen.length; i += 1) gap = Math.min(gap, (seen[i] ?? 0) - (seen[i - 1] ?? 0)) // prettier-ignore
        return gap
    }

    expect(spacing(drawn.ground)).toBeGreaterThan(spacing(drawn.fine) * 1.5)

    const out = Math.max(...ends(drawn.ground).map(p => Math.hypot(p.x, p.y)))
    const inside = Math.max(...ends(drawn.fine).map(p => Math.hypot(p.x, p.y)))
    expect(out).toBeGreaterThan(inside)

    await drawn.done()
})

test('the ground fades out, so nothing far from the volume asks to be clicked', async () => {
    const box = createVolume(32, 32, 32, new Uint8Array(256 * 4))
    const camera = createCamera(box, 0.9, 0.5)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
        root.render(
            <GroundGrid
                volume={box}
                camera={camera}
            />
        )
    })

    const stops = [...host.querySelectorAll('#ground-grid-falloff stop')]
    expect(stops.map(stop => stop.getAttribute('stop-color'))).toEqual(['white', 'black'])
    // Full strength out to the volume's own corner, gone by the edge of the ground.
    expect(Number(stops[0]?.getAttribute('offset'))).toBeGreaterThan(0)
    expect(Number(stops[0]?.getAttribute('offset'))).toBeLessThan(1)

    await act(async () => {
        root.unmount()
    })
    host.remove()
})
