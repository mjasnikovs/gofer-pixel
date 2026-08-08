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

Axes: x = length/width, y = depth, z = up. Origin is the min corner.
Ops are applied in order; later ops paint over earlier ones.
  {"op":"box","from":[x,y,z],"to":[x,y,z],"color":"#rrggbb"}   inclusive bounds
  {"op":"ball","at":[x,y,z],"r":[rx,ry,rz],"color":"#rrggbb"}  axis-aligned ellipsoid
  {"op":"erase","from":[x,y,z],"to":[x,y,z]}                   carve empty space

Rules:
- Keep size within 32x32x32 and use at most 40 ops.
- If mirror_x is true, only model x < sx/2; the other half is generated.
- Build in readable layers: the object must look correct sliced horizontally,
  so avoid overhangs that would leave a slice floating and unreadable.
- Use 4-8 distinct colors with real value contrast, not near-identical shades.`

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
    readonly generate: (
        prompt: string,
        sampler: Sampler,
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
    generate: async (prompt, sampler, signal) => {
        const response = await fetch(`${endpoint}/v1/chat/completions`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            ...(signal ? {signal} : {}),
            body: JSON.stringify({
                messages: [
                    {role: 'system', content: SYSTEM},
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
    model = 'memory'
): Llama & {readonly seen: {prompt: string; sampler: Sampler}[]} => {
    const seen: {prompt: string; sampler: Sampler}[] = []
    let next = 0
    return {
        seen,
        probe: () => Promise.resolve(model),
        generate: (prompt, sampler, signal) => {
            seen.push({prompt, sampler})
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
        now = () => new Date()
    } = options
    const attempts: Attempt[] = []
    for (let i = 0; i < count; i += 1) {
        if (signal?.aborted === true) break
        const sampler: Sampler = {temperature, seed: seed + i}
        let attempt: Attempt
        try {
            const {spec, model} = await llama.generate(prompt, sampler, signal)
            const volume = rasterise(spec)
            attempt =
                volume.data.some(value => value !== 0) ?
                    {
                        ok: true,
                        candidate: {
                            spec,
                            volume,
                            record: {prompt, sampler, model, at: now().toISOString()}
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
