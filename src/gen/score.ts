import {packKey, unpackKey, type VoxModel} from '../vox/model'

/**
 * The deterministic checks CLIP cannot do, from `PRODUCTION_PLAN.md` §9 fix 3.
 *
 * CLIP ranks candidates for one prompt and nothing else — independent work confirms its scores do
 * not track structural quality and can put a broken shape above a refined one. These are exact,
 * cheap, and answer the questions CLIP is blind to: is it one object or a scatter of debris, does
 * it use its slices, does it fill the space it claims, is it symmetric, does it stay on palette.
 *
 * Every one is 0–1 and higher is better, so they compose.
 */
export interface ModelScores {
    /** Voxels in the largest 6-connected component, as a fraction of all voxels. */
    connectivity: number
    /** Slices with at least one voxel, as a fraction of the model's height. */
    sliceUsage: number
    /** Voxels as a fraction of the bounding box they occupy. */
    bboxFill: number
    /** Voxels whose x-mirror is also occupied, as a fraction of all voxels. */
    symmetryX: number
    /** Voxels using a colour the palette allows, as a fraction of all voxels. */
    paletteCompliance: number
    /** Distinct colours actually used. Not a score — reported because it is the cheapest tell. */
    colorsUsed: number
    voxels: number
}

const neighbours = (x: number, y: number, z: number): [number, number, number][] => [
    [x + 1, y, z],
    [x - 1, y, z],
    [x, y + 1, z],
    [x, y - 1, z],
    [x, y, z + 1],
    [x, y, z - 1]
]

/**
 * Largest 6-connected component as a fraction of the model.
 *
 * Face neighbours, matching `selectRegion` — two lumps touching at a corner are two lumps, and a
 * generator that emits a body and a detached hat should not score as one object.
 */
export const connectivity = ({voxels}: VoxModel): number => {
    if (voxels.size === 0) {
        return 0
    }
    const unseen = new Set(voxels.keys())
    let largest = 0

    while (unseen.size > 0) {
        const start: number = unseen.values().next().value ?? 0
        unseen.delete(start)
        const stack = [start]
        let size = 0
        while (stack.length > 0) {
            const key = stack.pop()
            if (key === undefined) {
                break
            }
            size += 1
            const [x, y, z] = unpackKey(key)
            for (const [nx, ny, nz] of neighbours(x, y, z)) {
                const next = packKey(nx, ny, nz)
                if (unseen.has(next)) {
                    unseen.delete(next)
                    stack.push(next)
                }
            }
        }
        largest = Math.max(largest, size)
    }
    return largest / voxels.size
}

export const sliceUsage = (model: VoxModel): number => {
    if (model.sz === 0) {
        return 0
    }
    const filled = new Set<number>()
    for (const key of model.voxels.keys()) {
        filled.add(unpackKey(key)[2])
    }
    return filled.size / model.sz
}

export const bboxFill = ({voxels}: VoxModel): number => {
    if (voxels.size === 0) {
        return 0
    }
    let minX = Infinity
    let minY = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let maxZ = -Infinity
    for (const key of voxels.keys()) {
        const [x, y, z] = unpackKey(key)
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        minZ = Math.min(minZ, z)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
        maxZ = Math.max(maxZ, z)
    }
    const volume = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1)
    return voxels.size / volume
}

/**
 * Mirrored about the canvas centre (`sx`), not about the model's own bounding box — that is the
 * axis `mirror_x` in a generated spec reflects across, so this measures the same thing the
 * generator was asked for. A model sitting off-centre scores 0 even if its shape is symmetric.
 */
export const symmetryX = (model: VoxModel): number => {
    const {voxels, sx} = model
    if (voxels.size === 0) {
        return 0
    }
    let matched = 0
    for (const key of voxels.keys()) {
        const [x, y, z] = unpackKey(key)
        if (voxels.has(packKey(sx - 1 - x, y, z))) {
            matched += 1
        }
    }
    return matched / voxels.size
}

/**
 * How much of the model stays on an allowed palette — the check behind "lock the palette so
 * generation cannot introduce off-palette colours" (§7). `allowed` is a set of 1-based indices.
 */
export const paletteCompliance = ({voxels}: VoxModel, allowed?: ReadonlySet<number>): number => {
    if (voxels.size === 0) {
        return 0
    }
    if (!allowed || allowed.size === 0) {
        return 1
    }
    let ok = 0
    for (const color of voxels.values()) {
        if (allowed.has(color)) {
            ok += 1
        }
    }
    return ok / voxels.size
}

export const scoreModel = (model: VoxModel, allowed?: ReadonlySet<number>): ModelScores => ({
    connectivity: connectivity(model),
    sliceUsage: sliceUsage(model),
    bboxFill: bboxFill(model),
    symmetryX: symmetryX(model),
    paletteCompliance: paletteCompliance(model, allowed),
    colorsUsed: new Set(model.voxels.values()).size,
    voxels: model.voxels.size
})

/**
 * One number for sorting a candidate grid.
 *
 * **The weights are invented.** They say connectivity and slice usage matter most, because a
 * scattered or single-slice model is useless whatever else is true of it, and that bbox fill is
 * worth a little but not much — a solid brick fills its box perfectly and is not a sprite.
 * Symmetry is deliberately absent: plenty of good subjects are not symmetric. Treat this as a
 * default sort order, not a quality gate; §14 records it as uncalibrated.
 */
export const overallScore = (scores: ModelScores): number =>
    0.45 * scores.connectivity
    + 0.35 * scores.sliceUsage
    + 0.1 * Math.min(scores.bboxFill * 2, 1)
    + 0.1 * scores.paletteCompliance
