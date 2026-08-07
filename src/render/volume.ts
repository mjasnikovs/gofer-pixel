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
    /**
     * How brightly each palette entry glows, `0 … 255`, one byte per entry.
     *
     * The only part of `FEATURESET.md` §20 that survives its own postponement, and it survives
     * because §18 promises an emission map and an emission map needs something to say which voxels
     * are in it. Rough and metallic have no meaning without a lighting model, and this editor
     * deliberately does not have one.
     */
    readonly emissive: Uint8Array
    /**
     * Which object owns each cell, 1-based. `0` is unowned, and an empty cell is always unowned.
     *
     * `FEATURESET.md` §8 asks for objects instead of one giant volume. This is that, as a second
     * grid rather than as a list of grids: an object is a *named set of cells* of the one world
     * grid, so hiding, locking and soloing are lookups, and every tool, transform, selection and
     * symmetry plane already written keeps working in world coordinates. A list of grids at
     * integer offsets would have to be composited for every ray, and the two raycasters have to
     * keep agreeing byte for byte while it happened.
     *
     * It lives on the volume rather than beside it because it is diffed, drafted and undone
     * exactly like `data` is, and two arrays that must move together should not be able to drift.
     */
    readonly owner: Uint8Array
}

export const createVolume = (sx: number, sy: number, sz: number, palette?: Uint8Array): Volume => ({
    sx,
    sy,
    sz,
    data: new Uint8Array(sx * sy * sz),
    palette: palette ?? new Uint8Array(256 * 4),
    emissive: new Uint8Array(256),
    owner: new Uint8Array(sx * sy * sz)
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

/**
 * The box the *voxels* fill, which is rarely the box the grid offers.
 *
 * `undefined` when the grid is empty. Everything that wants to know where the model is — the ground
 * grid deciding what to draw under, a camera framing it — wants this rather than `sx, sy, sz`: a
 * 128³ document holding one voxel has a bounding box the size of the room and a model the size of a
 * die, and treating the two as the same thing is what leaves an artist with no floor to judge
 * height against.
 */
export const filledBounds = (
    volume: Volume
): {min: [number, number, number]; max: [number, number, number]} | undefined => {
    const {sx, sy, data} = volume
    let x0 = Infinity
    let y0 = Infinity
    let z0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    let z1 = -Infinity
    for (let i = 0; i < data.length; i += 1) {
        if ((data[i] ?? 0) === 0) continue
        const z = Math.floor(i / (sx * sy))
        const rest = i - z * sx * sy
        const x = rest % sx
        const y = Math.floor(rest / sx)
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (z < z0) z0 = z
        if (x > x1) x1 = x
        if (y > y1) y1 = y
        if (z > z1) z1 = z
    }
    return x1 < x0 ? undefined : {min: [x0, y0, z0], max: [x1, y1, z1]}
}
