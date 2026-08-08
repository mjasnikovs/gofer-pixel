import {ISOMETRIC_PITCH} from '../doc/cameras'
import {encodePng} from '../image/png'
import {basisFor, createCamera} from '../render/camera'
import {render} from '../render/raycast'
import type {Volume} from '../render/volume'
import {DEFAULT_ENDPOINT} from './llama'
import {onGrey, toBase64} from './views'

/**
 * What a candidate reads as, in the vision model's own words.
 *
 * **It was built as a veto and it is not one.** Measured 2026-08-08 over 8 cats and 8 knights
 * against the live server, and written up in `docs/GEN_RESEARCH.md`: rejecting the candidates whose
 * word does not match the prompt threw away a cat with ears and an upright tail for being called
 * "dog", and the best knight of eight for being called "santa". `pass` is still computed and still
 * honest about what it means — it is what the measurement was of — but nothing in the app sorts,
 * hides or marks a candidate by it. The *word* is what ships, because a knight that reads as
 * "santa" tells the artist which part of the sprite is wrong.
 *
 * A port, like `llama.ts`: `browserVeto` talks to the server, `memoryVeto` hands back canned words
 * for `bun test`. The interesting logic — which word counts as the subject, what happens when the
 * model will not answer — is in `judge`, on this side of the seam, and needs no model loaded.
 *
 * The phrasing is measured, 2026-08-08, and none of it is free choice:
 *
 * - **One render, not a strip.** A neutral question over the four ranking views comes back "no" for
 *   everything, good models included.
 * - **Open naming, never yes/no about the subject.** "Is this recognisable as a cat?" answers yes
 *   for garbage — the framing decides. Asked what it depicts, the model said "robot" for a blob and
 *   "lever" for a slab that was meant to be a ship, and "cat"/"dog" for good cats.
 * - **Temperature 0**, because this is a measurement and not a candidate.
 *
 * The naming is honest about the picture and useless as a key: "dog" came back for a real cat and
 * for a real dog in the same batch of eight, so no phrasing of a word-level match can separate
 * them. The match below is as generous as it can be made and every uncertainty **fails open**; it
 * is still not a gate, and the measurement is why.
 */
export const NAMING_QUESTION =
    'This is a voxel model. What does it depict? Answer with one or two words.'

/**
 * 224 px, which is what the vision tower resizes to anyway. The ranking views are 64 px because
 * there are four of them per candidate and CLIP downsamples; this is one image per candidate and the
 * model is being asked to recognise a shape, so it is rendered at the size it will be looked at.
 */
export const NAMING_SIZE = 224

/** The three-quarter view. A tower seen square-on is a rectangle, and so is a knight. */
export const NAMING_YAW = Math.PI / 4

/** The one picture the judge is shown, as a base64 PNG. */
export const namingView = async (volume: Volume, size: number = NAMING_SIZE): Promise<string> => {
    const basis = basisFor(createCamera(volume, NAMING_YAW, ISOMETRIC_PITCH), volume, size)
    const target = render(volume, basis, size, size)
    return toBase64(await encodePng(size, size, onGrey(target.color)))
}

export interface Veto {
    /** What the model calls this shape, in one or two words. `''` if it would not say. */
    readonly name: (volume: Volume, signal?: AbortSignal) => Promise<string>
    /**
     * Could that word describe this prompt? Text only, and only asked when the words did not match
     * outright — the sycophancy finding was about images, but this is still a yes/no and it is kept
     * off the fast path.
     */
    readonly couldDescribe: (word: string, prompt: string, signal?: AbortSignal) => Promise<boolean>
}

/** Why a candidate passed or did not. Counted in the status line; it moves nothing. */
export type VetoWhy =
    /** The word is in the prompt. No second call was needed. */
    | 'named'
    /** The words differ and the model said the word still describes the prompt. */
    | 'agreed'
    /** The words differ and the model said no. The only verdict that fails. */
    | 'wrong'
    /** The model answered with nothing. */
    | 'silent'
    /** The server could not be asked. */
    | 'unavailable'

export interface Verdict {
    readonly word: string
    readonly pass: boolean
    readonly why: VetoWhy
}

/**
 * Articles and the words a prompt uses to mean "make one of these". Dropped before matching so that
 * "a cat" and "cat" are the same subject, and so that "a" never matches anything.
 */
const FILLER = new Set([
    'a',
    'an',
    'the',
    'of',
    'with',
    'and',
    'in',
    'on',
    'some',
    'my',
    'one',
    'model',
    'voxel',
    'sprite'
])

