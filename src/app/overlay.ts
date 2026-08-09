import {basisFor, type Camera, type Vec3} from '../render/camera'
import type {Cell} from '../doc/selection'
import {filledBounds, type Volume} from '../render/volume'

/**
 * The arithmetic behind the overlays — projection, the floor lattice, and the ghost's three meshes.
 *
 * `ViewportOverlay.tsx` was 925 lines and almost none of it was drawing. It was a convex hull, a
 * face-culled skin with a back-face test, a wireframe filtered through a four-bit neighbourhood
 * mask, a shadow footprint, and an adaptive two-lattice floor with a `log2` step and a screen-space
 * radial falloff — none of it reachable except by rendering SVG and parsing the strings back. Its
 * test file re-implemented a parser to do exactly that: `moves('outline')` counted `M` characters
 * in a `d` attribute, `spacing()` recovered the lattice pitch by de-duplicating `x.toFixed(4)`. A
 * claim about geometry, expressed as a count of letters.
 *
 * So the geometry is here, as functions from numbers to points, and the components are the thin
 * part that turns points into `d` strings. `viewport/orbit.ts` is the precedent: gesture arithmetic
 * as a pure function, React as the adapter.
 *
 * Nothing here knows what SVG is.
 */

export interface Point {
    readonly x: number
    readonly y: number
}

export interface Segment {
    readonly a: Point
    readonly b: Point
}

/** A face of the ghost, as its four corners in winding order. */
export type Quad = readonly [Point, Point, Point, Point]

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/**
 * The camera basis as a function from a point in the grid to a point on screen.
 *
 * This closure was written out four times in `ViewportOverlay.tsx` — in the floor, the ghost, the
 * ghost's box and the selection box — identically each time, except that one of them returned a
 * pre-formatted string. Four copies of the one thing every overlay has to agree about.
 */
export const projector = (camera: Camera, volume: Volume): ((p: Vec3) => Point) => {
    const {right, up, center} = basisFor(camera, volume, 1)
    return p => {
        const d: Vec3 = [p[0] - center[0], p[1] - center[1], p[2] - center[2]]
        return {x: dot(d, right), y: -dot(d, up)}
    }
}

