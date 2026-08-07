import {rasterise, type BallOp, type Vec3, type VoxOp, type VoxSpec} from './ops'

/**
 * Evolutionary refinement on the op list (`PRODUCTION_PLAN.md` §9, "then").
 *
 * The point is that mutation happens in code on a small structured list, so a generation costs one
 * scoring pass and **no LLM call at all**. The model produces the starting population once; after
 * that this is a search over twenty-odd numbers.
 *
 * The risk is named in §9 fix 3 and is not hypothetical: CLIP does not track structural quality
 * monotonically, so optimising against it can walk towards something CLIP likes and a person does
 * not. That is why `evolve` takes any scorer and why the experiment that drives it reports the
 * deterministic structure scores of the winner alongside the score it was optimising.
 */
export type Rng = () => number

/** A small deterministic generator, so an evolution run can be repeated exactly. */
export const makeRng = (seed: number): Rng => {
    let state = seed >>> 0 || 1
    return () => {
        state ^= state << 13
        state >>>= 0
        state ^= state >>> 17
        state ^= state << 5
        state >>>= 0
        return state / 0x100000000
    }
}

const pick = <T>(rng: Rng, items: readonly T[]): T | undefined =>
    items[Math.floor(rng() * items.length)]

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value))

const jitterVec = (rng: Rng, vec: Vec3, amount: number, size: Vec3): Vec3 =>
    vec.map((value, axis) =>
        clamp(value + Math.round((rng() * 2 - 1) * amount), 0, (size[axis] ?? 32) - 1)
    ) as Vec3

const jitterColor = (rng: Rng, color: string): string => {
    const body = color.replace('#', '')
    const channels = [0, 1, 2].map(i => parseInt(body.slice(i * 2, i * 2 + 2), 16))
    const shifted = channels.map(value => clamp(value + Math.round((rng() * 2 - 1) * 40), 0, 255))
    // the schema's colour pattern is exactly six hex digits, so pad rather than trusting toString
    return `#${shifted.map(value => value.toString(16).padStart(2, '0')).join('')}`
}

export interface MutateOptions {
    /** How far a coordinate may move in one step. */
    jitter?: number
    /** Chance of structural change (add or remove an op) rather than a tweak. */
    structural?: number
    /** Never grow past this many ops — the prompt promises the model at most 40. */
    maxOps?: number
}

/**
 * One mutation of one spec. Always returns a new object; the input is untouched.
 *
 * Mutations are deliberately small and local. A large jump is just a worse random sample — the
 * population already covers "somewhere else entirely", because the model generated it.
 */
export const mutateSpec = (spec: VoxSpec, rng: Rng, options: MutateOptions = {}): VoxSpec => {
    const jitter = options.jitter ?? 2
    const structural = options.structural ?? 0.25
    const maxOps = options.maxOps ?? 40
    const size = spec.size
    const ops = [...spec.ops]

    if (ops.length === 0) {
        return {...spec, ops}
    }

    const roll = rng()
    if (roll < structural / 2 && ops.length < maxOps) {
        // duplicate an op and nudge it: growth that keeps the model recognisable
        const source = pick(rng, ops)
        if (source) {
            const copy: VoxOp =
                source.op === 'ball' ?
                    {...source, at: jitterVec(rng, source.at, jitter * 2, size)}
                :   {
                        ...source,
                        from: jitterVec(rng, source.from, jitter * 2, size),
                        to: jitterVec(rng, source.to, jitter * 2, size)
                    }
            ops.splice(Math.floor(rng() * (ops.length + 1)), 0, copy)
        }
        return {...spec, ops}
    }
    if (roll < structural && ops.length > 1) {
        ops.splice(Math.floor(rng() * ops.length), 1)
        return {...spec, ops}
    }

    const index = Math.floor(rng() * ops.length)
    const op = ops[index]
    if (!op) {
        return {...spec, ops}
    }

    const choice = rng()
    if (op.op === 'ball') {
        const next: BallOp =
            choice < 0.45 ? {...op, at: jitterVec(rng, op.at, jitter, size)}
            : choice < 0.8 ?
                {
                    ...op,
                    r: op.r.map(value =>
                        clamp(value + Math.round((rng() * 2 - 1) * jitter), 0, 16)
                    ) as Vec3
                }
            :   {...op, color: jitterColor(rng, op.color)}
        ops[index] = next
        return {...spec, ops}
    }

    const moved = {
        ...op,
        from: jitterVec(rng, op.from, jitter, size),
        to: jitterVec(rng, op.to, jitter, size)
    }
    ops[index] =
        op.op === 'box' && choice > 0.8 ? {...op, color: jitterColor(rng, op.color)} : moved
    return {...spec, ops}
}

export interface EvolveOptions {
    generations?: number
    /** Survivors per generation. */
    keep?: number
    /** Total specs alive at once, survivors included. */
    population?: number
    rng?: Rng
    mutate?: MutateOptions
    /** Called after each generation with the best score so far. */
    onGeneration?: (generation: number, best: number, scores: number[]) => void
}

export interface EvolveResult {
    best: VoxSpec
    bestScore: number
    /** Best score at each generation, generation 0 being the starting population. */
    history: number[]
    /** How many times the scorer was asked. */
    evaluations: number
}

const SCORE_FLOOR = -Infinity

/**
 * Generate → score → keep top K → mutate → repeat.
 *
 * `score` may be async because the interesting scorer is a local service. Specs that rasterise to
 * nothing are scored at −∞ rather than dropped, so the population size stays fixed and a run
 * cannot quietly collapse to one survivor.
 */
export const evolve = async (
    seeds: readonly VoxSpec[],
    score: (specs: readonly VoxSpec[]) => Promise<(number | null)[]>,
    options: EvolveOptions = {}
): Promise<EvolveResult> => {
    const generations = options.generations ?? 4
    const keep = Math.max(1, options.keep ?? 2)
    const population = Math.max(keep + 1, options.population ?? Math.max(seeds.length, 6))
    const rng = options.rng ?? makeRng(1)

    let alive = [...seeds]
    let evaluations = 0
    const history: number[] = []
    let best = seeds[0] ?? {name: 'empty', size: [1, 1, 1], mirror_x: false, ops: []}
    let bestScore = SCORE_FLOOR

    for (let generation = 0; generation <= generations; generation += 1) {
        const usable = alive.filter(spec => rasterise(spec).voxels.size > 0)
        const scores = await score(alive)
        evaluations += alive.length

        const ranked = alive
            .map((spec, i) => ({
                spec,
                score: usable.includes(spec) ? (scores[i] ?? SCORE_FLOOR) : SCORE_FLOOR
            }))
            .sort((a, b) => b.score - a.score)

        const top = ranked[0]
        if (top && top.score > bestScore) {
            bestScore = top.score
            best = top.spec
        }
        history.push(top?.score ?? SCORE_FLOOR)
        options.onGeneration?.(
            generation,
            top?.score ?? SCORE_FLOOR,
            ranked.map(entry => entry.score)
        )

        if (generation === generations) {
            break
        }

        const survivors = ranked.slice(0, keep).map(entry => entry.spec)
        const next = [...survivors]
        while (next.length < population) {
            const parent = pick(rng, survivors) ?? survivors[0]
            if (!parent) {
                break
            }
            next.push(mutateSpec(parent, rng, options.mutate ?? {}))
        }
        alive = next
    }

    return {best, bestScore, history, evaluations}
}
