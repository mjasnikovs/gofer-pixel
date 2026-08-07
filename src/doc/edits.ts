import {voxelAt, voxelIndex, type Volume} from '../render/volume'
import {brushOffsets, type Brush, type Offset} from './brush'

/**
 * Writing voxels, as a diff rather than as a new volume.
 *
 * A stroke opens a **draft** — one copy of the grid, mutated in place while the pointer is down —
 * and closes into an **edit**, which is only the cells that changed and what they used to be. That
 * is what makes "long undo history" (`FEATURESET.md` §32) affordable: a thousand strokes on a 128³
 * model is a thousand small diffs, not two gigabytes of grids.
 *
 * The copy happens once per stroke, at `beginEdit`. Nothing outside the draft ever sees the working
 * grid change under it, so a memoised thumbnail of the volume the stroke started from stays true.
 */
export interface Edit {
    /** Flat cell indices, as `voxelIndex` computes them. */
    readonly at: Int32Array
    readonly from: Uint8Array
    readonly to: Uint8Array
}

export interface Draft {
    /** The volume as it now stands. Shares nothing with the volume the draft was opened on. */
    readonly volume: Volume
    /** Cell index → the value it held before this stroke touched it. */
    readonly before: Map<number, number>
}

export const beginEdit = (volume: Volume): Draft => ({
    volume: {...volume, data: new Uint8Array(volume.data)},
    before: new Map()
})

/** `0` erases. Out-of-bounds writes are dropped, so a brush may hang off the edge of the grid. */
export const writeVoxel = (draft: Draft, x: number, y: number, z: number, value: number): void => {
    const {volume, before} = draft
    const {sx, sy, sz, data} = volume
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return
    const index = voxelIndex(volume, x, y, z)
    const was = data[index] ?? 0
    if (was === value) return
    // Only the *first* value seen is kept: a stroke that crosses itself must undo to where it
    // started, not to the middle of itself.
    if (!before.has(index)) before.set(index, was)
    data[index] = value
}

/**
 * Every cell a drag of the brush covers — the footprint, at every step of the line between the two
 * pointer samples.
 *
 * Cells rather than writes, because symmetry mirrors *cells*. Mirroring the centre of the stamp
 * instead would be wrong for any brush that is not its own mirror image, and an even-sized brush
 * never is: a size-2 square grows towards `+`, so its reflection sits one voxel over from where
 * the reflected centre puts it. That is a one-voxel seam down the middle of every symmetric model,
 * which is exactly the class of defect this project keeps finding.
 *
 * The line matters for the same reason the footprint does. Pointer moves arrive at whatever rate
 * the mouse reports, so two consecutive samples can be twenty voxels apart, and drawing only the
 * endpoints leaves a dotted line — the oldest bug in pixel art.
 */
export const strokeCells = (
    brush: Brush,
    face: number,
    from: Offset,
    to: Offset,
    into: Offset[] = []
): readonly Offset[] => {
    const offsets = brushOffsets(brush, face)
    const [x0, y0, z0] = from
    const [x1, y1, z1] = to
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0))
    for (let i = 0; i <= steps; i += 1) {
        const t = steps === 0 ? 0 : i / steps
        const cx = Math.round(x0 + (x1 - x0) * t)
        const cy = Math.round(y0 + (y1 - y0) * t)
        const cz = Math.round(z0 + (z1 - z0) * t)
        for (const [dx, dy, dz] of offsets) into.push([cx + dx, cy + dy, cz + dz])
    }
    return into
}

export const writeCells = (draft: Draft, cells: Iterable<Offset>, value: number): void => {
    for (const [x, y, z] of cells) writeVoxel(draft, x, y, z, value)
}

/** One click of the brush, oriented by the face the ray struck. */
export const stampBrush = (
    draft: Draft,
    brush: Brush,
    face: number,
    x: number,
    y: number,
    z: number,
    value: number
): void => {
    writeCells(draft, strokeCells(brush, face, [x, y, z], [x, y, z]), value)
}

