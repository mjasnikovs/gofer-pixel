import {expect, test} from 'bun:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {createCamera} from '../render/camera'
import {createVolume, setVoxel} from '../render/volume'
import {
    BrushGhost,
    GroundGrid,
    HintBar,
    SelectionBox,
    ViewCube,
    type GhostHover
} from './ViewportOverlay'
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
 * The lattice arithmetic itself is `overlay.ts` and `overlay.test.ts` — where it can be asked about
 * points rather than about the letters in a `d` attribute. What is left here is what only exists
 * once it is SVG: the masks, the gradient, and the elements they are hung on.
 */
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

/*
 * The selection box, and the rubber band that is choosing it.
 *
 * Bounds rather than a per-voxel outline because a selection can be thousands of cells, and twelve
 * lines say where it is without asking the browser to lay out ten thousand paths. The band is the
 * other half: it is screen-space, so it is a `div` and not part of the projected drawing.
 */
const selection = async (
    bounds: {min: [number, number, number]; max: [number, number, number]} | undefined,
    band?: {x0: number; y0: number; x1: number; y1: number},
    losing = 0
) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
        root.render(
            <SelectionBox
                volume={volume}
                camera={createCamera(volume, 0.6, 0.5)}
                bounds={bounds}
                band={band}
                losing={losing}
            />
        )
    })
    return {
        host,
        done: async () => {
            await act(async () => {
                root.unmount()
            })
            host.remove()
        }
    }
}

test('nothing selected and no drag is nothing drawn', async () => {
    const drawn = await selection(undefined)

    expect(drawn.host.innerHTML).toBe('')
    await drawn.done()
})

test('a selection is its twelve projected edges, and a doomed drag says so on the box', async () => {
    const drawn = await selection({min: [1, 1, 1], max: [4, 4, 4]})
    const svg = drawn.host.querySelector('svg.selection-box')
    // Twelve `<line>`s rather than one path: they are the box's own edges and nothing joins them.
    expect(svg?.querySelectorAll('line')).toHaveLength(12)
    expect(svg?.getAttribute('data-losing')).toBeNull()
    await drawn.done()

    const doomed = await selection({min: [1, 1, 1], max: [4, 4, 4]}, undefined, 7)
    expect(doomed.host.querySelector('svg')?.getAttribute('data-losing')).toBe('true')
    await doomed.done()
})

/*
 * The band is drawn in screen pixels, not through the basis: it is a rectangle on the glass the
 * artist is dragging out, and projecting it would make it lean with the model under it.
 */
test('the rubber band is a plain rectangle, right way up whichever way it was dragged', async () => {
    const forwards = await selection(undefined, {x0: 10, y0: 20, x1: 60, y1: 90})
    const backwards = await selection(undefined, {x0: 60, y0: 90, x1: 10, y1: 20})

    const box = (host: HTMLElement): string | null =>
        host.querySelector<HTMLElement>('.rubber-band')?.getAttribute('style') ?? null

    expect(box(forwards.host)).toBe(box(backwards.host))
    expect(box(forwards.host)).toContain('left: 10px')
    expect(box(forwards.host)).toContain('top: 20px')
    expect(box(forwards.host)).toContain('width: 50px')
    expect(box(forwards.host)).toContain('height: 70px')

    await forwards.done()
    await backwards.done()
})

/*
 * The toll a drag is about to take, in the middle of the bar rather than in a corner: a warning
 * nobody reads is the same as no warning, and it exists only while the drag does.
 */
test('the hint bar counts the voxels a drag would destroy, and says voxel once', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const show = async (losing: number): Promise<string> => {
        await act(async () => {
            root.render(
                <HintBar
                    tool='Move'
                    hover={undefined}
                    blocking={undefined}
                    height={8}
                    losing={losing}
                    onCapture={() => undefined}
                />
            )
        })
        return host.querySelector('.hint-losing')?.textContent ?? ''
    }

    expect(await show(0)).toBe('')
    expect(await show(1)).toContain('1 voxel will be destroyed')
    expect(await show(12)).toContain('12 voxels will be destroyed')

    await act(async () => {
        root.unmount()
    })
    host.remove()
})
