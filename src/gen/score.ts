import {voxelIndex, type Volume} from '../render/volume'

/**
 * The deterministic checks CLIP cannot do.
 *
 * CLIP ranks candidates for one prompt and nothing else, and its scores do not track structural
 * quality — it will put a broken shape above a refined one. These are exact, cheap, and answer the
 * questions it is blind to: is this one object or a scatter of debris, does it use its height, has
 * it any shape at all.
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
    /** How many palette entries the model actually uses. */
    readonly colorsUsed: number
    /**
     * How many distinct colours are visible from outside — see `shellColors`.
     *
     * The one term that means anything about a *prop*. A block's silhouette is a square, so
     * `bboxFill` and `sliceUsage` say nothing about whether it is a good block; what says it is
     * whether the faces carry a pattern or the whole thing is one flat colour.
     */
    readonly shellColors: number
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

/**
 * Filled layers as a fraction of the model's own height, not of the grid's.
 *
 * It was the grid's until the generator started fitting the grid to the ops (`gen/ops.ts`), at
 * which point the top and bottom layers are occupied by construction and the whole term pinned at
 * 1.00 for every candidate — a sort key that cannot separate anything. Over the model's own extent
 * it still answers the question it was for: is there a floating hat with a gap under it.
 */
export const sliceUsage = (volume: Volume): number => {
    const {sx, sy, sz, data} = volume
    let used = 0
    let lowest = -1
    let highest = -1
    for (let z = 0; z < sz; z += 1) {
        const base = z * sx * sy
        for (let i = base; i < base + sx * sy; i += 1) {
            if ((data[i] ?? 0) !== 0) {
                used += 1
                if (lowest < 0) lowest = z
                highest = z
                break
            }
        }
    }
    return used === 0 ? 0 : used / (highest - lowest + 1)
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
 * Distinct colours on the outer shell — every filled voxel with at least one empty side, or a side
 * on the edge of the grid.
 *
 * The grid's own boundary counts as empty, and it has to: a block drawn at exactly the canvas size
 * has its front face flush with the wall, and treating that as buried would report a solid cube as
 * having no surface at all.
 *
 * It exists because of the brick measurement (`docs/GEN_RESEARCH.md`, 2026-08-11). Everything else in
 * `ModelScores` asks about the silhouette, and for a block, a tile or a crate the silhouette is a
 * square and all of the information is on the faces. `colorsUsed` cannot stand in for this: a model
 * that painted its mortar lines *through the middle of the cube* — which is what the reply actually
 * did before `gen/face.ts` existed — uses six colours and shows one.
 */
export const shellColors = (volume: Volume): number => {
    const {sx, sy, sz, data} = volume
    const seen = new Uint8Array(256)
    for (let z = 0; z < sz; z += 1) {
        for (let y = 0; y < sy; y += 1) {
            for (let x = 0; x < sx; x += 1) {
                const value = data[voxelIndex(volume, x, y, z)] ?? 0
                if (value === 0) continue
                const bare =
                    x === 0
                    || y === 0
                    || z === 0
                    || x === sx - 1
                    || y === sy - 1
                    || z === sz - 1
                    || (data[voxelIndex(volume, x + 1, y, z)] ?? 0) === 0
                    || (data[voxelIndex(volume, x - 1, y, z)] ?? 0) === 0
                    || (data[voxelIndex(volume, x, y + 1, z)] ?? 0) === 0
                    || (data[voxelIndex(volume, x, y - 1, z)] ?? 0) === 0
                    || (data[voxelIndex(volume, x, y, z + 1)] ?? 0) === 0
                    || (data[voxelIndex(volume, x, y, z - 1)] ?? 0) === 0
                if (bare) seen[value] = 1
            }
        }
    }
    let count = 0
    for (let i = 1; i < 256; i += 1) if (seen[i] === 1) count += 1
    return count
}

const distinctColors = ({data}: Volume): number => {
    const seen = new Uint8Array(256)
    for (const value of data) seen[value] = 1
    let count = 0
    for (let i = 1; i < 256; i += 1) if (seen[i] === 1) count += 1
    return count
}

/**
 * Every score for one candidate.
 *
 * `flat` is the model **as the reply painted it**, before `gen/finish.ts` shaded it, and only
 * `shellColors` reads it. Measured 2026-08-11 and it is not a nicety: `finish` invents up to two
 * shade tones per colour, so the shell of *every* candidate comes back at 10 or more colours, the
 * variety term pins at 1 and the prop branch of `overallScore` becomes a constant that sorts
 * nothing. That is the same defect the note below records about `bboxFill` — a term that cannot
 * separate anything is not a score — and it was rebuilt in a new place before this parameter existed.
 *
 * It defaults to the volume itself, so a caller with only one grid gets the old behaviour and the
 * inflated number rather than a crash. The one caller that has both is `generateMany`.
 */
export const scoreModel = (volume: Volume, flat: Volume = volume): ModelScores => {
    let voxels = 0
    for (const value of volume.data) if (value !== 0) voxels += 1
    return {
        connectivity: connectivity(volume),
        sliceUsage: sliceUsage(volume),
        bboxFill: bboxFill(volume),
        colorsUsed: distinctColors(volume),
        shellColors: shellColors(flat),
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
 * The third term is the one that switches. `surface` is a reply that called `face` — see
 * `gen/face.ts` — and for that subject `1 - bboxFill` is not caution, it is wrong: a Mario brick
 * block is *supposed* to be a solid cube, and this score sorted the correct answer last until
 * 2026-08-11. What replaces it is `variety`, because a prop's whole content is on its shell.
 *
 * Symmetry is deliberately absent: plenty of good subjects are not symmetric. It used to be
 * *measured* anyway — a full pass over every voxel of every candidate, excluded from this sum by
 * design and shown on no card. Computed and never read is not a spare part; it is a cost.
 */
/**
 * How much of a prop's surface reads as a pattern rather than as one flat colour.
 *
 * Six colours or more on the shell is 1, one colour is 0. Invented, like the weights below — three
 * tones is a bevel, four or five is a bevel with courses, and the DB32 ramp under any one colour is
 * three deep, so six is where a prop stops looking hand-shaded and starts looking noisy.
 */
const variety = (scores: ModelScores): number =>
    Math.min(1, Math.max(0, (scores.shellColors - 1) / 5))

export const overallScore = (scores: ModelScores, surface = false): number =>
    0.4 * scores.connectivity
    + 0.3 * scores.sliceUsage
    + 0.3 * (surface ? variety(scores) : 1 - scores.bboxFill)
