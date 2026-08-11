import type {ModelScores} from './score'

/**
 * The hard floor under a candidate: keep it, or throw it away and spend another seed.
 *
 * `docs/GEN_IDEAS.md` §4. `score.ts` measures every structural failure this project has and then
 * only *sorts* by them, so a batch of six comes back as six cards of which two are debris and one is
 * a brick — three empty slots the artist still has to look at. This is the other half of those
 * measurements: a threshold under each, and a candidate below one is not shown, it is replaced.
 *
 * **This is rejection sampling and it is not the dead revision loop.** Nothing is fed back, the
 * prompt does not change, and the model is never told it failed — it is asked the same question
 * again with the next seed. The loop that died three times (`docs/GEN_RESEARCH.md`, "Tried and
 * dead") fed the model its own render and its own accurate critique and got byte-identical code
 * back; nothing here reaches the model at all.
 *
 * The gate is over `ModelScores`, never over the `Volume`. Those scores are already computed for
 * every candidate — `batch.ts` calls `scoreModel` in `onAttempt` — so the gate itself costs
 * arithmetic on five numbers. What it costs is *wall clock*, because a rejection buys another 7–20 s
 * call, and that is what `MAX_RESAMPLES` bounds.
 *
 * `colorsUsed` is deliberately not gated, for the reason symmetry is deliberately absent from
 * `overallScore`: it is a fact and not a 0–1 score, its value depends on whether `finish` and the
 * palette snap have run (three tones per source colour, or fewer where the project palette has no
 * ramp), and the record's one-colour failure — "a dark blob with a stick" — failed on shape, which
 * the four thresholds below already catch. A flat model with a good silhouette is a keeper.
 */
export const GATE = {
    /**
     * How much of the model the largest 6-connected piece has to be.
     *
     * The record holds two connectivity numbers and nothing between them: every worked example in
     * `builtin.ts` scores exactly 1.00, as does `src/assets/car.vox` — the one artist-made model in
     * the repo — and the fish that came back **"in fragments at 0.59 connectivity"** (2026-08-09,
     * three-examples measurement) is the failure this exists for. 0.85 sits in that gap, nearer the
     * failure, because the gap is where there is no evidence.
     *
     * One notch tighter, at 0.95, and the dog with its 16-voxel tail shaken loose — 3 % of it — is
     * thrown away: a model an artist would keep, and exactly what §1's repair pass reattaches. One
     * notch looser, at 0.5, and the fragmented fish is a candidate again, which is the whole point
     * of the gate gone.
     */
    minConnectivity: 0.85,
    /**
     * Filled layers as a fraction of the model's own height — the floating hat.
     *
     * Redundant with connectivity by construction and *not* by weighting, which is why both are
     * here. An empty layer is a break, so anything this catches is disconnected as well; but
     * connectivity counts voxels, so a 10-voxel comb hovering five layers over a 500-voxel body
     * scores 0.98 and walks through, while over layers the same model is around 0.75 and does not.
     * Voxels are what a piece weighs, layers are how far away it is, and a small piece far away is
     * the one a fraction of voxels cannot see. Every worked example is 1.00.
     *
     * One notch tighter, at 1.00, and a single missing layer — the one-voxel gap §1 closes with a
     * dilate rather than a new seed — costs 7–20 s. One notch looser, at 0.5, and a body with its
     * head hovering a body's height above it is a candidate.
     */
    minSliceUsage: 0.8,
    /**
     * Voxels as a fraction of the box they occupy: above this it is a brick, not a sprite.
     *
     * The measured failure, twice. Three of the six "a stone tower" candidates on 2026-08-08 came
     * back at `bboxFill = 1.000` with every other deterministic score also exactly 1.000 — a solid
     * rectangular block, which `overallScore`'s third term had to change sign for. And the 128
     * canvas run on 2026-08-11 came back at 0.88, which `ask.ts` calls in so many words "the solid
     * brick `score.ts` exists to sink". Both are above 0.80 and both are rejected.
     *
     * The keeps: the worked examples run 0.34 (chicken) to 0.63 (the tower's solid shaft), and
     * `car.vox` is 0.57. `bank.test.ts` already refuses any example over 0.75, so 0.80 is that
     * existing floor with a little air over it rather than a number chosen here.
     *
     * One notch tighter, at 0.65, and the bank's own tower — the example that teaches every building
     * this generator makes — fails its own gate. One notch looser, at 0.90, and the 0.88 brick from
     * the 128 run passes, leaving the gate catching only a flawless 1.000.
     */
    maxBboxFill: 0.8,
    /**
     * The fewest voxels that can be a model at all.
     *
     * This catches a reply that ran one box and threw — `specFromCode` keeps whatever was painted
     * before the crash on purpose, so a program that died on line two arrives here as a die-sized
     * lump rather than as nothing. The smallest thing in the bank is the chicken at 283 voxels and
     * `car.vox` is 478, so 32 is an order of magnitude below anything the record calls a model.
     *
     * One notch tighter — anywhere near 250 — and it starts refusing small subjects nobody has
     * measured: a coin, an apple, a key. One notch looser, at 1, and only the truly empty grid is
     * caught, which `empty` already says better.
     *
     * It is also the floor a small canvas has to clear. `CANVAS_SIZES` offers 8³, which is 512 cells
     * in total — a prop drawn there is 60–200 voxels and passes, and anything under 32 in a box that
     * size really is the crash-on-line-two case this catches.
     */
    minVoxels: 32
} as const

