/*
 * The pair test on real candidates, where nothing is obviously broken.
 *
 *     bun docs/spikes/vision/real.ts ["a cat"] [count]
 *
 * `pairs.ts` proved the model can spot a model with its top half floating. That is damage detection,
 * not taste, and the question the pipeline actually has is whether it can choose between two seeds.
 * There is no ground truth for that and inventing one would be an opinion, so this measures the two
 * things that need none:
 *
 * 1. **Does the answer survive a swap?** Every pair is asked twice, with the two candidates
 *    exchanged. A judge that names a different model when the pictures change places is noise, and
 *    that is true whatever its taste is like. A coin flips half the time; this is the number to beat.
 * 2. **Does it say anything `score.ts` does not?** The deterministic score is free and already
 *    ordered the grid. If the vision judge agrees with it pairwise, it is an expensive way to
 *    recompute something; if it disagrees, neither is proven right, but the call is at least saying
 *    something new.
 *
 * Generation here is deliberately hand-rolled rather than `generateMany` — it needs no bank, no
 * picking call and no flags, so what varies between candidates is the seed and nothing else.
 */
import {BUILT_IN_REPLIES} from '../../../src/gen/builtin'
import {specFromCode} from '../../../src/gen/code'
import {finish} from '../../../src/gen/finish'
import {rasterise} from '../../../src/gen/ops'
import {systemFor} from '../../../src/gen/llama'
import {overallScore, scoreModel} from '../../../src/gen/score'
import {askOnce, ENDPOINT, imagePart, textPart, type Part} from './server'
import {base64For, VIEW_SETS} from './views'
import type {Volume} from '../../../src/render/volume'

const SIZE = 96
const SET = 'fiveIso' as const

const prompt = process.argv[2] ?? 'a cat'
const count = Number(process.argv[3] ?? 4)

/** Which built-in example teaches this subject. Fixed here rather than asked, so only the seed varies. */
const TEACHER: Readonly<Record<string, string>> = {
    'a cat': 'dog',
    'a stone tower': 'tower',
    'a fish': 'dog',
    'a knight': 'farmer'
}

interface ChatReply {
    choices?: {message?: {content?: string}}[]
}

const generate = async (seed: number): Promise<Volume | undefined> => {
    const teacher = TEACHER[prompt] ?? 'dog'
    const example = BUILT_IN_REPLIES[teacher]
    const messages = [
        {role: 'system', content: systemFor(32)},
        ...(example === undefined ?
            []
        :   [
                {role: 'user', content: `a ${teacher}`},
                {role: 'assistant', content: example}
            ]),
        {role: 'user', content: prompt}
    ]
    const response = await fetch(`${ENDPOINT}/v1/chat/completions`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({messages, max_tokens: 4096, temperature: 0.9, seed})
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as ChatReply
    const spec = specFromCode(body.choices?.[0]?.message?.content ?? '', prompt, 32)
    if (!spec) return undefined
    const flat = rasterise(spec)
    return flat.data.some(value => value !== 0) ? finish(flat) : undefined
}

const choose = async (first: Volume, second: Volume): Promise<string> => {
    const views = VIEW_SETS[SET] ?? []
    const parts: Part[] = [
        textPart(
            `Two voxel models were built for the same request: "${prompt}". Here is Model A, then Model B.`
        )
    ]
    for (const [label, volume] of [
        ['A', first],
        ['B', second]
    ] as const) {
        for (const view of views) {
            parts.push(textPart(`Model ${label} — ${view.label}:`))
            parts.push(imagePart(await base64For(volume, view, SIZE)))
        }
    }
    parts.push(
        textPart(
            `Which one is the better ${prompt.replace(/^an? /, '')}? Answer with a single letter, A or B.`
        )
    )
    return (await askOnce(parts, 8, ['A', 'B'])).said.trim().toUpperCase()
}

process.stdout.write(`generating ${String(count)} candidates for "${prompt}"\n`)
const candidates: {volume: Volume; score: number; seed: number}[] = []
for (let i = 0; i < count; i += 1) {
    const seed = 4200 + i
    const volume = await generate(seed)
    if (!volume) {
        process.stdout.write(`  seed ${String(seed)}: no usable ops\n`)
        continue
    }
    const score = overallScore(scoreModel(volume))
    candidates.push({volume, score, seed})
    process.stdout.write(`  seed ${String(seed)}: score ${score.toFixed(3)}\n`)
}

if (candidates.length < 2) {
    process.stdout.write('not enough candidates to pair\n')
    process.exit(0)
}

process.stdout.write('\npairs, each asked both ways round:\n')
let stable = 0
let total = 0
let agreesWithScore = 0
let scored = 0
for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
        const one = candidates[i]
        const two = candidates[j]
        if (!one || !two) continue
        const forward = await choose(one.volume, two.volume)
        const backward = await choose(two.volume, one.volume)
        // Same *model* named both times, not the same letter.
        const consistent = (forward === 'A') === (backward === 'B')
        total += 1
        if (consistent) stable += 1
        if (consistent) {
            const preferred = forward === 'A' ? one : two
            const higher = one.score >= two.score ? one : two
            scored += 1
            if (preferred.seed === higher.seed) agreesWithScore += 1
        }
        process.stdout.write(
            `  ${String(one.seed)} vs ${String(two.seed)}   said ${forward} then ${backward}   ${consistent ? 'consistent' : 'FLIPPED'}   scores ${one.score.toFixed(3)} / ${two.score.toFixed(3)}\n`
        )
    }
}

process.stdout.write(
    `\nsurvived the swap: ${String(stable)} of ${String(total)} (${((100 * stable) / Math.max(1, total)).toFixed(0)} %) — a coin manages 50 %\n`
)
process.stdout.write(
    `agreed with overallScore, on the consistent pairs: ${String(agreesWithScore)} of ${String(scored)}\n`
)
