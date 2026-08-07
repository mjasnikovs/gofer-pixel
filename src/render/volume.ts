/**
 * A dense voxel grid plus the palette its cells index into.
 *
 * Dense rather than sparse because the raycaster reads one cell per DDA step and the GPU reads the
 * same grid as an `R8UI` 3D texture — a sparse map would have to be flattened for the upload
 * anyway, and both backends must read the identical bytes for the two renders to agree.
 *
 * `0` is empty. Every other value is a 1-based index into `palette`, which is the `.vox` format's
 * own convention, kept rather than normalised.
 */
export interface Volume {
    readonly sx: number
    readonly sy: number
    readonly sz: number
    /** `sx * sy * sz` cells, x fastest, then y, then z. */
    readonly data: Uint8Array
    /** 256 RGBA entries. Entry 0 is never read. */
    readonly palette: Uint8Array
}

export const createVolume = (sx: number, sy: number, sz: number, palette?: Uint8Array): Volume => ({
    sx,
    sy,
    sz,
    data: new Uint8Array(sx * sy * sz),
    palette: palette ?? new Uint8Array(256 * 4)
})

export const voxelIndex = ({sx, sy}: Volume, x: number, y: number, z: number): number =>
    (z * sy + y) * sx + x

export const voxelAt = (volume: Volume, x: number, y: number, z: number): number => {
    const {sx, sy, sz, data} = volume
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return 0
    return data[voxelIndex(volume, x, y, z)] ?? 0
}

export const setVoxel = (volume: Volume, x: number, y: number, z: number, value: number): void => {
    const {sx, sy, sz, data} = volume
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return
    data[voxelIndex(volume, x, y, z)] = value
}

/** The longest straight line through the volume — how far a ray can possibly travel inside it. */
export const volumeDiagonal = ({sx, sy, sz}: Volume): number => Math.hypot(sx, sy, sz)
