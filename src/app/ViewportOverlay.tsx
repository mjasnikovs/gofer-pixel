import {Kbd} from '@astryxdesign/core/Kbd'
import {Text} from '@astryxdesign/core/Text'
import type {Cell} from '../doc/selection'
import {basisFor, type Camera, type Vec3} from '../render/camera'

import {filledBounds, type Volume} from '../render/volume'
import {CameraIcon, MouseIcon} from './icons'

/**
 * The three things that float over the render in `docs/editor.png`: which way the axes point, a
 * view cube, and a bar naming the gestures.
 *
 * The axis gizmo is computed from the same basis the shader is handed, so it cannot drift from what
 * is on screen. It reports this project's axes, not the mockup's: `.vox` is z-up and the raycaster
 * assumes it, so **Z** is the vertical one here. A gizmo that drew the mockup's Y upward would be a
 * picture of a different coordinate system, which is precisely the class of bug the normal-map
 * convention note in `docs/FEATURESET.md` §19 is about.
 */
const AXES: readonly {label: string; vector: Vec3; color: string}[] = [
    {label: 'X', vector: [1, 0, 0], color: '#e4574c'},
    {label: 'Y', vector: [0, 1, 0], color: '#4caf50'},
    {label: 'Z', vector: [0, 0, 1], color: '#4a8ff0'}
]

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

const GIZMO = 30

/**
 * The ground grid, drawn over the render rather than in it.
 *
 * It has to be an overlay: putting it in the shader would put it in the CPU raycaster too, or else
 * break the parity those two are held to, and a grid is not part of a sprite. So it is projected
 * with the camera's own basis — one `viewBox` in voxels, sliced the way an orthographic camera
 * slices, which is exactly what `zoom` means — and then masked by the volume's projected bounding
 * box so the lines stop at the model instead of being drawn across its face.
 *
 * The mask is a convex hull of the eight projected corners. A box seen from any angle projects to a
 * convex hexagon (or a rectangle head-on), so the hull is the silhouette, exactly.
 */
const hull = (points: {x: number; y: number}[]): {x: number; y: number}[] => {
    const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
    const half = (source: {x: number; y: number}[]): {x: number; y: number}[] => {
        const out: {x: number; y: number}[] = []
        for (const point of source) {
            while (out.length >= 2) {
                const a = out[out.length - 2]
                const b = out[out.length - 1]
                if (!a || !b) break
                const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)
                if (cross > 0) break
                out.pop()
            }
            out.push(point)
        }
        out.pop()
        return out
    }
    return [...half(sorted), ...half([...sorted].reverse())]
}

export const GroundGrid = ({volume, camera}: {volume: Volume; camera: Camera}) => {
    const {right, up, center} = basisFor(camera, volume, 1)
    const project = (p: Vec3): {x: number; y: number} => {
        const d: Vec3 = [p[0] - center[0], p[1] - center[1], p[2] - center[2]]
        return {x: dot(d, right), y: -dot(d, up)}
    }

    // One line per voxel while that is legible, and a coarser lattice once it is not.
    const step = Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(volume.sx, volume.sy) / 24)))
    const pad = step * 4
    const lines: {a: {x: number; y: number}; b: {x: number; y: number}}[] = []
    for (let x = -pad; x <= volume.sx + pad; x += step) {
        lines.push({a: project([x, -pad, 0]), b: project([x, volume.sy + pad, 0])})
    }
    for (let y = -pad; y <= volume.sy + pad; y += step) {
        lines.push({a: project([-pad, y, 0]), b: project([volume.sx + pad, y, 0])})
    }

    /*
     * The hole is cut around the *voxels*, not around the grid.
     *
     * Masking by `sx, sy, sz` looked right on `car.vox`, whose model fills its grid — and took the
     * floor away entirely on any document that does not. A 128³ grid holding a handful of voxels
     * projects a box the size of the viewport, so the artist got a picture with a grid round the
     * edges, nothing under the model, and no way at all to tell how high anything was floating.
     */
    const box = filledBounds(volume)
    const corners: Vec3[] = []
    for (let i = 0; i < 8; i += 1) {
        if (!box) break
        corners.push([
            (i & 1) === 0 ? box.min[0] : box.max[0] + 1,
            ((i >> 1) & 1) === 0 ? box.min[1] : box.max[1] + 1,
            ((i >> 2) & 1) === 0 ? box.min[2] : box.max[2] + 1
        ])
    }
    const silhouette = hull(corners.map(project))
        .map(({x, y}) => `${String(x)},${String(y)}`)
        .join(' ')

    const half = camera.zoom / 2
    return (
        <svg
            className='ground-grid overlay-plane'
            viewBox={`${String(-half)} ${String(-half)} ${String(camera.zoom)} ${String(camera.zoom)}`}
            preserveAspectRatio='xMidYMid slice'
            aria-hidden='true'
        >
            <mask id='ground-grid-mask'>
                <rect
                    x={-half * 4}
                    y={-half * 4}
                    width={half * 8}
                    height={half * 8}
                    fill='white'
                />
                <polygon
                    points={silhouette}
                    fill='black'
                />
            </mask>
            <g mask='url(#ground-grid-mask)'>
                {lines.map((line, index) => (
                    <line
                        key={index}
                        x1={line.a.x}
                        y1={line.a.y}
                        x2={line.b.x}
                        y2={line.b.y}
                        stroke='currentColor'
                        strokeWidth='1'
                        vectorEffect='non-scaling-stroke'
                    />
                ))}
            </g>
        </svg>
    )
}

