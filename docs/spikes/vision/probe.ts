/*
 * The five questions, and the only scoring rule: an answer is one option from a closed list, matched
 * as a whole word. Anything that matches none of them, or two of them, is `unparsed` — reported
 * separately and counted as wrong, never quietly rounded toward the truth.
 *
 * A **no-image control** runs the same questions with the pictures taken out. Without it a score is
 * a number with no floor: "which axis is longest" has three options and a blind model that always
 * says "height" scores 33 % on a corpus where a third of the shapes are tall.
 */
import {base64For, stripFor, VIEW_SETS, type View} from './views'
import {imagePart, textPart, type Part} from './server'
import {NAMES, type Truth} from './shapes'
import {toBase64} from '../../../src/image/base64'
import type {Volume} from '../../../src/render/volume'

export type QuestionId = 'name' | 'parts' | 'longest' | 'mark' | 'floating'

export interface Question {
    readonly id: QuestionId
    /** What the model is asked, after the pictures. */
    readonly ask: string
    readonly options: readonly string[]
    /** The right answer for this shape, or `undefined` when the shape does not answer this question. */
    readonly answer: (truth: Truth) => string | undefined
    readonly maxTokens: number
}

const NUMBER_WORDS: Readonly<Record<string, string>> = {
    one: '1',
    two: '2',
    three: '3',
    four: '4',
    five: '5'
}

export const QUESTIONS: readonly Question[] = [
    {
        id: 'name',
        ask: `Which of these does the shape look most like? Answer with exactly one word from this list and nothing else: ${NAMES.join(', ')}.`,
        options: NAMES,
        answer: truth => truth.name,
        maxTokens: 96
    },
    {
        id: 'parts',
        ask: 'How many separate pieces is this shape made of — pieces that do not touch each other at all? Answer with a single digit and nothing else.',
        options: ['1', '2', '3', '4', '5'],
        answer: truth => (truth.parts <= 5 ? String(truth.parts) : undefined),
        maxTokens: 96
    },
    {
        id: 'longest',
        ask: 'Which measurement of this shape is the largest: its width (left to right), its height (bottom to top), or its depth (front to back)? Answer with exactly one word: width, height, or depth.',
        options: ['width', 'height', 'depth'],
        answer: truth => truth.longest,
        maxTokens: 96
    },
    {
        id: 'mark',
        ask: 'One patch of this shape is red. Which side of the shape is the red patch on? Answer with exactly one word: front, back, left, or right.',
        options: ['front', 'back', 'left', 'right'],
        answer: truth => truth.mark,
        maxTokens: 96
    },
    {
        id: 'floating',
        ask: 'Is any part of this shape floating in the air, not resting on the ground and not touching the rest of the shape? Answer yes or no.',
        options: ['yes', 'no'],
        answer: truth => (truth.floating ? 'yes' : 'no'),
        maxTokens: 96
    }
]

/**
 * The reply, narrowed to one option or to nothing.
 *
 * Whole-word matching over a normalised string, so "l-shape" and "L shape" are the same answer and
 * "no" never matches inside "nothing". Two different options in one reply is a refusal to choose and
 * is not scored as either.
 */
export const readAnswer = (said: string, options: readonly string[]): string | undefined => {
    const words = said
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(' ')
        .map(word => NUMBER_WORDS[word] ?? word)
    const hits = new Set<string>()
    for (const option of options) {
        const wanted = option.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
        for (let i = 0; i + wanted.length <= words.length; i += 1) {
            if (wanted.every((part, k) => words[i + k] === part)) {
                hits.add(option)
                break
            }
        }
    }
    return hits.size === 1 ? [...hits][0] : undefined
}

export type Mode = 'separate' | 'strip' | 'blind'

/*
 * 96 tokens for a one-word answer, and that number is a repair.
 *
 * At 8 tokens the six-view condition scored 42 % on "is anything floating" with four replies
 * `unparsed` — and the raw text says why: "Based on the provided views…". More pictures made the
 * model preface its answer, and the cap cut the answer off. A truncated reply is a bug in the
 * harness that reads as a finding about the model, which is the worst kind.
 */

export interface Condition {
    readonly views: keyof typeof VIEW_SETS
    readonly size: number
    readonly mode: Mode
    /** How many labelled example pictures go in front of the question. */
    readonly examples: number
    /** Force the reply to be one option, with a GBNF grammar. A condition, never the default. */
    readonly grammar?: boolean
}

const PREAMBLE =
    'The pictures below show a small model built out of cubes on a grid, rendered on a grey background.'

/**
 * The parts of one call: the examples, then the views, then the question.
 *
 * Examples are **leave-one-out** — the shape being asked about is never among them — so an example
 * can teach what the renders look like without ever handing over the answer.
 */
export const partsFor = async (
    volume: Volume,
    question: Question,
    condition: Condition,
    examples: readonly {readonly label: string; readonly volume: Volume}[]
): Promise<Part[]> => {
    const parts: Part[] = []
    const views: readonly View[] = VIEW_SETS[condition.views] ?? []

    if (examples.length > 0) {
        parts.push(
            textPart(
                'First, some labelled examples of what these renders look like. They are different models, not the one you will be asked about.'
            )
        )
        for (const example of examples) {
            parts.push(textPart(`Example — this one is a ${example.label}:`))
            if (condition.mode === 'strip') {
                parts.push(imagePart(toBase64(await stripFor(example.volume, views, condition.size))))
            } else {
                for (const view of views) {
                    parts.push(imagePart(await base64For(example.volume, view, condition.size)))
                }
            }
        }
        parts.push(textPart('Now the model you are being asked about.'))
    }

    if (condition.mode === 'blind') {
        parts.push(
            textPart(
                'You are being asked about a small model built out of cubes on a grid. You cannot see it.'
            )
        )
    } else if (condition.mode === 'strip') {
        parts.push(
            textPart(
                `${PREAMBLE} This single image holds ${String(views.length)} views of one model, in this order: ${views.map(view => view.label).join(', ')}.`
            )
        )
        parts.push(imagePart(toBase64(await stripFor(volume, views, condition.size))))
    } else {
        parts.push(
            textPart(
                `${PREAMBLE} ${views.length === 1 ? 'Here is one view' : `Here are ${String(views.length)} views`} of one model.`
            )
        )
        for (const view of views) {
            parts.push(textPart(`View — ${view.label}:`))
            parts.push(imagePart(await base64For(volume, view, condition.size)))
        }
    }

    parts.push(textPart(question.ask))
    return parts
}
