import {rasterise, readSpec, VOX_SCHEMA, type VoxSpec} from './ops'
import type {Volume} from '../render/volume'

/**
 * The half of generation that talks to llama-server on `localhost:8080`.
 *
 * A port, like `doc/store.ts` and `doc/files.ts`, and for the same reason: the logic worth testing
 * is which seeds get used, what happens to a candidate that fails and whether a cancel is honoured
 * — none of which should need a 27B model loaded to check. `browserLlama` is the real one;
 * `memoryLlama` is what `bun test` drives.
 *
 * The JSON schema goes in `response_format`, so llama.cpp compiles it to a decoding grammar and a
 * malformed reply cannot be produced. Measured against the live server 2026-08-08: asked for a
 * stone tower with the schema attached it returned a valid model every time, in 7–20 s per
 * candidate at 424 completion tokens. `readSpec` still narrows the reply — see the comment there.
 *
 * No streaming and no retries. A candidate that fails is one of N and is reported as a failure
 * rather than quietly replaced, because a silent retry hides a prompt that has stopped working.
 */
export const DEFAULT_ENDPOINT = 'http://localhost:8080'

export const SYSTEM = `You are a voxel modeller. You answer with JSON only, no prose, no markdown fence.

Schema:
{"name": str,
 "size": [sx, sy, sz],
 "mirror_x": bool,
 "ops": [ ... ]}

Axes: x = left/right (width), y = up/down (height), z = front/back (depth).
Origin [0,0,0] is the bottom-left-back corner. Bigger y is higher up.
Ops are applied in order; later ops paint over earlier ones.
  {"op":"box","from":[x,y,z],"to":[x,y,z],"color":"#rrggbb"}   inclusive bounds
  {"op":"ball","at":[x,y,z],"r":[rx,ry,rz],"color":"#rrggbb"}  axis-aligned ellipsoid
  {"op":"erase","from":[x,y,z],"to":[x,y,z]}                   carve empty space

Rules:
- Keep every coordinate inside size, and size within 32x32x32. At most 40 ops.
- If mirror_x is true, model only the left half (x < sx/2); the right half is a
  mirror of it. The centre line is then x = sx/2, so a nose or a spine is built
  right up against it, and nothing crosses it.
- Feet and legs sit at low y. A head sits at high y. A tail sticks out in z.
- Block out the silhouette first with a few large boxes, then carve it with
  erase, then add small details. Never start with a box that fills the grid.
- Build in readable layers: the object must look correct sliced horizontally,
  so avoid overhangs that would leave a slice floating and unreadable.
- Use 4-8 distinct colors with real value contrast, not near-identical shades.`

/**
 * One worked answer per body plan, handed over as a prior turn rather than quoted in the system
 * prompt.
 *
 * The example is worth more than every rule in `SYSTEM` put together, measured 2026-08-08. Rules
 * alone gave upright blobs: four legs described in prose does not survive contact with a grammar
 * that starts emitting JSON on the first token, because a schema-constrained reply has nowhere to
 * think. One example took "a cat" from 0 of 12 recognisable to 4 of 4.
 *
 * There are four of them because one is not neutral. With only the dog in the prompt, **"a chicken"
 * came back with four legs** and "a fish" came back a slab — the example teaches the answer's shape,
 * and a subject whose shape is different gets dragged. Cats were fine only because a cat happens to
 * be a quadruped. With the bank, chickens stand on two legs and a pine tree comes back a tiered
 * conifer on a trunk.
 *
 * Each demonstrates the whole language once — `mirror_x` with only the left half modelled, y-up with
 * the feet at low `y`, parts that touch, a palette with real value contrast — and `building` is also
 * the only one that carves with `erase`, which is why it is a battlemented tower and not a box.
 *
 * **If you change one, render it.** `llama.test.ts` holds them to being one connected piece that is
 * not a solid brick, but only your eyes can say whether the dog looks like a dog, and an example
 * that does not look like what it claims teaches exactly that.
 */
export type BodyPlan = 'quadruped' | 'bird' | 'plant' | 'building'

export const BODY_PLANS: readonly BodyPlan[] = ['quadruped', 'bird', 'plant', 'building']

export const EXAMPLES: Readonly<
    Record<BodyPlan, {readonly prompt: string; readonly reply: string}>
