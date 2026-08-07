import type {Volume} from '../render/volume'
import type {Cell} from './selection'

/**
 * Draw-time symmetry: `FEATURESET.md` §10.
 *
 * A draw-time mirror, not a live modifier. Every stroke writes its mirror images as real voxels at
 * the moment it is drawn, so the model is the model and undo undoes what the artist saw happen.
 * The alternative — a mirror that keeps applying itself — is the modifier stack §23 postpones, and
 * it starts the argument about whether a tool is editing the source or the result.
 *
 * The planes are the middle of the grid, so `x` mirrors `x` to `sx - 1 - x`. A character is centred
 * in its grid; a selection is not, which is why this is not the selection's box.
 */
export interface Symmetry {
    readonly x: boolean
    readonly y: boolean
    readonly z: boolean
    /**
     * Four-fold about the vertical axis. Offered only when the grid is square in x and y — a
     * quarter turn of a non-square box lands outside it, and `FEATURESET.md` §10 asks for radial
     * symmetry exactly "where mathematically voxel-safe".
     */
    readonly radial: boolean
}

export const NO_SYMMETRY: Symmetry = {x: false, y: false, z: false, radial: false}

export const canRadial = ({sx, sy}: Volume): boolean => sx === sy

export const isSymmetric = ({x, y, z, radial}: Symmetry): boolean => x || y || z || radial

/** A cell to the cell its image is at. The list always starts with the identity. */
export type Reflect = (cell: Cell) => Cell

const identity: Reflect = cell => cell

const across = (axis: number, size: number): Reflect => {
    return cell => {
        const image: [number, number, number] = [cell[0], cell[1], cell[2]]
        image[axis] = size - 1 - (cell[axis] ?? 0)
        return image
    }
}

/** A quarter turn about the vertical axis of a square grid, anchored at the grid's own corner. */
const turn =
    (size: number): Reflect =>
    cell => [size - 1 - cell[1], cell[0], cell[2]]

const compose =
    (a: Reflect, b: Reflect): Reflect =>
    cell =>
        a(b(cell))

/**
 * Every image one write should also land on, as maps rather than cells.
 *
 * Maps, because a *drag* has to mirror its two endpoints and draw a line between each mirrored
 * pair — mirroring the cells of an already-walked line would work too, but it would walk the line
 * once per image and the line is the expensive part.
 */
export const symmetryMaps = (volume: Volume, symmetry: Symmetry): readonly Reflect[] => {
    let maps: Reflect[] = [identity]
    const add = (map: Reflect): void => {
        maps = [...maps, ...maps.map(existing => compose(map, existing))]
    }
    if (symmetry.x) add(across(0, volume.sx))
    if (symmetry.y) add(across(1, volume.sy))
    if (symmetry.z) add(across(2, volume.sz))
    if (symmetry.radial && canRadial(volume)) {
        const rotate = turn(volume.sx)
        const spun = [rotate, compose(rotate, rotate), compose(rotate, compose(rotate, rotate))]
        maps = [...maps, ...spun.flatMap(spin => maps.map(existing => compose(spin, existing)))]
    }
    return maps
}

/** The distinct cells one write lands on. Deduplicated: a cell on a mirror plane is its own image. */
export const symmetricCells = (volume: Volume, symmetry: Symmetry, cell: Cell): readonly Cell[] => {
    const seen = new Set<string>()
    const cells: Cell[] = []
    for (const map of symmetryMaps(volume, symmetry)) {
        const image = map(cell)
        const key = `${String(image[0])},${String(image[1])},${String(image[2])}`
        if (seen.has(key)) continue
        seen.add(key)
        cells.push(image)
    }
    return cells
}
