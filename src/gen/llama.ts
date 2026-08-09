import {rasterise, type VoxSpec} from './ops'
import {pickPrompt, readPicks, type Manifest, type WorkedExample} from './bank'
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
     * Which examples the batch was shown, closest first. Optional, because a file written before
     * the bank existed has no answer and inventing one would be a lie about what made the model.
     * It is recorded at all because the pick is its own model call: prompt and seed alone no
     * longer reproduce a candidate.
     *
     * A file written when the bank was five fixed body plans holds one id, which is exactly what it
     * was shown, so an old record reads as a one-element list rather than as a gap.
     */
    readonly examples?: readonly string[]
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
    /**
     * Which worked examples this subject should be shown, closest first. Once per batch — the
     * answer is a property of the subject, not of the seed. See `bank.ts`'s `pickPrompt`.
     */
    readonly pick: (prompt: string, signal?: AbortSignal) => Promise<readonly string[]>
    readonly generate: (
        prompt: string,
        sampler: Sampler,
        examples: readonly WorkedExample[],
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

/**
 * The real one. It needs the manifest because the picking call's prompt *is* the manifest — the
 * list of ids and what each is for, rendered by `pickPrompt`.
 */
export const browserLlama = (manifest: Manifest, endpoint: string = DEFAULT_ENDPOINT): Llama => ({
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
    pick: async (prompt, signal) => {
        try {
            const response = await fetch(`${endpoint}/v1/chat/completions`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                ...(signal ? {signal} : {}),
                body: JSON.stringify({
                    messages: [
                        {role: 'system', content: pickPrompt(manifest)},
                        {role: 'user', content: prompt}
                    ],
                    // A short list of ids. The headroom below is for a model that draws.
                    max_tokens: 32,
                    temperature: 0
                })
            })
            if (!response.ok) return [manifest.fallback]
            const body = (await response.json()) as ChatReply
            return readPicks(body.choices?.[0]?.message?.content ?? '', manifest)
        } catch {
            // A failed pick must not sink the batch: the fallback still generates, just generically.
            return [manifest.fallback]
        }
    },
    generate: async (prompt, sampler, examples, signal) => {
        const response = await fetch(`${endpoint}/v1/chat/completions`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            ...(signal ? {signal} : {}),
            body: JSON.stringify({
                messages: [
                    {role: 'system', content: SYSTEM},
                    // Each example is a completed exchange. The last one sits against the prompt,
                    // which is the position the model imitates hardest — see `Library.teach`.
                    ...examples.flatMap(example => [
                        {role: 'user', content: example.prompt},
                        {role: 'assistant', content: example.reply}
                    ]),
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

/** What `memoryLlama` recorded about one call, so a test can assert on what was sent. */
export interface SeenCall {
    readonly prompt: string
    readonly sampler: Sampler
    readonly examples: readonly WorkedExample[]
}

/** A canned server, for tests and for nothing else. Replies are handed back in order. */
export const memoryLlama = (
    replies: readonly (VoxSpec | Error)[],
    model = 'memory',
    picks: readonly string[] = ['dog']
): Llama & {readonly seen: SeenCall[]} => {
    const seen: SeenCall[] = []
    let next = 0
    return {
        seen,
        probe: () => Promise.resolve(model),
        pick: () => Promise.resolve(picks),
        generate: (prompt, sampler, examples, signal) => {
            seen.push({prompt, sampler, examples})
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
    /** Called once, with the ids of the examples the whole batch will be shown. */
    readonly onPick?: (ids: readonly string[]) => void
    /**
     * Ids into the examples they teach with, in the order they should be sent.
     *
     * A function rather than the bank itself, because the app composes two sources: the bank on
     * disk and whatever model the artist dropped on the dialog. Defaults to teaching nothing, which
     * is a worse model and never a broken one.
     */
    readonly teach?: (ids: readonly string[]) => readonly WorkedExample[]
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
        onPick,
        teach = () => [],
        now = () => new Date()
    } = options
    const attempts: Attempt[] = []
    // Once, before the loop: which example fits belongs to the subject, not to the seed.
    const picked = await llama.pick(prompt, signal)
    onPick?.(picked)
    const examples = teach(picked)
    for (let i = 0; i < count; i += 1) {
        if (signal?.aborted === true) break
        const sampler: Sampler = {temperature, seed: seed + i}
        let attempt: Attempt
        try {
            const {spec, model} = await llama.generate(prompt, sampler, examples, signal)
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
                            record: {
                                prompt,
                                sampler,
                                model,
                                examples: picked,
                                at: now().toISOString()
                            }
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