> = {
    quadruped: {
        prompt: 'a dog',
        reply: JSON.stringify({
            name: 'dog',
            size: [8, 12, 18],
            mirror_x: true,
            ops: [
                {op: 'box', from: [1, 5, 3], to: [3, 9, 14], color: '#8b5a2b'},
                {op: 'box', from: [1, 8, 14], to: [3, 11, 17], color: '#a0693a'},
                {op: 'box', from: [1, 1, 4], to: [2, 5, 5], color: '#8b5a2b'},
                {op: 'box', from: [1, 1, 12], to: [2, 5, 13], color: '#8b5a2b'},
                {op: 'box', from: [1, 11, 14], to: [1, 12, 15], color: '#6f4520'},
                {op: 'box', from: [2, 9, 17], to: [3, 10, 17], color: '#2b1a0d'},
                {op: 'box', from: [3, 8, 3], to: [3, 11, 3], color: '#a0693a'}
            ]
        })
    },
    bird: {
        prompt: 'a chicken',
        reply: JSON.stringify({
            name: 'chicken',
            size: [8, 16, 12],
            mirror_x: true,
            ops: [
                {op: 'box', from: [1, 5, 3], to: [3, 10, 8], color: '#f2e3c8'},
                {op: 'box', from: [0, 6, 4], to: [0, 9, 7], color: '#d8c4a0'},
                {op: 'box', from: [1, 10, 2], to: [3, 13, 2], color: '#d8c4a0'},
                {op: 'box', from: [2, 11, 6], to: [3, 13, 8], color: '#f2e3c8'},
                {op: 'box', from: [3, 14, 6], to: [3, 14, 7], color: '#cc2b2b'},
                {op: 'box', from: [3, 11, 9], to: [3, 12, 9], color: '#e08a2c'},
                {op: 'box', from: [2, 12, 8], to: [2, 12, 8], color: '#2b2b28'},
                {op: 'box', from: [1, 0, 5], to: [2, 4, 6], color: '#e08a2c'}
            ]
        })
    },
    plant: {
        prompt: 'a red mushroom',
        reply: JSON.stringify({
            name: 'mushroom',
            size: [12, 14, 12],
            mirror_x: true,
            ops: [
                {op: 'box', from: [3, 0, 4], to: [5, 8, 7], color: '#efe6d2'},
                {op: 'box', from: [1, 9, 2], to: [5, 10, 9], color: '#c0392b'},
                {op: 'box', from: [2, 11, 3], to: [5, 12, 8], color: '#c0392b'},
                {op: 'box', from: [3, 13, 4], to: [5, 13, 7], color: '#a5301f'},
                {op: 'box', from: [2, 10, 4], to: [2, 10, 5], color: '#ffffff'},
                {op: 'box', from: [4, 12, 6], to: [4, 12, 7], color: '#ffffff'},
                {op: 'box', from: [4, 9, 8], to: [5, 9, 8], color: '#d8cbb0'}
            ]
        })
    },
    building: {
        prompt: 'a stone tower',
        reply: JSON.stringify({
            name: 'tower',
            size: [10, 23, 10],
            mirror_x: false,
            ops: [
                {op: 'box', from: [1, 0, 1], to: [8, 19, 8], color: '#8a8a86'},
                {op: 'box', from: [1, 0, 1], to: [8, 2, 8], color: '#6f6f6b'},
                {op: 'box', from: [0, 20, 0], to: [9, 22, 9], color: '#77776f'},
                {op: 'erase', from: [1, 21, 1], to: [8, 22, 8]},
                {op: 'erase', from: [2, 22, 0], to: [3, 22, 9]},
                {op: 'erase', from: [6, 22, 0], to: [7, 22, 9]},
                {op: 'erase', from: [0, 22, 2], to: [9, 22, 3]},
                {op: 'erase', from: [0, 22, 6], to: [9, 22, 7]},
                {op: 'erase', from: [4, 0, 0], to: [5, 4, 0]},
                {op: 'box', from: [4, 8, 0], to: [5, 10, 0], color: '#2b2b28'},
                {op: 'box', from: [0, 13, 4], to: [0, 15, 5], color: '#2b2b28'},
                {op: 'box', from: [4, 14, 8], to: [5, 16, 8], color: '#2b2b28'}
            ]
        })
    }
}

/**
 * The one call that picks the example, and it is unconstrained on purpose.
 *
 * A one-word answer is inside what the model does reliably. It is asked once per *batch* rather than
 * once per candidate — the body plan is a property of the subject, not of the seed — so it costs
 * about two seconds against ten to twenty for a candidate.
 *
 * Anything unrecognised falls back to `building`, because that example is the only one with no limbs
 * and no implied posture. A wrong `building` is a subject built as a rigid object; a wrong
 * `quadruped` is a fish with legs.
 */