/** Crude and deliberate: only the trailing `s`, so `knights` is `knight` and `grass` is `grass`. */
const singular = (word: string): string =>
    word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word

const words = (value: string): readonly string[] =>
    value
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter(word => word !== '' && !FILLER.has(word))
        .map(singular)

/**
 * The model's answer, narrowed to at most two words.
 *
 * It is asked for one or two and usually gives them, but "a cat" and "It depicts a cat." both
 * happen. Anything longer than a short phrase is the model refusing the format, and the extra words
 * are hedging rather than subject.
 *
 * The last two, not the first two: English puts the head noun at the end, so "a small grey robot"
 * is a robot and "a robot toy" is a toy.
 */
export const readName = (value: string): string => {
    const found = value
        .toLowerCase()
        .replace(/[^a-z\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word !== '' && !FILLER.has(word))
    return found.length > 4 ? '' : found.slice(-2).join(' ')
}

/**
 * Does the word already say the subject, without asking the server again?
 *
 * Generous on purpose. Substring either way, because "towers" for "a stone tower" and "cathouse"
 * for "a cat" are both the model seeing the right thing; the length floor is what stops "a" and
 * "cat"/"cart" from colliding.
 */
export const namesTheSubject = (word: string, prompt: string): boolean => {
    const said = words(word)
    const asked = words(prompt)
    return said.some(one =>
        asked.some(
            other =>
                one === other
                || (one.length >= 4 && other.includes(one))
                || (other.length >= 4 && one.includes(other))
        )
    )
}

/**
 * One candidate, named.
 *
 * Every failure path passes: nothing here is worth a candidate the artist never sees, and after the
 * measurement above that is doubly true.
 */
export const judge = async (
    veto: Veto,
    volume: Volume,
    prompt: string,
    signal?: AbortSignal
): Promise<Verdict> => {
    let word: string
    try {
        word = await veto.name(volume, signal)
    } catch {
        return {word: '', pass: true, why: 'unavailable'}
    }
    if (word === '') return {word, pass: true, why: 'silent'}
    if (namesTheSubject(word, prompt)) return {word, pass: true, why: 'named'}
    try {
        const agreed = await veto.couldDescribe(word, prompt, signal)
        return {word, pass: agreed, why: agreed ? 'agreed' : 'wrong'}
    } catch {
        return {word, pass: true, why: 'unavailable'}
    }
}

interface ChatReply {
    choices?: {message?: {content?: string}}[]
}

/** One or two words, and nothing here needs more. */
const MAX_TOKENS = 24

const ask = async (
    endpoint: string,
    messages: readonly unknown[],
    signal?: AbortSignal
): Promise<string> => {
    const response = await fetch(`${endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        ...(signal ? {signal} : {}),
        body: JSON.stringify({messages, max_tokens: MAX_TOKENS, temperature: 0})
    })
    if (!response.ok) throw new Error(`llama-server ${String(response.status)}`)
    const body = (await response.json()) as ChatReply
    return body.choices?.[0]?.message?.content ?? ''
}

export const browserVeto = (endpoint: string = DEFAULT_ENDPOINT): Veto => ({
    name: async (volume, signal) => {
        const png = await namingView(volume)
        const said = await ask(
            endpoint,
            [
                {
                    role: 'user',
                    content: [
                        {type: 'image_url', image_url: {url: `data:image/png;base64,${png}`}},
                        {type: 'text', text: NAMING_QUESTION}
                    ]
                }
            ],
            signal
        )
        return readName(said)
    },
    couldDescribe: async (word, prompt, signal) => {
        const said = await ask(
            endpoint,
            [
                {
                    role: 'user',
                    content: `Could "${word}" describe ${prompt}? Answer yes or no.`
                }
            ],
            signal
        )
        return /\byes\b/i.test(said)
    }
})

/** A canned judge, for tests. Names are handed back in order and then cycle. */
export const memoryVeto = (
    names: readonly (string | Error)[],
    agrees = false
): Veto & {readonly seen: {word: string; prompt: string}[]} => {
    const seen: {word: string; prompt: string}[] = []
    let next = 0
    return {
        seen,
        name: () => {
            const said = names[next % Math.max(1, names.length)]
            next += 1
            if (said instanceof Error) return Promise.reject(said)
            return Promise.resolve(readName(said ?? ''))
        },
        couldDescribe: (word, prompt) => {
            seen.push({word, prompt})
            return Promise.resolve(agrees)
        }
    }
}