/**
 * The block the next press makes, unmakes, repaints or takes hold of: the real voxels, in three
 * dimensions, translucent and wireframed — the answer to the question this window could not answer
 * before, which is *what* the press is about to do rather than merely where the pointer is.
 *
 * Every tool on the rail that does anything gets one, and they all get it the same way. What differs
 * is `kind`, which is a promise about the voxels rather than a name for the button: `write` adds,
 * `clear` removes, `recolour` repaints, `sample` takes a colour away, `grab` picks voxels up. Two
 * tools making the same promise look the same, and `app.css` is where each promise gets its paint.
 *
 * The cells come from the state, which got them from the same functions the press runs —
 * `strokeCells`, `connected`, `pressSelection` — so this cannot promise a footprint the edit will
 * not deliver.
 *
 * Above `GHOST_CELLS` the state hands over an empty `cells` and a `bounds`, and the box is drawn
 * instead. A flood fill can be the whole grid; two million wireframed cubes is not a preview, it is
 * a hang. What the box loses is the shape, which for a region that large was never legible anyway,
 * and for `recolour` the shape is on screen regardless — the viewport is rendering the new paint.
 *
 * Two paths for the per-cell form, and neither is a picture of the other:
 *
 * - **Skin.** Each cell contributes only the faces that have no neighbour in the footprint and that
 *   point at the camera. That is the outside of the block, and no interior face is ever drawn — so
 *   the whole thing takes one uniform alpha instead of stacking up wherever two cells overlap.
 * - **Wireframe.** A cube edge is kept when the four cells meeting along it are neither all present
 *   nor all absent. The rule is the whole of it: interior edges of a slab have four neighbours and
 *   vanish, a lone cell keeps its twelve, and a diagonal pinch keeps the edge it pinches at.
 *
 * The back edges show through, deliberately. This is a proposal, not a solid, and a wireframe box
 * that hides its own far side reads as a surface decal rather than as a volume.
 *
 * `blocked` is the case that was silent before: the footprint is off the grid, or locked, or already
 * exactly what the press would write, or — for Pick — the colour is the one already loaded. The
 * press will do nothing at all. It is drawn dashed and inert rather than in a new colour, because
 * "this does nothing" is the absence of an action and should not look like a second kind of action.
 */
/** The three axes, and for each the two it spreads over. Typed so indexing a cell stays a number. */
type Axis3 = 0 | 1 | 2
const AXES3: readonly Axis3[] = [0, 1, 2]
const PERP: Record<Axis3, readonly [Axis3, Axis3]> = {
    0: [1, 2],
    1: [0, 2],
    2: [0, 1]
}

/**
 * The neighbourhoods around a cube edge that are not an edge of anything, as a four-bit mask of the
 * cells meeting along it — bits in the order `(-1,-1) (-1,0) (0,-1) (0,0)` across the two axes the
 * edge does not run down.
 *
 * Empty and full are obvious. The four two-bit entries are the ones worth naming: two cells sitting
 * *side by side* mean the surface runs straight through, so the faces meeting at the edge are
 * coplanar and drawing a line there would rule a lattice across a flat slab. Two cells meeting only
 * at the corner is the opposite case — a genuine pinch — and it stays, as do one and three.
 */