export const PLAN_SYSTEM = `Which body plan does the subject have? Reply with one word only, from this list:

quadruped  - stands on four legs: cat, horse, bear, cow
bird       - stands on two legs: chicken, penguin, owl
plant      - a stalk or trunk under a wider mass: mushroom, tree, flower, coral
building   - architecture, or any rigid made object: tower, house, chest, cart, ship

Answer with the single word and nothing else.`

export const readPlan = (value: string): BodyPlan => {
    const word = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z]/g, '')
    return BODY_PLANS.find(plan => plan === word) ?? 'building'
}

/**
 * Exactly what produced a candidate, stored with the asset it becomes.
 *
 * A generated asset whose seed and sampler were not recorded cannot be reproduced or nudged, only
 * regenerated and hoped over. It travels in the `.gpix` — see `doc/save.ts`.
 */
export interface Sampler {
    readonly temperature: number
    readonly seed: number
}

export interface GenerationRecord {
    readonly prompt: string
    readonly sampler: Sampler
    /** What the server said it was running, so a file records the model rather than the port. */
    readonly model: string
    /** ISO 8601. */
    readonly at: string
    /**
     * Which example the batch was shown. Optional, because a file written before the bank existed
     * has no answer and inventing one would be a lie about what made the model. It is recorded at
     * all because the pick is its own model call: prompt and seed alone no longer reproduce a
     * candidate.
     */
    readonly plan?: BodyPlan
}

export interface Candidate {
    readonly spec: VoxSpec
    readonly volume: Volume
    readonly record: GenerationRecord
}

/** What one attempt produced: a model, or the reason there is not one. */
export type Attempt =
    | {readonly ok: true; readonly candidate: Candidate}
    | {readonly ok: false; readonly error: string}

export interface Llama {
    /** Is the server there? The dialog asks before it offers to spend a minute. */
    readonly probe: () => Promise<string | undefined>
    /** Which worked example this subject should be shown. Once per batch — see `PLAN_SYSTEM`. */
    readonly bodyPlan: (prompt: string, signal?: AbortSignal) => Promise<BodyPlan>
    readonly generate: (
        prompt: string,
        sampler: Sampler,
        plan: BodyPlan,
        signal?: AbortSignal
    ) => Promise<{spec: VoxSpec; model: string}>
}

interface ChatReply {
    choices?: {message?: {content?: string}}[]
    model?: string
}

interface ModelList {
    data?: {id?: string}[]
}

/**
 * 4096, which is roughly ten times the 424 tokens a 12-op tower cost.
 *
 * A grammar-constrained reply that runs out of tokens is truncated *mid-grammar*, so it arrives as
 * unparseable JSON rather than as a short model. The headroom is what makes that not happen.
 */
const MAX_TOKENS = 4096

export const browserLlama = (endpoint: string = DEFAULT_ENDPOINT): Llama => ({
    probe: async () => {
        try {
            const response = await fetch(`${endpoint}/v1/models`)
            if (!response.ok) return undefined
            const body = (await response.json()) as ModelList
            return body.data?.[0]?.id ?? 'unknown'
        } catch {
            // Not running, or not reachable. Both are "no local model" as far as the artist cares.
            return undefined
        }
    },
    bodyPlan: async (prompt, signal) => {
        try {
            const response = await fetch(`${endpoint}/v1/chat/completions`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                ...(signal ? {signal} : {}),
                body: JSON.stringify({
                    messages: [
                        {role: 'system', content: PLAN_SYSTEM},
                        {role: 'user', content: prompt}
                    ],
                    // One word. The headroom above is for a grammar-constrained model, not this.
                    max_tokens: 16,
                    temperature: 0
                })
            })
            if (!response.ok) return 'building'
            const body = (await response.json()) as ChatReply
            return readPlan(body.choices?.[0]?.message?.content ?? '')
        } catch {
            // A failed pick must not sink the batch: the fallback still generates, just generically.
            return 'building'
        }
    },
    generate: async (prompt, sampler, plan, signal) => {
        const example = EXAMPLES[plan]
        const response = await fetch(`${endpoint}/v1/chat/completions`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            ...(signal ? {signal} : {}),
            body: JSON.stringify({
                messages: [
                    {role: 'system', content: SYSTEM},
                    {role: 'user', content: example.prompt},
                    {role: 'assistant', content: example.reply},
                    {role: 'user', content: prompt}
                ],
                max_tokens: MAX_TOKENS,
                temperature: sampler.temperature,
                seed: sampler.seed,
                response_format: {
                    type: 'json_schema',
                    json_schema: {name: 'vox_model', strict: true, schema: VOX_SCHEMA}
                }
            })
        })
        if (!response.ok) {
            throw new Error(`llama-server ${String(response.status)}: ${await response.text()}`)
        }
        const body = (await response.json()) as ChatReply
        const content = body.choices?.[0]?.message?.content
        if (content === undefined || content === '') throw new Error('the server returned nothing')
        let parsed: unknown
        try {
            parsed = JSON.parse(content)
        } catch {
            throw new Error('the reply was not JSON')
        }
        const spec = readSpec(parsed)
        if (!spec) throw new Error('the reply held no usable ops')
        return {spec, model: body.model ?? 'unknown'}
    }
})

