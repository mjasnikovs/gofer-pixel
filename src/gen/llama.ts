import {VOX_SCHEMA, rasterise, type VoxSpec} from './ops'
import type {VoxModel} from '../vox/model'

/**
 * The browser half of the generation pipeline: talk to the llama-server on `localhost:8080`,
 * with the JSON schema in `response_format` so decoding is grammar-constrained and a malformed
 * reply cannot be produced (`PRODUCTION_PLAN.md` §9 fix 1, measured against the live server).
 *
 * No streaming and no retries. A candidate that fails is one of N and is reported as a failure
 * rather than quietly replaced, because a silent retry hides a prompt that has stopped working.
 */
export const DEFAULT_ENDPOINT = 'http://localhost:8080/v1/chat/completions'

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
 * This is `DESIGN_PROGRESS.md`'s open question 5 — a generated asset whose seed and sampler are
 * not recorded cannot be reproduced or nudged, only regenerated and hoped over.
 */
export interface Sampler {
    temperature: number
    seed: number
    topP?: number
    topK?: number
}

export interface GenerationRecord {
    prompt: string
    sampler: Sampler
    model: string
    at: string
}

export interface Candidate {
    spec: VoxSpec
    voxels: VoxModel
    record: GenerationRecord
}

export interface GenerateOptions {
    endpoint?: string
    sampler?: Partial<Sampler>
    maxTokens?: number
    signal?: AbortSignal
}

interface ChatReply {
    choices?: {message?: {content?: string}}[]
    model?: string
}

/** One candidate. Throws on a transport failure or on a reply that is not a usable model. */
export const generateOne = async (
    prompt: string,
    {endpoint = DEFAULT_ENDPOINT, sampler = {}, maxTokens = 4096, signal}: GenerateOptions = {}
): Promise<Candidate> => {
    const used: Sampler = {
        temperature: sampler.temperature ?? 0.8,
        seed: sampler.seed ?? Math.floor(Math.random() * 2 ** 31),
        ...(sampler.topP === undefined ? {} : {topP: sampler.topP}),
        ...(sampler.topK === undefined ? {} : {topK: sampler.topK})
    }

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        ...(signal ? {signal} : {}),
        body: JSON.stringify({
            messages: [
                {role: 'system', content: SYSTEM},
                {role: 'user', content: prompt}
            ],
            max_tokens: maxTokens,
            temperature: used.temperature,
            seed: used.seed,
            ...(used.topP === undefined ? {} : {top_p: used.topP}),
            ...(used.topK === undefined ? {} : {top_k: used.topK}),
            response_format: {
                type: 'json_schema',
                json_schema: {name: 'vox_model', strict: true, schema: VOX_SCHEMA}
            }
        })
    })

    if (!response.ok) {
        throw new Error(`llama-server ${String(response.status)}: ${await response.text()}`)
    }
    const reply = (await response.json()) as ChatReply
    const content = reply.choices?.[0]?.message?.content
    if (content === undefined || content === '') {
        throw new Error('llama-server returned no content')
    }

    // the grammar guarantees the shape, so this is a parse rather than a repair
    const spec = JSON.parse(content) as VoxSpec
    const voxels = rasterise(spec)
    if (voxels.voxels.size === 0) {
        throw new Error('model produced no voxels')
    }
    return {
        spec,
        voxels,
        record: {
            prompt,
            sampler: used,
            model: reply.model ?? 'unknown',
            at: new Date().toISOString()
        }
    }
}

export interface GenerateManyResult {
    candidates: Candidate[]
    failures: string[]
}

/**
 * N candidates for one prompt, in sequence.
 *
 * Sequentially, not in parallel: the server has two slots and shares both GPUs with nothing else,
 * so firing N requests at once buys queueing, not throughput. `onProgress` is how the panel shows
 * the grid filling in rather than freezing for a minute.
 */
export const generateMany = async (
    prompt: string,
    count: number,
    options: GenerateOptions & {onProgress?: (done: number, total: number) => void} = {}
): Promise<GenerateManyResult> => {
    const candidates: Candidate[] = []
    const failures: string[] = []
    for (let i = 0; i < count; i += 1) {
        try {
            candidates.push(await generateOne(prompt, options))
        } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error))
        }
        options.onProgress?.(i + 1, count)
    }
    return {candidates, failures}
}
