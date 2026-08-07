import {voxelAt, voxelIndex, type Volume} from '../render/volume'
import type {Axis} from './brush'
import {writeVoxel, type Draft} from './edits'
import {cellOf, EMPTY_SELECTION, selectionBounds, type Cell, type Selection} from './selection'

/**
 * Voxel-safe transforms: `FEATURESET.md` §9.
 *
 * Every one of these is index arithmetic on a bounding box. Nothing multiplies a coordinate by a
 * sine, nothing rounds, and there is therefore no operation here that can produce a half-voxel or
 * lose one to a tie — which is the whole of §9 and half of the project's first principle.
 *
 * A rotation turns the selection's box in place, anchored at its minimum corner, rather than about
 * a centre. A box with an even span has its centre on a half-voxel, and rotating about a
 * half-voxel in one axis and a whole voxel in another lands every cell on a half. Anchoring is the
 * same picture and it is exact.
 *
 * All of them write through a `Draft`, so a transform is one undo step like any other stroke, and
 * all of them read the whole selection out first: a move that wrote as it went would overwrite the
 * cells it had not read yet whenever source and destination overlap.
 */
export type {Axis}

const snapshot = (draft: Draft, selection: Selection): Map<number, number> => {
    const values = new Map<number, number>()
    for (const index of selection) values.set(index, draft.volume.data[index] ?? 0)
    return values
}

const clear = (draft: Draft, selection: Selection): void => {
    for (const index of selection) {
        const [x, y, z] = cellOf(draft.volume, index)
        writeVoxel(draft, x, y, z, 0)
    }
}

const put = (draft: Draft, cells: Iterable<{cell: Cell; value: number}>): Selection => {
    const landed = new Set<number>()
    const {sx, sy, sz} = draft.volume
    for (const {cell, value} of cells) {
        const [x, y, z] = cell
        if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) continue
        writeVoxel(draft, x, y, z, value)
        landed.add(voxelIndex(draft.volume, x, y, z))
    }
    return landed
}

/**
 * Move by whole voxels. Cells pushed off the edge of the grid are dropped, not wrapped and not
 * clamped into a pile against the wall.
 */
export const moveCells = (draft: Draft, selection: Selection, delta: Cell): Selection => {
    if (selection.size === 0) return selection
    const values = snapshot(draft, selection)
    clear(draft, selection)
    return put(
        draft,
        [...values].map(([index, value]) => {
            const [x, y, z] = cellOf(draft.volume, index)
            return {cell: [x + delta[0], y + delta[1], z + delta[2]] as Cell, value}
        })
    )
}

/** One quarter turn of a box about `axis`, anchored at the box's minimum corner. */
const quarter = (cell: Cell, axis: Axis, box: {min: Cell; max: Cell}): Cell => {
    const u = axis === 0 ? 1 : 0
    const v = axis === 2 ? 1 : 2
    const turned: [number, number, number] = [cell[0], cell[1], cell[2]]
    turned[u] = box.min[u] + (box.max[v] - cell[v])
    turned[v] = box.min[v] + (cell[u] - box.min[u])
    return turned
}

/** Rotate 90° about an axis, any number of quarter turns. */
export const rotateCells = (
    draft: Draft,
    selection: Selection,
    axis: Axis,
    quarters = 1
): Selection => {
    const turns = ((quarters % 4) + 4) % 4
    if (selection.size === 0 || turns === 0) return selection
    const values = snapshot(draft, selection)
    let placed = [...values].map(([index, value]) => ({
        cell: cellOf(draft.volume, index),
        value
    }))
    for (let turn = 0; turn < turns; turn += 1) {
        const box = boundsOf(placed.map(({cell}) => cell))
        if (!box) break
        placed = placed.map(({cell, value}) => ({cell: quarter(cell, axis, box), value}))
    }
    clear(draft, selection)
    return put(draft, placed)
}

/** Flip inside the selection's own box: the model turns over, it does not move. */
export const flipCells = (draft: Draft, selection: Selection, axis: Axis): Selection => {
    if (selection.size === 0) return selection
    const box = selectionBounds(draft.volume, selection)
    if (!box) return selection
    const values = snapshot(draft, selection)
    const flipped = [...values].map(([index, value]) => {
        const cell = cellOf(draft.volume, index)
        const mirrored: [number, number, number] = [cell[0], cell[1], cell[2]]
        mirrored[axis] = box.min[axis] + box.max[axis] - cell[axis]
        return {cell: mirrored, value}
    })
    clear(draft, selection)
    return put(draft, flipped)
}

/**
 * Mirror across the middle of the *grid*, keeping the original.
 *
 * Across the grid rather than across the selection's own box, because mirroring is how the second
 * arm of a character gets made and the character is centred in its grid, not in the selection.
 * Flip is the one that works inside the box.
 */
export const mirrorCells = (draft: Draft, selection: Selection, axis: Axis): Selection => {
    if (selection.size === 0) return selection
    const size = [draft.volume.sx, draft.volume.sy, draft.volume.sz][axis] ?? 0
    const values = snapshot(draft, selection)
    const copy = put(
        draft,
        [...values].map(([index, value]) => {
            const cell = cellOf(draft.volume, index)
            const mirrored: [number, number, number] = [cell[0], cell[1], cell[2]]
            mirrored[axis] = size - 1 - cell[axis]
            return {cell: mirrored, value}
        })
    )
    return new Set([...selection, ...copy])
}