/** A canned server, for tests and for nothing else. Replies are handed back in order. */
export const memoryLlama = (
    replies: readonly (VoxSpec | Error)[],
    model = 'memory',
    plan: BodyPlan = 'quadruped'
): Llama & {readonly seen: {prompt: string; sampler: Sampler; plan: BodyPlan}[]} => {
    const seen: {prompt: string; sampler: Sampler; plan: BodyPlan}[] = []
    let next = 0
    return {
        seen,
        probe: () => Promise.resolve(model),
        bodyPlan: () => Promise.resolve(plan),
        generate: (prompt, sampler, shown, signal) => {
            seen.push({prompt, sampler, plan: shown})
            if (signal?.aborted === true) return Promise.reject(new Error('cancelled'))
            const reply = replies[next % Math.max(1, replies.length)]
            next += 1
            if (reply === undefined) return Promise.reject(new Error('no reply'))
            if (reply instanceof Error) return Promise.reject(reply)
            return Promise.resolve({spec: reply, model})
        }
    }
}

export interface GenerateOptions {
    readonly temperature?: number
    /** The seed of the first candidate. The rest count up from it — see below. */
    readonly seed?: number
    readonly signal?: AbortSignal
    /** Called as each attempt lands, so the grid fills in rather than appearing all at once. */
    readonly onAttempt?: (attempt: Attempt, done: number, total: number) => void
    /** Called once, with the example the whole batch will be shown. */
    readonly onPlan?: (plan: BodyPlan) => void
    readonly now?: () => Date
}

export const randomSeed = (): number => Math.floor(Math.random() * 2 ** 31)

/**
 * N candidates for one prompt, in sequence.
 *
 * Sequentially, not in parallel: the server has two slots and shares both GPUs with nothing else,
 * so firing N requests at once buys queueing rather than throughput.
 *
 * Each candidate gets `seed + i` rather than the seed it was given. One seed across N calls at one
 * temperature is one candidate rendered N times — the whole point of generate-and-rank is that the
 * candidates differ — and a caller that pins a seed to reproduce a result gets the same N back,
 * which is what pinning it was for.
 */
export const generateMany = async (
    llama: Llama,
    prompt: string,
    count: number,
    options: GenerateOptions = {}
): Promise<readonly Attempt[]> => {
    const {
        temperature = 0.9,
        seed = randomSeed(),
        signal,
        onAttempt,
        onPlan,
        now = () => new Date()
    } = options
    const attempts: Attempt[] = []
    // Once, before the loop: the body plan belongs to the subject, not to the seed.
    const plan = await llama.bodyPlan(prompt, signal)
    onPlan?.(plan)
    for (let i = 0; i < count; i += 1) {
        if (signal?.aborted === true) break
        const sampler: Sampler = {temperature, seed: seed + i}
        let attempt: Attempt
        try {
            const {spec, model} = await llama.generate(prompt, sampler, plan, signal)
            const volume = rasterise(spec)
            attempt =
                volume.data.some(value => value !== 0) ?
                    {
                        ok: true,
                        candidate: {
                            spec,
                            volume,
                            record: {prompt, sampler, model, plan, at: now().toISOString()}
                        }
                    }
                :   {ok: false, error: 'the model produced no voxels'}
        } catch (error) {
            attempt = {ok: false, error: error instanceof Error ? error.message : String(error)}
        }
        attempts.push(attempt)
        onAttempt?.(attempt, i + 1, count)
    }
    return attempts
}

export const candidatesOf = (attempts: readonly Attempt[]): readonly Candidate[] =>
    attempts.filter(attempt => attempt.ok).map(attempt => attempt.candidate)
