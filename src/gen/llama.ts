import {rasterise, type VoxSpec} from './ops'
import {specFromCode} from './code'
import {finish} from './finish'
import type {Volume} from '../render/volume'

/**
 * The half of generation that talks to llama-server on `localhost:8080`.
 *
 * A port, like `doc/store.ts` and `doc/files.ts`, and for the same reason: the logic worth testing
 * is which seeds get used, what happens to a candidate that fails and whether a cancel is honoured
 * — none of which should need a 27B model loaded to check. `browserLlama` is the real one;
 * `memoryLlama` is what `bun test` drives.
 *
 * The reply is JavaScript, not schema-constrained JSON, and that is measured, not taste
 * (2026-08-08, live server): the JSON grammar starts the reply on its first op token, so the model
 * has nowhere to think, and prose rules do not survive that. Asked for code it writes a proportions
 * comment first and uses loops for repetition, and its cats were named as animals 4 of 4 against
 * 2 of 4 for the JSON path. `specFromCode` runs the reply and narrows it — see the comments there.
 *
 * No streaming and no retries. A candidate that fails is one of N and is reported as a failure
 * rather than quietly replaced, because a silent retry hides a prompt that has stopped working.
 */
export const DEFAULT_ENDPOINT = 'http://localhost:8080'

export const SYSTEM = `You write JavaScript that builds a voxel model. These functions exist already:
  box(x0,y0,z0, x1,y1,z1, "#rrggbb")   solid box, inclusive integer bounds
  ball(x,y,z, rx,ry,rz, "#rrggbb")     axis-aligned ellipsoid
  erase(x0,y0,z0, x1,y1,z1)            carve empty space
  mirrorX()                            call last to mirror the model across its centre in x

Axes: x = left/right, y = up/down (bigger y is higher), z = front/back. Feet at y=0.
Keep everything inside 32x32x32. Use variables and loops where they help symmetry and repetition.
Ops apply in order; later calls paint over earlier ones.
Block out the big masses first, then carve with erase, then add small details.
Use 4-8 distinct colors with real value contrast, not near-identical shades.
Plan the proportions in a short comment first, then the code.
Answer with only JavaScript, no markdown fence.`

/**
 * One worked answer per body plan, handed over as a prior turn rather than quoted in the system
 * prompt.
 *
 * The example is worth more than every rule in `SYSTEM` put together, measured 2026-08-08. Rules
 * alone gave upright blobs; one example took "a cat" from 0 of 12 recognisable to 4 of 4. Measured
 * again the same day in the code format: the example is the ceiling as well as the floor — a
 * deliberately worse hand example dragged every output down to its own flaws.
 *
 * There is one per body plan because one is not neutral. With only the dog in the prompt, **"a
 * chicken" came back with four legs** and "a fish" came back a slab — the example teaches the
 * answer's shape, and a subject whose shape is different gets dragged. `humanoid` earned its slot
 * the same way: with the building example a knight was a grey blob or emitted nothing at all, and
 * with the farmer, 3 of 3 seeds gave an armored figure with sword and shield.
 *
 * Each demonstrates the language once — a proportions comment first, loops for repeated limbs,
 * feet at `y = 0`, parts that touch, a palette with real value contrast — and `building` is the
 * one that carves with `erase`, which is why it is a battlemented tower and not a box.
 *
 * **If you change one, render it.** `llama.test.ts` holds them to being one connected piece that is
 * not a solid brick, but only your eyes can say whether the dog looks like a dog, and an example
 * that does not look like what it claims teaches exactly that.
 */
export type BodyPlan = 'quadruped' | 'bird' | 'humanoid' | 'plant' | 'building'

export const BODY_PLANS: readonly BodyPlan[] = [
    'quadruped',
    'bird',
    'humanoid',
    'plant',
    'building'
]

export const EXAMPLES: Readonly<
    Record<BodyPlan, {readonly prompt: string; readonly reply: string}>