const FLAT: ReadonlySet<number> = new Set([0b0000, 0b1111, 0b0011, 0b1100, 0b0101, 0b1010])

export const BrushGhost = ({
    volume,
    camera,
    hover
}: {
    volume: Volume
    camera: Camera
    hover: GhostHover | undefined
}) => {
    if (!hover) return undefined
    if (hover.cells.length === 0) {
        return (
            <GhostBox
                volume={volume}
                camera={camera}
                hover={hover}
            />
        )
    }
    const {right, up, forward, center} = basisFor(camera, volume, 1)
    const project = (p: Vec3): string => {
        const d: Vec3 = [p[0] - center[0], p[1] - center[1], p[2] - center[2]]
        return `${String(dot(d, right))} ${String(-dot(d, up))}`
    }

    const key = (x: number, y: number, z: number): string =>
        `${String(x)},${String(y)},${String(z)}`
    const cells = new Set(hover.cells.map(([x, y, z]) => key(x, y, z)))

    // The outside of the block, and only the half of it facing the viewer.
    const skin: string[] = []
    for (const cell of hover.cells) {
        const [x, y, z] = cell
        for (const axis of AXES3) {
            for (const side of [0, 1]) {
                const step = side === 0 ? -1 : 1
                const at: [number, number, number] = [x, y, z]
                at[axis] += step
                if (cells.has(key(at[0], at[1], at[2]))) continue
                const normal: [number, number, number] = [0, 0, 0]
                normal[axis] = step
                // A face pointing away from the camera is the far side of the block, and the near
                // side is already covering it.
                if (dot(normal, forward) >= 0) continue
                const [u, v] = PERP[axis]
                const corner = (a: number, b: number): Vec3 => {
                    const point: [number, number, number] = [x, y, z]
                    point[axis] = cell[axis] + side
                    point[u] = cell[u] + a
                    point[v] = cell[v] + b
                    return point
                }
                skin.push(
                    `M${project(corner(0, 0))}`
                        + `L${project(corner(1, 0))}`
                        + `L${project(corner(1, 1))}`
                        + `L${project(corner(0, 1))}Z`
                )
            }
        }
    }

    /*
     * Every edge the footprint could have, keyed by where it runs. `along` is the axis it points
     * down; `a` and `b` are its position on the other two, in lattice coordinates — so the four
     * cells that meet along it are the four combinations of one step back on each.
     */
    const wire: string[] = []
    const seen = new Set<string>()
    for (const cell of hover.cells) {
        for (const along of AXES3) {
            const [u, v] = PERP[along]
            for (const du of [0, 1]) {
                for (const dv of [0, 1]) {
                    const a = cell[u] + du
                    const b = cell[v] + dv
                    const id = `${String(along)}:${String(cell[along])}:${String(a)}:${String(b)}`
                    if (seen.has(id)) continue
                    seen.add(id)

                    let around = 0
                    let bit = 1
                    for (const ou of [-1, 0]) {
                        for (const ov of [-1, 0]) {
                            const at: [number, number, number] = [0, 0, 0]
                            at[along] = cell[along]
                            at[u] = a + ou
                            at[v] = b + ov
                            if (cells.has(key(at[0], at[1], at[2]))) around |= bit
                            bit <<= 1
                        }
                    }
                    if (FLAT.has(around)) continue

                    const end = (t: number): Vec3 => {
                        const point: [number, number, number] = [0, 0, 0]
                        point[along] = cell[along] + t
                        point[u] = a
                        point[v] = b
                        return point
                    }
                    wire.push(`M${project(end(0))}L${project(end(1))}`)
                }
            }
        }
    }

    /*
     * The shadow, and the drop to it.
     *
     * An orthographic camera gives away nothing about height: a block one voxel up and a block ten
     * up are the same picture moved a few pixels, and with an empty grid under them there is nothing
     * to move relative to. So the footprint is repeated on the floor and joined to the block by its
     * four corners — the oldest trick there is, and the only one that reads without a second view.
     */
    let x0 = Infinity
    let y0 = Infinity
    let z0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [x, y, z] of hover.cells) {
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (z < z0) z0 = z
        if (x > x1) x1 = x
        if (y > y1) y1 = y
    }
    const drop: string[] = []
    if (z0 > 0) {
        const feet: [number, number][] = [
            [x0, y0],
            [x1 + 1, y0],
            [x1 + 1, y1 + 1],
            [x0, y1 + 1]
        ]
        drop.push(
            feet.map((f, i) => `${i === 0 ? 'M' : 'L'}${project([f[0], f[1], 0])}`).join('') + 'Z'
        )
        for (const [x, y] of feet) drop.push(`M${project([x, y, z0])}L${project([x, y, 0])}`)
    }

    const half = camera.zoom / 2
    return (
        <svg
            className='brush-ghost overlay-plane'
            data-blocked={hover.blocked || undefined}
            data-kind={hover.kind}
            style={{color: paintOf(volume, hover.paint)}}
            viewBox={`${String(-half)} ${String(-half)} ${String(camera.zoom)} ${String(camera.zoom)}`}
            preserveAspectRatio='xMidYMid slice'
            aria-hidden='true'
        >
            <path
                className='brush-ghost-drop'
                d={drop.join('')}
                fill='none'
                vectorEffect='non-scaling-stroke'
            />
            <path
                className='brush-ghost-fill'
                d={skin.join('')}
            />
            <path
                className='brush-ghost-outline'
                d={wire.join('')}
                fill='none'
                vectorEffect='non-scaling-stroke'
            />
        </svg>
    )
}