/**
 * Copy the selection somewhere else and select the copy, so a duplicate can be nudged into place
 * without picking it up again.
 */
export const duplicateCells = (draft: Draft, selection: Selection, delta: Cell): Selection => {
    if (selection.size === 0) return selection
    const values = snapshot(draft, selection)
    return put(
        draft,
        [...values].map(([index, value]) => {
            const [x, y, z] = cellOf(draft.volume, index)
            return {cell: [x + delta[0], y + delta[1], z + delta[2]] as Cell, value}
        })
    )
}

/** `count` further copies, each one `delta` further along. The original stays selected with them. */
export const arrayCells = (
    draft: Draft,
    selection: Selection,
    delta: Cell,
    count: number
): Selection => {
    if (selection.size === 0 || count < 1) return selection
    const values = snapshot(draft, selection)
    let all = new Set(selection)
    for (let step = 1; step <= count; step += 1) {
        const copy = put(
            draft,
            [...values].map(([index, value]) => {
                const [x, y, z] = cellOf(draft.volume, index)
                return {
                    cell: [x + delta[0] * step, y + delta[1] * step, z + delta[2] * step] as Cell,
                    value
                }
            })
        )
        all = new Set([...all, ...copy])
    }
    return all
}

/**
 * Pull a surface patch out along its own normal, or push it back in.
 *
 * Out copies the patch `layers` times, each copy carrying the colour of the cell it grew from, so
 * a two-colour surface extrudes as two-coloured columns rather than as one flat slab. In erases
 * the outermost `layers` of it, which is the same gesture run backwards and the reason it is one
 * function: the artist drags one way and then the other without letting go.
 *
 * The returned selection is the new face — what the next drag of the same gesture will pull.
 */
export const extrudeCells = (
    draft: Draft,
    patch: Selection,
    step: Cell,
    layers: number
): Selection => {
    if (patch.size === 0 || layers === 0) return patch
    const values = snapshot(draft, patch)
    const out = layers > 0
    const depth = Math.abs(layers)
    let face: Selection = patch

    for (let i = 1; i <= depth; i += 1) {
        const at = out ? i : -(i - 1)
        const cells = [...values].map(([index, value]) => {
            const [x, y, z] = cellOf(draft.volume, index)
            return {
                cell: [x + step[0] * at, y + step[1] * at, z + step[2] * at] as Cell,
                value: out ? value : 0
            }
        })
        face = put(draft, cells)
    }
    if (out) return face

    // Pushing in leaves the cell *behind* the last one erased as the new surface.
    const behind = [...values].map(([index]) => {
        const [x, y, z] = cellOf(draft.volume, index)
        return voxelIndex(
            draft.volume,
            x - step[0] * depth,
            y - step[1] * depth,
            z - step[2] * depth
        )
    })
    return new Set(behind.filter(index => (draft.volume.data[index] ?? 0) !== 0))
}

/** Put a copied block down with its corner at `at`, and select what landed. */
export const pasteCells = (
    draft: Draft,
    cells: readonly {offset: Cell; value: number}[],
    at: Cell
): Selection =>
    put(
        draft,
        cells.map(({offset, value}) => ({
            cell: [at[0] + offset[0], at[1] + offset[1], at[2] + offset[2]] as Cell,
            value
        }))
    )

export const deleteCells = (draft: Draft, selection: Selection): Selection => {
    clear(draft, selection)
    return EMPTY_SELECTION
}

/** Recolour without moving anything — what a palette swap does to a selection. */
export const paintCells = (draft: Draft, selection: Selection, color: number): Selection => {
    for (const index of selection) {
        const [x, y, z] = cellOf(draft.volume, index)
        if (voxelAt(draft.volume, x, y, z) === 0) continue
        writeVoxel(draft, x, y, z, color)
    }
    return selection
}

const boundsOf = (cells: readonly Cell[]): {min: Cell; max: Cell} | undefined => {
    if (cells.length === 0) return undefined
    const min: [number, number, number] = [Infinity, Infinity, Infinity]
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    for (const cell of cells) {
        for (let i = 0; i < 3; i += 1) {
            min[i] = Math.min(min[i] ?? 0, cell[i] ?? 0)
            max[i] = Math.max(max[i] ?? 0, cell[i] ?? 0)
        }
    }
    return {min, max}
}

/** How far a selection can be nudged before it starts falling off the grid. */
export const fitsAfter = (volume: Volume, selection: Selection, delta: Cell): boolean => {
    const box = selectionBounds(volume, selection)
    if (!box) return false
    const size = [volume.sx, volume.sy, volume.sz]
    for (let i = 0; i < 3; i += 1) {
        if ((box.min[i] ?? 0) + (delta[i] ?? 0) < 0) return false
        if ((box.max[i] ?? 0) + (delta[i] ?? 0) >= (size[i] ?? 0)) return false
    }
    return true
}