> = {
    quadruped: {
        prompt: 'a dog',
        reply: `// dog: body 3 wide, 5 tall, 12 long; head at the front-top; legs at the corners
const fur = '#8b5a2b', light = '#a0693a', dark = '#6f4520'
box(1,5,3, 6,9,14, fur)          // body
box(1,8,14, 6,11,17, light)      // head
for (const z of [4, 12]) {       // legs, front and back pairs
    box(1,1,z, 2,5,z+1, fur)
    box(5,1,z, 6,5,z+1, fur)
}
box(1,11,14, 1,12,15, dark)      // left ear
box(6,11,14, 6,12,15, dark)      // right ear
box(3,9,17, 4,10,17, '#2b1a0d')  // nose
box(3,8,2, 4,11,3, light)        // tail`
    },
    bird: {
        prompt: 'a chicken',
        reply: `// chicken: round body on two legs, small head high at the front, comb and beak
const body = '#f2e3c8', wing = '#d8c4a0', leg = '#e08a2c'
box(2,5,3, 6,10,8, body)         // body
box(1,6,4, 1,9,7, wing)          // left wing
box(7,6,4, 7,9,7, wing)          // right wing
box(2,10,2, 6,13,2, wing)        // tail, angled up
box(3,11,6, 5,13,8, body)        // head
box(4,14,6, 4,14,7, '#cc2b2b')   // comb
box(4,11,9, 4,12,9, leg)         // beak
box(3,12,8, 3,12,8, '#2b2b28')   // eye
box(5,12,8, 5,12,8, '#2b2b28')   // eye
for (const x of [3, 5]) box(x,0,5, x,4,6, leg)  // two legs`
    },
    humanoid: {
        prompt: 'a farmer',
        reply: `// farmer: 24 tall; legs 0-9, torso 10-17, head 18-23; arms hang at the sides
const skin = '#e0b088', shirt = '#4a7a3a', pants = '#5a4632', hat = '#d8b84a'
box(5,0,5, 7,9,7, pants)          // left leg
box(9,0,5, 11,9,7, pants)         // right leg
box(4,10,4, 12,17,8, shirt)       // torso
box(2,10,5, 3,16,7, shirt)        // left arm
box(13,10,5, 14,16,7, shirt)      // right arm
box(2,8,5, 3,9,7, skin)           // left hand
box(13,8,5, 14,9,7, skin)         // right hand
box(6,18,4, 10,22,8, skin)        // head
box(5,22,3, 11,23,9, hat)         // hat brim
box(6,23,4, 10,23,8, hat)         // hat top
box(7,20,4, 7,20,4, '#2b2b28')    // left eye
box(9,20,4, 9,20,4, '#2b2b28')    // right eye`
    },
    plant: {
        prompt: 'a red mushroom',
        reply: `// mushroom: pale stalk, wide red cap in shrinking tiers, white spots
box(4,0,4, 7,8,7, '#efe6d2')     // stalk
box(1,9,2, 10,10,9, '#c0392b')   // cap, widest tier
box(2,11,3, 9,12,8, '#c0392b')
box(3,13,4, 8,13,7, '#a5301f')   // cap top
box(2,10,4, 2,10,5, '#ffffff')   // spots
box(8,12,6, 8,12,7, '#ffffff')
box(4,9,8, 6,9,8, '#d8cbb0')     // gill hint`
    },
    building: {
        prompt: 'a stone tower',
        reply: `// tower: tall shaft, battlemented top ring, door and windows
box(1,0,1, 8,19,8, '#8a8a86')    // shaft
box(1,0,1, 8,2,8, '#6f6f6b')     // base course
box(0,20,0, 9,22,9, '#77776f')   // top slab
erase(1,21,1, 8,22,8)            // hollow the ring
for (const c of [2, 6]) {        // battlement gaps on all four sides
    erase(c,22,0, c+1,22,9)
    erase(0,22,c, 9,22,c+1)
}
erase(4,0,0, 5,4,0)              // door
box(4,8,0, 5,10,0, '#2b2b28')    // windows
box(0,13,4, 0,15,5, '#2b2b28')
box(4,14,8, 5,16,8, '#2b2b28')`
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
bird       - a bird on two legs: chicken, penguin, owl
humanoid   - a person on two legs with arms: knight, farmer, wizard, robot
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
 * 4096, which is roughly ten times what a measured code reply cost (170–600 characters).
 *
 * A reply that runs out of tokens is truncated mid-line; `specFromCode` keeps the ops the whole
 * lines painted, so truncation degrades to a partial model rather than to nothing. The headroom is
 * what makes even that rare.
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
                seed: sampler.seed
            })
        })
        if (!response.ok) {
            throw new Error(`llama-server ${String(response.status)}: ${await response.text()}`)
        }
        const body = (await response.json()) as ChatReply
        const content = body.choices?.[0]?.message?.content
        if (content === undefined || content === '') throw new Error('the server returned nothing')
        const spec = specFromCode(content, prompt)
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
                            // Shaded here, not stored: the spec stays flat-coloured, and
                            // rasterise-then-finish reproduces the asset from the record exactly.
                            volume: finish(volume),
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