/**
 * What the state hands the ghost. The shape rather than `Hover` itself, so the overlay depends on
 * the four fields it draws from and not on the twenty the reducer keeps.
 */
export interface GhostHover {
    readonly kind: string
    /** Empty when the footprint is over `GHOST_CELLS`; `bounds` is the answer then. */
    readonly cells: readonly Cell[]
    readonly bounds: {min: Cell; max: Cell} | undefined
    /** Palette index, or `undefined` for a proposal that puts no paint anywhere. */
    readonly paint: number | undefined
    readonly blocked: boolean
}

/**
 * The colour the proposal would be made of, as CSS. `.brush-ghost-fill` inherits it — a preview in a
 * colour the press would not use says where the block goes and lies about what it is.
 *
 * `undefined` means the kind puts no paint anywhere — Erase, and the four that only take hold of
 * voxels. Those fall back to the theme, which is what their rules in `app.css` are written against.
 */
const paintOf = (volume: Volume, index: number | undefined): string | undefined => {
    if (index === undefined) return undefined
    const at = index * 4
    const [r, g, b] = [
        volume.palette[at] ?? 255,
        volume.palette[at + 1] ?? 255,
        volume.palette[at + 2] ?? 255
    ]
    return `rgb(${String(r)} ${String(g)} ${String(b)})`
}

/**
 * The same proposal, reduced to its box, for a footprint too large to draw one cube each.
 *
 * Twelve edges of the integer bounds, projected with the live basis — the same drawing `SelectionBox`
 * makes, because it is answering the same question about a region of the same kind. It carries the
 * ghost's own `data-kind` and `data-blocked` so a capped preview is still the colour of the promise
 * it is making, and it does not repeat the shadow: the drop lines exist to say how high a small
 * floating block is, and a region this size is not floating anywhere.
 */
const GhostBox = ({volume, camera, hover}: {volume: Volume; camera: Camera; hover: GhostHover}) => {
    const {bounds} = hover
    if (!bounds) return undefined
    const {right, up, center} = basisFor(camera, volume, 1)
    const project = (p: Vec3): {x: number; y: number} => {
        const d: Vec3 = [p[0] - center[0], p[1] - center[1], p[2] - center[2]]
        return {x: dot(d, right), y: -dot(d, up)}
    }
    const {min, max} = bounds
    const flat: {x: number; y: number}[] = []
    for (let i = 0; i < 8; i += 1) {
        flat.push(
            project([
                (i & 1) === 0 ? min[0] : max[0] + 1,
                ((i >> 1) & 1) === 0 ? min[1] : max[1] + 1,
                ((i >> 2) & 1) === 0 ? min[2] : max[2] + 1
            ])
        )
    }

    const half = camera.zoom / 2
    return (
        <svg
            className='brush-ghost overlay-plane'
            data-blocked={hover.blocked || undefined}
            data-kind={hover.kind}
            style={{color: paintOf(volume, hover.paint)}}
            viewBox={`${String(-half)} ${String(-half)} ${String(camera.zoom)} ${String(camera.zoom)}`}
            preserveAspectRatio='xMidYMid slice'
            aria-hidden='true'
        >
            <path
                className='brush-ghost-outline'
                d={BOX_EDGES.map(
                    ([from, to]) =>
                        `M${String(flat[from]?.x ?? 0)} ${String(flat[from]?.y ?? 0)}`
                        + `L${String(flat[to]?.x ?? 0)} ${String(flat[to]?.y ?? 0)}`
                ).join('')}
                fill='none'
                vectorEffect='non-scaling-stroke'
            />
        </svg>
    )
}

