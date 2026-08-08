import {voxelIndex, type Volume} from '../render/volume'

/**
 * The deterministic checks CLIP cannot do.
 *
 * CLIP ranks candidates for one prompt and nothing else, and its scores do not track structural
 * quality — it will put a broken shape above a refined one. These are exact, cheap, and answer the
 * questions it is blind to: is this one object or a scatter of debris, does it use its height, has
 * it any shape at all, is it symmetric.
 *
 * Every one is 0–1 and higher is better, except `colorsUsed` and `voxels`, which are facts.
 */
export interface ModelScores {
    /** Voxels in the largest 6-connected component, as a fraction of all voxels. */
    readonly connectivity: number
    /** Layers with at least one voxel, as a fraction of the model's height. */
    readonly sliceUsage: number
    /** Voxels as a fraction of the box they occupy. `1` is a solid brick — see `overallScore`. */
    readonly bboxFill: number
    /** Voxels whose x-mirror is also occupied, as a fraction of all voxels. */
    readonly symmetryX: number
    readonly colorsUsed: number
    readonly voxels: number
}

/**
 * Largest 6-connected component as a fraction of the model.
 *
 * Face neighbours, matching `doc/selection.ts` — two lumps touching at a corner are two lumps, and a
 * generator that emits a body and a detached hat should not score as one object.
 */
export const connectivity = (volume: Volume): number => {
    const {sx, sy, sz, data} = volume
    const seen = new Uint8Array(data.length)
    let total = 0
    for (const value of data) if (value !== 0) total += 1
    if (total === 0) return 0

    let largest = 0
    const stack: number[] = []
    for (let start = 0; start < data.length; start += 1) {
        if ((data[start] ?? 0) === 0 || seen[start] === 1) continue
        seen[start] = 1
        stack.push(start)
        let size = 0
        while (stack.length > 0) {
            const index = stack.pop() ?? 0
            size += 1
            const z = Math.floor(index / (sx * sy))
            const rest = index - z * sx * sy
            const x = rest % sx
            const y = Math.floor(rest / sx)
            const around: readonly [number, number, number][] = [
                [x + 1, y, z],
                [x - 1, y, z],
                [x, y + 1, z],
                [x, y - 1, z],
                [x, y, z + 1],
                [x, y, z - 1]
            ]
            for (const [nx, ny, nz] of around) {
                if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue
                const next = voxelIndex(volume, nx, ny, nz)
                if ((data[next] ?? 0) === 0 || seen[next] === 1) continue
                seen[next] = 1
                stack.push(next)
            }
        }
        if (size > largest) largest = size
    }
    return largest / total
}

export const sliceUsage = (volume: Volume): number => {
    const {sx, sy, sz, data} = volume
    if (sz === 0) return 0
    let used = 0
    for (let z = 0; z < sz; z += 1) {
        const base = z * sx * sy
        for (let i = base; i < base + sx * sy; i += 1) {
            if ((data[i] ?? 0) !== 0) {
                used += 1
                break
            }
        }
    }
    return used / sz
}

export const bboxFill = (volume: Volume): number => {
    const {sx, sy, data} = volume
    let x0 = Infinity
    let y0 = Infinity
    let z0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    let z1 = -Infinity
    let count = 0
    for (let i = 0; i < data.length; i += 1) {
        if ((data[i] ?? 0) === 0) continue
        count += 1
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
    if (count === 0) return 0
    return count / ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1))
}

/**
 * Mirrored about the grid's centre, not about the model's own bounding box — that is the axis
 * `mirror_x` in a generated spec reflects across, so this measures the thing the generator was
 * asked for. A symmetric shape sitting off-centre scores low, and that is the answer: it is not
 * symmetric about the axis it claimed.
 */
export const symmetryX = (volume: Volume): number => {
    const {sx, sy, sz, data} = volume
    let count = 0
    let matched = 0
    for (let z = 0; z < sz; z += 1) {
        for (let y = 0; y < sy; y += 1) {
            for (let x = 0; x < sx; x += 1) {
                if ((data[voxelIndex(volume, x, y, z)] ?? 0) === 0) continue
                count += 1
                if ((data[voxelIndex(volume, sx - 1 - x, y, z)] ?? 0) !== 0) matched += 1
            }
        }
    }
    return count === 0 ? 0 : matched / count
}

const distinctColors = ({data}: Volume): number => {
    const seen = new Uint8Array(256)
    for (const value of data) seen[value] = 1
    let count = 0
    for (let i = 1; i < 256; i += 1) if (seen[i] === 1) count += 1
    return count
}

export const scoreModel = (volume: Volume): ModelScores => {
    let voxels = 0
    for (const value of volume.data) if (value !== 0) voxels += 1
    return {
        connectivity: connectivity(volume),
        sliceUsage: sliceUsage(volume),
        bboxFill: bboxFill(volume),
        symmetryX: symmetryX(volume),
        colorsUsed: distinctColors(volume),
        voxels
    }
}

/**
 * One number for sorting a candidate grid when CLIP is not there.
 *
 * **The weights are invented and this is a sort order, not a quality gate.** What is not invented is
 * the sign on the third term. Measured over six candidates for "a stone tower" on 2026-08-08, three
 * came back as `bboxFill = 1.0` — a solid rectangular block filling its whole grid — and every other
 * deterministic score on them was also exactly 1.000, so the legacy weighting, which *rewarded*
 * fill, sorted the three shapeless bricks to the top. A model that fills its own bounding box has no
 * silhouette; carving is the whole of the work. So the term is `1 - bboxFill`, and connectivity is
 * what stops that rewarding a cloud of debris.
 *
 * Symmetry is deliberately absent: plenty of good subjects are not symmetric.
 */
export const overallScore = (scores: ModelScores): number =>
    0.4 * scores.connectivity + 0.3 * scores.sliceUsage + 0.3 * (1 - scores.bboxFill)
