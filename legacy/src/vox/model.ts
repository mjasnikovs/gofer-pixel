import type {Rgba} from './palette'

/**
 * A parsed .vox model.
 *
 * `voxels` is sparse and keyed by a packed coordinate, and colour indices are 1-based into
 * `palette` — both are the file format's own conventions, kept rather than normalised so the
 * renderers stay a line-for-line match with the Python they came from.
 *
 * Insertion order is meaningful: the renderers paint in it, so later voxels cover earlier ones.
 */
export interface VoxModel {
    sx: number
    sy: number
    sz: number
    voxels: Map<number, number>
    palette: readonly Rgba[]
}

/**
 * Pack into a fixed 256³ key space rather than one sized to the model. Neighbour lookups walk one
 * step off the edge, and a stride derived from the model's own size would alias those back onto
 * real voxels on the far side.
 */
export const packKey = (x: number, y: number, z: number): number => (x * 256 + y) * 256 + z

const inKeySpace = (v: number): boolean => v >= 0 && v < 256

export const hasVoxel = ({voxels}: VoxModel, x: number, y: number, z: number): boolean =>
    inKeySpace(x) && inKeySpace(y) && inKeySpace(z) && voxels.has(packKey(x, y, z))

/** Group voxel entries by z, preserving insertion order inside each layer. */
export const layersByZ = ({voxels, sz}: VoxModel): [number, number][][] => {
    const layers: [number, number][][] = Array.from({length: sz}, () => [])
    for (const [key, color] of voxels) {
        const z = key % 256
        layers[z]?.push([key, color])
    }
    return layers
}

export const unpackKey = (key: number): [number, number, number] => [
    Math.floor(key / 65536),
    Math.floor(key / 256) % 256,
    key % 256
]

/**
 * MagicaVoxel's built-in palette, generated procedurally. Used when a file carries no RGBA chunk.
 */
export const DEFAULT_PALETTE: readonly Rgba[] = [
    {r: 255, g: 255, b: 255, a: 255},
    ...Array.from({length: 255}, (_unused, i) => ({
        r: ((i >> 0) & 7) * 36 + 3,
        g: ((i >> 3) & 7) * 36 + 3,
        b: ((i >> 6) & 3) * 85,
        a: 255
    }))
]