/**
 * The box around what is selected, and the rubber band that is choosing it.
 *
 * The box is the selection's own integer bounds projected with the live basis — the same trick as
 * `ViewCube`, for the same reason: it turns with the model instead of being a decal of one angle.
 * Bounds rather than a per-voxel outline because a selection can be thousands of cells, and twelve
 * lines say where it is without asking the browser to lay out ten thousand paths.
 */
export const SelectionBox = ({
    volume,
    camera,
    bounds,
    band
}: {
    volume: Volume
    camera: Camera
    bounds: {min: Vec3; max: Vec3} | undefined
    band: {x0: number; y0: number; x1: number; y1: number} | undefined
}) => {
    const {right, up, center} = basisFor(camera, volume, 1)
    const project = (p: Vec3): {x: number; y: number} => {
        const d: Vec3 = [p[0] - center[0], p[1] - center[1], p[2] - center[2]]
        return {x: dot(d, right), y: -dot(d, up)}
    }
    const half = camera.zoom / 2

    const corners: Vec3[] = []
    if (bounds) {
        const {min, max} = bounds
        for (let i = 0; i < 8; i += 1) {
            corners.push([
                (i & 1) === 0 ? min[0] : max[0] + 1,
                ((i >> 1) & 1) === 0 ? min[1] : max[1] + 1,
                ((i >> 2) & 1) === 0 ? min[2] : max[2] + 1
            ])
        }
    }
    const flat = corners.map(project)

    return (
        <>
            {flat.length === 8 ?
                <svg
                    className='selection-box overlay-plane'
                    viewBox={`${String(-half)} ${String(-half)} ${String(camera.zoom)} ${String(camera.zoom)}`}
                    preserveAspectRatio='xMidYMid slice'
                    aria-hidden='true'
                >
                    {BOX_EDGES.map(([from, to]) => (
                        <line
                            key={`${String(from)}-${String(to)}`}
                            x1={flat[from]?.x ?? 0}
                            y1={flat[from]?.y ?? 0}
                            x2={flat[to]?.x ?? 0}
                            y2={flat[to]?.y ?? 0}
                            stroke='currentColor'
                            strokeWidth='1.5'
                            vectorEffect='non-scaling-stroke'
                        />
                    ))}
                </svg>
            :   undefined}
            {band ?
                <div
                    className='rubber-band'
                    style={{
                        left: Math.min(band.x0, band.x1),
                        top: Math.min(band.y0, band.y1),
                        width: Math.abs(band.x1 - band.x0),
                        height: Math.abs(band.y1 - band.y0)
                    }}
                />
            :   undefined}
        </>
    )
}

const BOX_EDGES: readonly [number, number][] = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7]
]

export const AxisGizmo = ({volume, camera}: {volume: Volume; camera: Camera}) => {
    const {right, up, forward} = basisFor(camera, volume, 1)
    // Painter's order: an axis pointing away from the viewer is drawn first, so the near one wins
    // the overlap the way it does in the render behind it.
    const spokes = AXES.map(axis => ({
        ...axis,
        x: dot(axis.vector, right) * GIZMO,
        y: -dot(axis.vector, up) * GIZMO,
        depth: dot(axis.vector, forward)
    })).sort((a, b) => b.depth - a.depth)

    return (
        <svg
            className='gizmo'
            viewBox='-40 -40 80 80'
            width='72'
            height='72'
            aria-hidden='true'
        >
            {spokes.map(spoke => (
                <g key={spoke.label}>
                    <line
                        x1='0'
                        y1='0'
                        x2={spoke.x}
                        y2={spoke.y}
                        stroke={spoke.color}
                        strokeWidth='2'
                        strokeLinecap='round'
                    />
                    <text
                        x={spoke.x * 1.28}
                        y={spoke.y * 1.28}
                        fill={spoke.color}
                        fontSize='10'
                        textAnchor='middle'
                        dominantBaseline='middle'
                    >
                        {spoke.label}
                    </text>
                </g>
            ))}
        </svg>
    )
}

