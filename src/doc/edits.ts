import {voxelAt, voxelIndex, type Volume} from '../render/volume'
import {brushOffsets, type Brush, type Offset} from './brush'
import type {Objects} from './objects'

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
    /** Which object owned each cell before and after. Moves carry ownership with the voxels. */
    readonly ownerFrom: Uint8Array
    readonly ownerTo: Uint8Array
    /**
     * The object list either side of this edit, when the edit changed it — delete and duplicate.
     *
     * It lives here because `owner` already does. Restoring the cells of a deleted object without
     * restoring the object itself leaves voxels owned by an id no row can name: invisible to hide,
     * to lock and to solo, and quietly adopted by the next object to be added, because ids are
     * reused. That was the state undo actually left the document in, measured in a browser.
     *
     * The whole list rather than a diff. It is a handful of names and flags, the two operations
     * that carry one are rare, and a diff of a list is a second thing that can be wrong.
     */
    readonly objects?: {readonly from: Objects; readonly to: Objects}
}

export interface Draft {
    /** The volume as it now stands. Shares nothing with the volume the draft was opened on. */
    readonly volume: Volume
    /** Which object a *new* voxel joins. A transform overrides it per cell; see `writeOwned`. */
    readonly object: number
    /**
     * Objects whose cells this draft may not touch — `FEATURESET.md` §28's lock, enforced at the
     * one place that writes rather than at each of the dozen tools that ask for a write.
     */
    readonly locked: ReadonlySet<number>
    /** Cell index → the value it held before this stroke touched it. */
    readonly before: Map<number, number>
    /** The same, for ownership. */
    readonly beforeOwner: Map<number, number>
}

export const NOTHING_LOCKED: ReadonlySet<number> = new Set<number>()

export const beginEdit = (volume: Volume, object = 1, locked = NOTHING_LOCKED): Draft => ({
    volume: {
        ...volume,
        data: new Uint8Array(volume.data),
        owner: new Uint8Array(volume.owner)
    },
    object,
    locked,
    before: new Map(),
    beforeOwner: new Map()
})

/**
 * `0` erases. Out-of-bounds writes are dropped, so a brush may hang off the edge of the grid, and a
 * cell belonging to a locked object is dropped too.
 */
export const writeVoxel = (draft: Draft, x: number, y: number, z: number, value: number): void => {
    writeOwned(draft, x, y, z, value, value === 0 ? 0 : draft.object)
}

/**
 * Why a write is about to do nothing.
 *
 * One boolean used to carry all of these, and one boolean is what made a locked object read as a
 * broken tool: the ghost went dashed for "locked", for "already that colour" and for "off the edge
 * of the grid" alike, so the one case the artist can actually fix looked like the two they cannot.
 *
 * - **`locked`** — a locked object owns the cell. `object` names it, so the message can too.
 * - **`outside`** — the cell is off the grid.
 * - **`nothing`** — the cell already holds exactly what the write would put there. For Erase that is
 *   empty space; for Draw and Fill it is the loaded colour; for a grab it is nothing to take hold of.
 *
 * It lives here rather than in `doc/gesture.ts` because this is the module that does the dropping,
 * and the outline may not have a second opinion about it — see `writeBlock`.
 */
export interface Blocked {
    readonly reason: 'locked' | 'outside' | 'nothing'
    /** The locked object standing in the way, when that is the reason. */
    readonly object: number | undefined
}

/** The two reasons that name nothing. Shared rather than rebuilt, so a hover allocates less. */
const NOTHING: Blocked = {reason: 'nothing', object: undefined}
const OUTSIDE: Blocked = {reason: 'outside', object: undefined}

/**
 * Why writing `value` here would be dropped, or `undefined` when it would land.
 *
 * The one statement of the three rules — out of bounds, owned by a locked object, or already
 * exactly what is being written. `writeOwned` asks it before writing and the outline asks it
 * without writing, so **the outline cannot disagree with the edit**: they are not two predictions
 * that have to be kept in step, they are one predicate with two callers.
 *
 * It used to be written twice, line for line, in two files — and they agreed only by coincidence of
 * what `openDraft` happened to pass, because one read the draft's object and the other the active
 * one. A tool whose click does nothing is not a bug on its own; a tool that gives no sign of it
 * beforehand is, and an outline that gives the *wrong* sign is worse than both.
 *
 * Over a `Volume` and not a `Draft`, because the outline has no draft: opening one copies the whole
 * grid, which is a megabyte a pointer-move for an answer nothing writes.
 */