/** A dragged brush, leaving no gaps. */
export const strokeBrush = (
    draft: Draft,
    brush: Brush,
    face: number,
    from: Offset,
    to: Offset,
    value: number
): void => {
    writeCells(draft, strokeCells(brush, face, from, to), value)
}

/**
 * The cells reachable from a seed through faces, all carrying the value the seed carries.
 *
 * Shared by the fill tool and by "select connected region" (`FEATURESET.md` §31), because they are
 * the same traversal asked two different questions — and a fill that disagrees with the selection
 * it previews would be worse than either.
 *
 * Face-connected, not corner-connected: two voxels touching at an edge are two objects to a voxel
 * artist, and a diagonal leak fills a whole model through a one-voxel gap.
 */
export const connected = (
    volume: Volume,
    x: number,
    y: number,
    z: number,
    /**
     * What counts as "the same". The default is the same palette index, which is what a fill and
     * "select connected colour" both mean; "select the whole object" passes `value !== 0` instead.
     */
    match: (value: number, seed: number) => boolean = (value, seed) => value === seed
): Set<number> => {
    const {sx, sy, sz} = volume
    const seen = new Set<number>()
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return seen
    const target = voxelAt(volume, x, y, z)
    const stack: [number, number, number][] = [[x, y, z]]
    seen.add(voxelIndex(volume, x, y, z))
    while (stack.length > 0) {
        const cell = stack.pop()
        if (!cell) break
        const [cx, cy, cz] = cell
        for (const [dx, dy, dz] of NEIGHBOURS) {
            const nx = cx + dx
            const ny = cy + dy
            const nz = cz + dz
            if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue
            if (!match(voxelAt(volume, nx, ny, nz), target)) continue
            const index = voxelIndex(volume, nx, ny, nz)
            if (seen.has(index)) continue
            seen.add(index)
            stack.push([nx, ny, nz])
        }
    }
    return seen
}

const NEIGHBOURS: readonly (readonly [number, number, number])[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1]
]

/**
 * Recolour a connected region of one colour.
 *
 * Deliberately not "fill the empty space I clicked on": the empty space outside a model is
 * connected to the whole rest of the grid, so that reading of fill turns a 128³ document solid on
 * one misclick. Filling a cavity is the erase tool run backwards over a selection, and selections
 * are bounded.
 */
export const fillRegion = (draft: Draft, x: number, y: number, z: number, value: number): void => {
    const {volume} = draft
    if (voxelAt(volume, x, y, z) === 0) return
    const {sx, sy} = volume
    for (const index of connected(volume, x, y, z)) {
        const cz = Math.floor(index / (sx * sy))
        const rest = index - cz * sx * sy
        writeVoxel(draft, rest % sx, Math.floor(rest / sx), cz, value)
    }
}

/** `undefined` when the stroke changed nothing, which is what keeps a stray click out of undo. */
export const commitEdit = (draft: Draft): Edit | undefined => {
    const {volume, before} = draft
    const at: number[] = []
    const from: number[] = []
    const to: number[] = []
    for (const [index, was] of before) {
        const now = volume.data[index] ?? 0
        if (now === was) continue
        at.push(index)
        from.push(was)
        to.push(now)
    }
    if (at.length === 0) return undefined
    return {at: Int32Array.from(at), from: Uint8Array.from(from), to: Uint8Array.from(to)}
}

const replay = (volume: Volume, edit: Edit, values: Uint8Array): Volume => {
    const data = new Uint8Array(volume.data)
    for (let i = 0; i < edit.at.length; i += 1) data[edit.at[i] ?? 0] = values[i] ?? 0
    return {...volume, data}
}

export const applyEdit = (volume: Volume, edit: Edit): Volume => replay(volume, edit, edit.to)

export const revertEdit = (volume: Volume, edit: Edit): Volume => replay(volume, edit, edit.from)