/**
 * The wireframe cube in the bottom-right corner, drawn from the live basis for the same reason the
 * gizmo is: it is the volume's own bounding box, so it turns with the model instead of being a
 * decal of one particular angle.
 */
export const ViewCube = ({volume, camera}: {volume: Volume; camera: Camera}) => {
    const {right, up} = basisFor(camera, volume, 1)
    const corners: Vec3[] = []
    for (let i = 0; i < 8; i += 1)
        corners.push([(i & 1) - 0.5, ((i >> 1) & 1) - 0.5, ((i >> 2) & 1) - 0.5])
    const flat = corners.map(corner => ({
        x: dot(corner, right) * 44,
        y: -dot(corner, up) * 44
    }))
    const edges: [number, number][] = [
        [0, 1],
        [2, 3],
        [4, 5],
        [6, 7],
        [0, 2],
        [1, 3],
        [4, 6],
        [5, 7],
        [0, 4],
        [1, 5],
        [2, 6],
        [3, 7]
    ]

    return (
        <svg
            className='view-cube'
            viewBox='-32 -32 64 64'
            width='60'
            height='60'
            aria-hidden='true'
        >
            {edges.map(([from, to]) => (
                <line
                    key={`${String(from)}-${String(to)}`}
                    x1={flat[from]?.x ?? 0}
                    y1={flat[from]?.y ?? 0}
                    x2={flat[to]?.x ?? 0}
                    y2={flat[to]?.y ?? 0}
                    stroke='currentColor'
                    strokeWidth='1'
                />
            ))}
        </svg>
    )
}

/**
 * The gesture bar. It names what this viewport does rather than what the mockup's caption says,
 * because a hint that is not the binding is worse than no hint.
 *
 * The left button belongs to the armed tool now that tools write voxels, so orbiting moved to the
 * right button — the arrangement every voxel editor already uses, and the only one where arming
 * Draw does not cost the artist the ability to look at what they are drawing.
 */
export const HintBar = ({
    tool,
    hover,
    height,
    onCapture
}: {
    tool: string
    /** Where the next click lands, in the grid's own coordinates. */
    hover: {cell: Cell; blocked: boolean} | undefined
    /** How tall the grid is, so the layer reads as a position rather than as a number. */
    height: number
    onCapture: () => void
}) => (
    <div className='hints'>
        <span className='hint'>
            <MouseIcon />
            <Text type='supporting'>{tool}</Text>
        </span>
        {/*
         * The cell under the cursor, and how high it is.
         *
         * An orthographic view of a lattice of identical cubes cannot be read for position — the
         * shadow says which way is up, and this says exactly where. `Z of sz` rather than a bare
         * number, because "6" means nothing and "6 / 32" is a height.
         */}
        <span
            className='hint hint-cell'
            data-blocked={hover?.blocked === true || undefined}
        >
            {hover ?
                <>
                    <Text type='supporting'>
                        {hover.cell[0]}, {hover.cell[1]}
                    </Text>
                    <Text
                        type='supporting'
                        color='disabled'
                    >
                        Z
                    </Text>
                    <Text type='supporting'>
                        {hover.cell[2]} / {height - 1}
                    </Text>
                </>
            :   <Text
                    type='supporting'
                    color='disabled'
                >
                    off the model
                </Text>
            }
        </span>
        <span className='hint'>
            <Text
                type='supporting'
                color='disabled'
            >
                Right
            </Text>
            <Text type='supporting'>Rotate</Text>
        </span>
        <span className='hint'>
            <Kbd keys='shift' />
            <Text type='supporting'>Pan</Text>
        </span>
        <span className='hint'>
            <Text
                type='supporting'
                color='disabled'
            >
                Wheel
            </Text>
            <Text type='supporting'>Zoom</Text>
        </span>
        <span className='hint-divider' />
        <button
            type='button'
            className='hint hint-action'
            title='Store the current view as a new camera'
            onClick={onCapture}
        >
            <CameraIcon />
            <Text type='supporting'>Capture view</Text>
            <Kbd keys='c' />
        </button>
    </div>
)