/**
 * Why a candidate was thrown away, as an id the dialog can count.
 *
 * The order they are declared in is the order they are *asked* in, and that order is the order an
 * artist would say it in: nothing there, barely anything there, several things rather than one, one
 * thing with a hole under it, one thing with no silhouette. A 3³ solid die is both `tiny` and
 * `brick` and reads back as `tiny`, because its size is the useful half of that sentence.
 */
export type GateReason = 'empty' | 'tiny' | 'debris' | 'floating' | 'brick' | 'flat'

/** Every reason, in the order they are asked — for a legend, and so a status line has an order. */
export const GATE_REASONS: readonly GateReason[] = [
    'empty',
    'tiny',
    'debris',
    'floating',
    'brick',
    'flat'
]

/** One word per reason, for counting rejects in a status line. */
export const GATE_WORDS: Readonly<Record<GateReason, string>> = {
    empty: 'empty',
    tiny: 'tiny',
    debris: 'debris',
    floating: 'floating',
    brick: 'brick',
    flat: 'flat'
}

/** Which threshold this candidate is under, or `undefined` to keep it. */
/**
 * The floor under a prop's shell, in distinct colours.
 *
 * Three, because that is a bevel: a base tone, a lighter edge and a darker one. Two is a base and one
 * highlight, which is a cube somebody started shading and stopped. One is a coloured box, which is
 * the failure this rule exists for — the whole promise of `face` is that the information is on the
 * surface, so a surface with nothing on it is the prop equivalent of the solid brick.
 *
 * It replaces `maxBboxFill` rather than joining it. A block is *meant* to be solid: measured live on
 * "a Mario brick block", the 32³ candidate came back at 83 % and the relational one at 95 %, and both
 * were rejected by a rule written for cats.
 */
const MIN_SHELL_COLORS = 3

/**
 * Which threshold this candidate is under, or `undefined` to keep it.
 *
 * `surface` is a reply that called `face` — see `gen/face.ts`. It swaps one rule for another rather
 * than loosening the gate: a prop may be as solid as it likes and must not be flat, and everything
 * else — empty, tiny, debris, floating — is asked of both.
 */
export const gateReason = (scores: ModelScores, surface = false): GateReason | undefined => {
    if (scores.voxels === 0) return 'empty'
    if (scores.voxels < GATE.minVoxels) return 'tiny'
    if (scores.connectivity < GATE.minConnectivity) return 'debris'
    if (scores.sliceUsage < GATE.minSliceUsage) return 'floating'
    if (surface) return scores.shellColors < MIN_SHELL_COLORS ? 'flat' : undefined
    if (scores.bboxFill > GATE.maxBboxFill) return 'brick'
    return undefined
}

const percent = (value: number): string => `${String(Math.round(value * 100))}%`

/**
 * Why this candidate is not worth an artist's attention, or `undefined` to keep it.
 *
 * The number that failed is in the sentence. This is read by somebody deciding whether the gate is
 * set right — that is what the flag is for, `flags.ts` says every experiment is off until its
 * numbers are in `GEN_RESEARCH.md` — and "rejected: a brick" is not a measurement.
 */
export const gateFailure = (scores: ModelScores, surface = false): string | undefined => {
    const reason = gateReason(scores, surface)
    if (reason === undefined) return undefined
    if (reason === 'empty') return 'nothing was painted'
    if (reason === 'tiny') return `only ${String(scores.voxels)} voxels`
    if (reason === 'debris')
        return `in pieces: the biggest is ${percent(scores.connectivity)} of it`
    if (reason === 'floating')
        return `a gap through it: ${percent(1 - scores.sliceUsage)} of its layers are empty`
    if (reason === 'flat')
        return `flat: only ${String(scores.shellColors)} colour(s) anywhere on its surface`
    return `a brick: ${percent(scores.bboxFill)} of its own bounding box is solid`
}

/**
 * How many extra seeds a batch may spend replacing rejects, whatever it asked for.
 *
 * **The cap is part of the design, not a safety net.** The record's hit rates, measured 2026-08-08
 * over eight candidates each, are 3 of 8 for `a cat` and **0 of 8 for `a knight`** — so a prompt
 * that no seed passes demonstrably exists, and without a cap that prompt spends both GPUs until
 * somebody closes the dialog.
 *
 * Six is a wall clock rather than a probability. A candidate is 7–20 s, so six extra seeds is one to
 * two minutes on top of a batch that is already about a minute at the default count of four
 * (`ask.ts`). It is also about what the cat rate actually costs: filling four slots at 3-in-8 takes
 * around eleven attempts, seven of them thrown away.
 */