/** The twelve edges of a box, as index pairs into the eight corners `boxCorners` returns. */
export const BOX_EDGES: readonly (readonly [number, number])[] = [
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

/**
 * The eight corners of an integer cell range, in lattice coordinates.
 *
 * `max` is inclusive in cells and exclusive in lattice space, which is the `+ 1`: a selection whose
 * max cell is 3 has its far face at 4.
 */
export const boxCorners = (min: Vec3 | Cell, max: Vec3 | Cell): readonly Vec3[] => {
    const out: Vec3[] = []
    for (let i = 0; i < 8; i += 1) {
        out.push([
            (i & 1) === 0 ? min[0] : max[0] + 1,
            ((i >> 1) & 1) === 0 ? min[1] : max[1] + 1,
            ((i >> 2) & 1) === 0 ? min[2] : max[2] + 1
        ])
    }
    return out
}

/** The unit cube centred on the origin — what the view cube is drawn from. */
export const unitCubeCorners = (): readonly Vec3[] => {
    const out: Vec3[] = []
    for (let i = 0; i < 8; i += 1) {
        out.push([(i & 1) - 0.5, ((i >> 1) & 1) - 0.5, ((i >> 2) & 1) - 0.5])
    }
    return out
}

/**
 * The convex hull of projected points, as the silhouette of a box.
 *
 * A box seen from any angle projects to a convex hexagon, or a rectangle head-on, so the hull *is*
 * the silhouette — exactly, not approximately.
 */
export const hull = (points: readonly Point[]): readonly Point[] => {
    const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
    const half = (source: readonly Point[]): Point[] => {
        const out: Point[] = []
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

/** What the ground grid is made of, in projected coordinates. */
export interface Floor {
    /** One line per voxel inside the grid, stopping dead on the boundary. */
    readonly fine: readonly Segment[]
    /** The coarser lattice around it, which reads as ground rather than as cells. */
    readonly ground: readonly Segment[]
    /** Centre of the radial falloff, in screen space. */
    readonly middle: Point
    /** Full strength out to here — the furthest projected corner of the volume itself. */
    readonly inner: number
    /** Gone by here — the furthest corner of the coarse lattice. */
    readonly outer: number
    /** The model's own silhouette, which the floor is masked out of. Empty for an empty grid. */
    readonly silhouette: readonly Point[]
    /** The lattice pitch in voxels, fine and coarse. Exposed because it is what a test asks about. */
    readonly step: number
    readonly coarse: number
}

/**
 * The floor under the model — two lattices, a falloff and a hole.
 *
 * Every number in here was a bug once, and the comments are the record:
 *
 * - **`step` is keyed to `zoom`, not to the grid.** Legibility is a screen question. Keyed to
 *   `sx, sy` it drew two-voxel cells on a 32³ document with room for one-voxel ones, and never
 *   coarsened at all when the artist zoomed out.
 * - **Two lattices, because a cell is a promise.** One uniform lattice ran `pad` voxels past the
 *   volume and every square out there took a press that did nothing but say "Outside the grid".
 *   Inside, one line per voxel — small squares read as pixels. Outside, five times coarser and
 *   faded — big squares read as ground, and nothing far out invites a click.
 * - **The ground is laid out from the middle.** Walking from `-pad` in steps of `coarse` only lands
 *   on the far edge when `coarse` divides the volume. It divided 32 at four voxels and not at five,
 *   so the floor gained a stub cell on two sides and read as pushed off-centre.
 * - **The falloff is radial in screen space**, so it does not swing about as the camera orbits.
 * - **The hole is cut around the voxels, not around the grid.** A 128³ grid holding a handful of
 *   voxels projects a box the size of the viewport, and masking by `sx, sy, sz` took the floor away
 *   entirely — a grid round the edges, nothing under the model, and no way to tell how high
 *   anything was floating.
 */
export const floorOf = (volume: Volume, camera: Camera): Floor => {
    const project = projector(camera, volume)

    const step = Math.max(1, 2 ** Math.ceil(Math.log2(camera.zoom / 128)))
    const coarse = step * 5
    const pad = coarse * 2

    /** Every gridline coordinate from `from` to `to`, always including `to` itself. */
    const ticks = (from: number, to: number, by: number): number[] => {
        const out: number[] = []
        for (let k = from; k < to; k += by) out.push(k)
        out.push(to)
        return out
    }
    const span = (a: Vec3, b: Vec3): Segment => ({a: project(a), b: project(b)})

    const fine = [
        ...ticks(0, volume.sx, step).map(x => span([x, 0, 0], [x, volume.sy, 0])),
        ...ticks(0, volume.sy, step).map(y => span([0, y, 0], [volume.sx, y, 0]))
    ]

    const around = (mid: number, out: number, by: number): number[] => {
        const n = Math.ceil(out / by)
        const line: number[] = []
        for (let k = -n; k <= n; k += 1) line.push(mid + k * by)
        return line
    }
    const midOf = (size: number): number => Math.round(size / 2 / step) * step
    const xs = around(midOf(volume.sx), volume.sx / 2 + pad, coarse)
    const ys = around(midOf(volume.sy), volume.sy / 2 + pad, coarse)
    const x0 = xs[0] ?? 0
    const x1 = xs[xs.length - 1] ?? 0
    const y0 = ys[0] ?? 0
    const y1 = ys[ys.length - 1] ?? 0
    const ground = [
        ...xs.map(x => span([x, y0, 0], [x, y1, 0])),
        ...ys.map(y => span([x0, y, 0], [x1, y, 0]))
    ]

    const middle = project([volume.sx / 2, volume.sy / 2, 0])
    const reach = (x: number, y: number): number => {
        const p = project([x, y, 0])
        return Math.hypot(p.x - middle.x, p.y - middle.y)
    }
    const inner = Math.max(
        reach(0, 0),
        reach(volume.sx, 0),
        reach(0, volume.sy),
        reach(volume.sx, volume.sy)
    )
    const outer = Math.max(reach(x0, y0), reach(x1, y0), reach(x0, y1), reach(x1, y1))

    const box = filledBounds(volume)
    const silhouette = box ? hull(boxCorners(box.min, box.max).map(project)) : []

    return {fine, ground, middle, inner, outer, silhouette, step, coarse}
}

/** The three axes, and for each the two it spreads over. Typed so indexing a cell stays a number. */
type Axis3 = 0 | 1 | 2
const AXES3: readonly Axis3[] = [0, 1, 2]
const PERP: Record<Axis3, readonly [Axis3, Axis3]> = {
    0: [1, 2],
    1: [0, 2],
    2: [0, 1]
}

/**
 * Which four-bit neighbourhoods around an edge do *not* get a wireframe line.
 *
 * Empty and full are obvious. The four two-bit entries are the ones worth naming: two cells sitting
 * *side by side* mean the surface runs straight through, so the faces meeting at the edge are
 * coplanar and drawing a line there would rule a lattice across a flat slab. Two cells meeting only
 * at the corner is the opposite case — a genuine pinch — and it stays, as do one and three.
 */
const FLAT: ReadonlySet<number> = new Set([0b0000, 0b1111, 0b0011, 0b1100, 0b0101, 0b1010])

/** The three meshes the ghost is drawn from. */
export interface GhostMesh {
    /** The outside of the block, and only the half of it facing the viewer. */
    readonly skin: readonly Quad[]
    /** The edges that survive the flat-run filter. */
    readonly wire: readonly Segment[]
    /** The footprint on the floor, and the four lines down to it. Empty when the block is grounded. */
    readonly shadow: readonly Point[]
    readonly legs: readonly Segment[]
}

/**
 * The block a press would make, as geometry.
 *
 * Three separate meshes rather than one, because each answers a different question and `app.css`
 * paints them differently:
 *
 * - **The skin** is face-culled twice over — a face with a neighbour is interior, and a face whose
 *   normal points away from the camera is the far side of a block whose near side already covers
 *   it.
 * - **The wire** is every lattice edge the footprint touches, minus the ones running through a flat
 *   run. Without that filter a slab is ruled into a grid of squares.
 * - **The shadow** exists because an orthographic camera gives away nothing about height: a block
 *   one voxel up and a block ten up are the same picture moved a few pixels.
 */
export const ghostMesh = (cells: readonly Cell[], camera: Camera, volume: Volume): GhostMesh => {
    const {forward} = basisFor(camera, volume, 1)
    const project = projector(camera, volume)

    const key = (x: number, y: number, z: number): string =>
        `${String(x)},${String(y)},${String(z)}`
    const filled = new Set(cells.map(([x, y, z]) => key(x, y, z)))

    const skin: Quad[] = []
    for (const cell of cells) {
        const [x, y, z] = cell
        for (const axis of AXES3) {
            for (const side of [0, 1]) {
                const step = side === 0 ? -1 : 1
                const at: [number, number, number] = [x, y, z]
                at[axis] += step
                if (filled.has(key(at[0], at[1], at[2]))) continue
                const normal: [number, number, number] = [0, 0, 0]
                normal[axis] = step
                if (dot(normal, forward) >= 0) continue
                const [u, v] = PERP[axis]
                const corner = (a: number, b: number): Vec3 => {
                    const point: [number, number, number] = [x, y, z]
                    point[axis] = cell[axis] + side
                    point[u] = cell[u] + a
                    point[v] = cell[v] + b
                    return point
                }
                skin.push([
                    project(corner(0, 0)),
                    project(corner(1, 0)),
                    project(corner(1, 1)),
                    project(corner(0, 1))
                ])
            }
        }
    }

    /*
     * Every edge the footprint could have, keyed by where it runs. `along` is the axis it points
     * down; `a` and `b` are its position on the other two, in lattice coordinates — so the four
     * cells that meet along it are the four combinations of one step back on each.
     */
    const wire: Segment[] = []
    const seen = new Set<string>()
    for (const cell of cells) {
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
                            if (filled.has(key(at[0], at[1], at[2]))) around |= bit
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
                    wire.push({a: project(end(0)), b: project(end(1))})
                }
            }
        }
    }

    let x0 = Infinity
    let y0 = Infinity
    let z0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [x, y, z] of cells) {
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (z < z0) z0 = z
        if (x > x1) x1 = x
        if (y > y1) y1 = y
    }
    const shadow: Point[] = []
    const legs: Segment[] = []
    if (cells.length > 0 && z0 > 0) {
        const feet: [number, number][] = [
            [x0, y0],
            [x1 + 1, y0],
            [x1 + 1, y1 + 1],
            [x0, y1 + 1]
        ]
        for (const [x, y] of feet) {
            shadow.push(project([x, y, 0]))
            legs.push({a: project([x, y, z0]), b: project([x, y, 0])})
        }
    }

    return {skin, wire, shadow, legs}
}