export const writeBlock = (
    volume: Volume,
    locked: ReadonlySet<number>,
    x: number,
    y: number,
    z: number,
    value: number,
    object: number
): Blocked | undefined => {
    const {sx, sy, sz, data, owner} = volume
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return OUTSIDE
    const index = voxelIndex(volume, x, y, z)
    const wasOwner = owner[index] ?? 0
    if (locked.has(wasOwner)) return {reason: 'locked', object: wasOwner}
    const nowOwner = value === 0 ? 0 : object
    if ((data[index] ?? 0) === value && wasOwner === nowOwner) return NOTHING
    return undefined
}

/** A write that names the object the cell joins, for transforms that carry ownership with them. */
export const writeOwned = (
    draft: Draft,
    x: number,
    y: number,
    z: number,
    value: number,
    object: number
): void => {
    const {volume, before, beforeOwner, locked} = draft
    if (writeBlock(volume, locked, x, y, z, value, object)) return
    const {data, owner} = volume
    const index = voxelIndex(volume, x, y, z)
    // Only the *first* value seen is kept: a stroke that crosses itself must undo to where it
    // started, not to the middle of itself.
    if (!before.has(index)) {
        before.set(index, data[index] ?? 0)
        beforeOwner.set(index, owner[index] ?? 0)
    }
    data[index] = value
    owner[index] = value === 0 ? 0 : object
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

/*
 * There is deliberately no `stampBrush(draft, brush, …)` here, and there was until it was found to
 * be a second, wrong spelling of the stroke. Nothing in the app could call it: a stroke has to
 * interpose symmetry between the cells and the write — `writeCells(draft, mirrored(state, cells))`
 * — and a helper that goes straight from a brush to a write has nowhere to put the mirror. It had
 * no production caller and four tests, so what the tests covered was a path that would have left a
 * one-voxel seam down the middle of every symmetric model. `strokeCells` and `writeCells` are the
 * two halves, and the gap between them is where symmetry goes.
 */

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

/**
 * An edit that touches no cell.
 *
 * Deleting an *empty* object is a change to the list and to nothing else, so `commitEdit` has
 * nothing to hand back — and without this the delete would go unrecorded and Ctrl-Z would step
 * over it to whatever the artist did before. Stamp `objects` onto a copy of this instead.
 */
export const NO_CELLS: Edit = {
    at: new Int32Array(0),
    from: new Uint8Array(0),
    to: new Uint8Array(0),
    ownerFrom: new Uint8Array(0),
    ownerTo: new Uint8Array(0)
}

/** `undefined` when the stroke changed nothing, which is what keeps a stray click out of undo. */
export const commitEdit = (draft: Draft): Edit | undefined => {
    const {volume, before, beforeOwner} = draft
    const at: number[] = []
    const from: number[] = []
    const to: number[] = []
    const ownerFrom: number[] = []
    const ownerTo: number[] = []
    for (const [index, was] of before) {
        const now = volume.data[index] ?? 0
        const ownedNow = volume.owner[index] ?? 0
        const ownedWas = beforeOwner.get(index) ?? 0
        if (now === was && ownedNow === ownedWas) continue
        at.push(index)
        from.push(was)
        to.push(now)
        ownerFrom.push(ownedWas)
        ownerTo.push(ownedNow)
    }
    if (at.length === 0) return undefined
    return {
        at: Int32Array.from(at),
        from: Uint8Array.from(from),
        to: Uint8Array.from(to),
        ownerFrom: Uint8Array.from(ownerFrom),
        ownerTo: Uint8Array.from(ownerTo)
    }
}

const replay = (volume: Volume, edit: Edit, values: Uint8Array, owners: Uint8Array): Volume => {
    const data = new Uint8Array(volume.data)
    const owner = new Uint8Array(volume.owner)
    for (let i = 0; i < edit.at.length; i += 1) {
        const index = edit.at[i] ?? 0
        data[index] = values[i] ?? 0
        owner[index] = owners[i] ?? 0
    }
    return {...volume, data, owner}
}

export const applyEdit = (volume: Volume, edit: Edit): Volume =>
    replay(volume, edit, edit.to, edit.ownerTo)

export const revertEdit = (volume: Volume, edit: Edit): Volume =>
    replay(volume, edit, edit.from, edit.ownerFrom)