export const MAX_RESAMPLES = 6

/**
 * The resample budget for a batch of `count`, so the loop cannot run forever.
 *
 * Never more seeds than the batch asked for — a batch can at most double in length — and never more
 * than `MAX_RESAMPLES` however big the batch is. Twelve candidates is already four minutes; twelve
 * more would be a dialog nobody waits out.
 *
 * A count that is not a whole positive number comes back 0 rather than throwing. This is read from a
 * loop condition, and `NaN` in a loop condition means forever, which is the one thing this function
 * exists to prevent. `asking` in `ask.ts` clamps the count already; that is not a reason for the
 * bound to exist only there.
 */
export const resampleBudget = (count: number): number => {
    if (!Number.isFinite(count)) return 0
    return Math.max(0, Math.min(MAX_RESAMPLES, Math.floor(count)))
}

/**
 * What the gate has done to this batch so far, for the status line under the grid.
 *
 * `rejected` and `keptAnyway` are both failures and they are counted apart because they cost
 * different things: a `rejected` candidate bought another call, a `keptAnyway` one is on screen with
 * the gate's sentence on it. `reasons` counts both, because "what was wrong with this batch" is one
 * question.
 */
export interface GateTally {
    /** Candidates that passed. */
    readonly kept: number
    /** Candidates thrown away, which is also the number of extra seeds spent. */
    readonly rejected: number
    /** Candidates that failed and are shown regardless, because the budget ran out. */
    readonly keptAnyway: number
    readonly reasons: Readonly<Record<GateReason, number>>
}

export const NOTHING_GATED: GateTally = {
    kept: 0,
    rejected: 0,
    keptAnyway: 0,
    reasons: {empty: 0, tiny: 0, debris: 0, floating: 0, brick: 0, flat: 0}
}

/** Whether another seed may be spent. The one place the budget is compared to what was spent. */
export const mayResample = (tally: GateTally, count: number): boolean =>
    tally.rejected < resampleBudget(count)

/** What happens to one scored candidate. */
export interface Admission {
    /**
     * Whether this candidate goes in the grid.
     *
     * True for a pass, and **true for a failure once the budget is gone.** That is the answer to the
     * knight: 0 of 8 means every seed fails, and a gate that held out for a passing candidate would
     * hand the artist an empty grid and a spent minute. A wrong sprite is something to look at, edit
     * or throw away; nothing is not. So the last word belongs to the budget, and `failure` still
     * says what the gate thought so the card can carry it.
     */
    readonly keep: boolean
    /** The gate's sentence, whenever it failed — including when it was kept anyway. */
    readonly failure: string | undefined
    readonly tally: GateTally
}

const counting = (
    reasons: Readonly<Record<GateReason, number>>,
    reason: GateReason
): Record<GateReason, number> => ({...reasons, [reason]: reasons[reason] + 1})

/**
 * One candidate through the gate, against what the batch has spent already.
 *
 * The whole rule in one call, so the loop in `batch.ts` is `if (!keep) generate again` and does not
 * get to hold a second opinion about the budget. `count` is the batch's own count, which is what the
 * budget is derived from.
 */
export const admit = (
    scores: ModelScores,
    tally: GateTally,
    count: number,
    surface = false
): Admission => {
    const reason = gateReason(scores, surface)
    if (reason === undefined)
        return {keep: true, failure: undefined, tally: {...tally, kept: tally.kept + 1}}
    const failure = gateFailure(scores, surface)
    const reasons = counting(tally.reasons, reason)
    if (mayResample(tally, count))
        return {keep: false, failure, tally: {...tally, rejected: tally.rejected + 1, reasons}}
    return {keep: true, failure, tally: {...tally, keptAnyway: tally.keptAnyway + 1, reasons}}
}

/**
 * The status line, or an empty string when the gate has seen nothing.
 *
 * Empty rather than "0 kept, 0 rejected", so the dialog draws no line at all before a batch has
 * started — the same call `batch.ts` makes about CLIP's line.
 */
export const gateStatus = (tally: GateTally): string => {
    const seen = tally.kept + tally.rejected + tally.keptAnyway
    if (seen === 0) return ''
    const counted = GATE_REASONS.filter(reason => tally.reasons[reason] > 0).map(
        reason => `${GATE_WORDS[reason]} ×${String(tally.reasons[reason])}`
    )
    const parts = [`Gates: ${String(tally.kept)} kept`]
    if (tally.rejected > 0) parts.push(`${String(tally.rejected)} resampled`)
    if (tally.keptAnyway > 0) parts.push(`${String(tally.keptAnyway)} shown anyway — out of seeds`)
    const line = parts.join(', ')
    return counted.length === 0 ? line : `${line} (${counted.join(', ')})`
}
