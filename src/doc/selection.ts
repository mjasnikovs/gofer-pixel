import type {Basis} from '../render/camera'
import {pickRay} from '../render/pick'
import {voxelAt, voxelIndex, type Volume} from '../render/volume'
import {connected} from './edits'

/**
 * What is selected, as a set of flat cell indices.
 *
 * A set rather than a box, because `FEATURESET.md` §31 asks for connected regions and colour
 * selections, and neither of those is a box. Indices rather than triples so that membership is one
 * hash lookup — a transform reads it once per selected cell and the highlight reads it once per
 * cell on screen.
 *
 * A selection never contains an empty cell. Every gesture below filters to occupied voxels, which
 * is what makes "move the selection" mean something and keeps a stray rubber-band over air from
 * selecting a thousand nothings.
 */
export type Selection = ReadonlySet<number>

export const EMPTY_SELECTION: Selection = new Set<number>()

export type Cell = readonly [number, number, number]

export const cellOf = ({sx, sy}: Volume, index: number): Cell => {
    const z = Math.floor(index / (sx * sy))
    const rest = index - z * sx * sy
    return [rest % sx, Math.floor(rest / sx), z]
}

/** Click: one voxel. */
export const selectVoxel = (volume: Volume, x: number, y: number, z: number): Selection => {
    if (voxelAt(volume, x, y, z) === 0) return EMPTY_SELECTION
    return new Set([voxelIndex(volume, x, y, z)])
}

/** Double-click: the connected run of one colour. */
export const selectConnectedColor = (volume: Volume, x: number, y: number, z: number): Selection =>
    voxelAt(volume, x, y, z) === 0 ? EMPTY_SELECTION : connected(volume, x, y, z)

/**
 * Modifier-click: the whole connected solid, whatever colours it is made of.
 *
 * This is what "whole object" means in a document that is still one grid. When objects become a
 * list (`FEATURESET.md` §8) the gesture keeps its meaning and gets a cheaper implementation.
 */
export const selectObject = (volume: Volume, x: number, y: number, z: number): Selection =>
    voxelAt(volume, x, y, z) === 0 ? EMPTY_SELECTION : (
        connected(volume, x, y, z, value => value !== 0)
    )

/** Every voxel of one palette index, anywhere in the grid. */
export const selectColor = (volume: Volume, color: number): Selection => {
    const found = new Set<number>()
    if (color === 0) return found
    const {data} = volume
    for (let i = 0; i < data.length; i += 1) if (data[i] === color) found.add(i)
    return found
}

/** Every occupied cell of an integer box, ends included. */
export const selectBox = (volume: Volume, a: Cell, b: Cell): Selection => {
    const found = new Set<number>()
    const lo = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])]
    const hi = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])]
    for (let z = lo[2] ?? 0; z <= (hi[2] ?? 0); z += 1) {
        for (let y = lo[1] ?? 0; y <= (hi[1] ?? 0); y += 1) {
            for (let x = lo[0] ?? 0; x <= (hi[0] ?? 0); x += 1) {
                if (voxelAt(volume, x, y, z) !== 0) found.add(voxelIndex(volume, x, y, z))
            }
        }
    }
    return found
}

/**
 * Box select, as a rectangle dragged over the picture.
 *
 * One ray per pixel inside the rectangle, so what gets selected is what the artist can see —
 * surfaces, not the insides of the model. That is the honest reading of a rectangle drawn on a
 * picture, and `grow` is there for when they meant the solid behind it.
 *
 * Rays, not projected voxel centres: a projection would happily select the far side of the model
 * through its own front, and the artist has no way to tell that happened until something moves.
 */
export const selectRect = (
    volume: Volume,
    basis: Basis,
    rect: {x0: number; y0: number; x1: number; y1: number},
    width: number,
    height: number
): Selection => {
    const found = new Set<number>()
    const left = Math.max(0, Math.floor(Math.min(rect.x0, rect.x1)))
    const right = Math.min(width - 1, Math.ceil(Math.max(rect.x0, rect.x1)))
    const top = Math.max(0, Math.floor(Math.min(rect.y0, rect.y1)))
    const bottom = Math.min(height - 1, Math.ceil(Math.max(rect.y0, rect.y1)))
    for (let row = top; row <= bottom; row += 1) {
        for (let column = left; column <= right; column += 1) {
            const hit = pickRay(volume, basis, column, row, width, height)
            if (hit) found.add(voxelIndex(volume, hit.x, hit.y, hit.z))
        }
    }
    return found
}

const NEIGHBOURS: readonly Cell[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1]
]

/** Grow by one voxel in every direction, into occupied cells only. */
export const grow = (volume: Volume, selection: Selection): Selection => {
    const found = new Set(selection)
    for (const index of selection) {
        const [x, y, z] = cellOf(volume, index)
        for (const [dx, dy, dz] of NEIGHBOURS) {
            if (voxelAt(volume, x + dx, y + dy, z + dz) === 0) continue
            found.add(voxelIndex(volume, x + dx, y + dy, z + dz))
        }
    }
    return found
}

/**
 * Shrink by one voxel: drop anything on the edge of the selection.
 *
 * A cell on the boundary of the *grid* counts as inside. Otherwise shrinking a selection that
 * reaches the wall would eat a layer the artist can see is not an edge of anything.
 */
export const shrink = (volume: Volume, selection: Selection): Selection => {
    const found = new Set<number>()
    const {sx, sy, sz} = volume
    for (const index of selection) {
        const [x, y, z] = cellOf(volume, index)
        let inside = true
        for (const [dx, dy, dz] of NEIGHBOURS) {
            const nx = x + dx
            const ny = y + dy
            const nz = z + dz
            if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue
            if (!selection.has(voxelIndex(volume, nx, ny, nz))) inside = false
        }
        if (inside) found.add(index)
    }
    return found
}

/** The integer box a selection occupies, or `undefined` when nothing is selected. */
export const selectionBounds = (
    volume: Volume,
    selection: Selection
): {min: Cell; max: Cell} | undefined => {
    if (selection.size === 0) return undefined
    let [x0, y0, z0] = [Infinity, Infinity, Infinity]
    let [x1, y1, z1] = [-Infinity, -Infinity, -Infinity]
    for (const index of selection) {
        const [x, y, z] = cellOf(volume, index)
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        z0 = Math.min(z0, z)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
        z1 = Math.max(z1, z)
    }
    return {min: [x0, y0, z0], max: [x1, y1, z1]}
}
