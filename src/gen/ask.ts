import type {BatchState} from './batch'
import type {Connection} from './connect'

/**
 * What the artist is asking the local model for, as one value.
 *
 * It was four `useState`s in `GenerateDialog.tsx` and four rules written inline in JSX — the count's
 * bound, the guard that stops Enter starting a second batch over the first, the one that greys the
 * button out when nothing is answering on :8080, and the rule that the rank order the artist clicked
 * outlives the next thing the batch says about it. Two of those were spelled twice with opposite
 * polarity, which is how a guard and the control it guards drift apart.
 *
 * The same fold `connect.ts` did to the four booleans about reaching the server, and `session.ts`
 * did to `pending`/`asking`/`generating`. What is left in the dialog is drawing.
 *
 * The dropped reference model is deliberately *not* in here. It is a `WorkedExample` with a file
 * behind it and its own rules about what a failed drop does — see `gen/reference.ts` — and folding
 * a thing that can fail into a thing that is four plain fields would hide that.
 */
export interface Ask {
    readonly prompt: string
    readonly count: number
    /**
     * Whether each candidate gets a second call asking what it looks like — see `gen/veto.ts`.
     *
     * Off by default. It costs one extra call to the vision model per candidate and the word it
     * comes back with sorts nothing: it is worth switching on when a batch keeps coming back wrong
     * and you want to know what the model thinks it drew instead.
     */
    readonly naming: boolean
    /**
     * Whether a candidate may only paint in the open document's colours — see `gen/palette.ts`.
     *
     * **On by default**, which is the opposite of every other switch in this dialog, and it is the
     * default because the alternative is not neutral: the model invents hex, `finish` invents two
     * more tones per colour, and a project that generates three models has three near-identical
     * browns in a palette nobody chose. Off is the escape hatch for looking at what the model
     * actually picked.
     */
    readonly enforcePalette: boolean
    /**
     * The cube the model is asked for and the document comes out as, or `undefined` for off.
     *
     * Off is the measured behaviour: 32 in the system prompt, and a grid fitted to whatever was
     * painted, which is a document the size of the model with no room around it. A canvas asks for
     * the bigger box *and* gives the document that box, so there is somewhere to keep drawing.
     */
    readonly canvas: number | undefined
    /**
     * The order the artist clicked, or `undefined` to follow the batch.
     *
     * The batch decides the *default* — it flips to CLIP once CLIP has actually ranked — and this
     * exists only so that a click on the segmented control is not undone by the next snapshot.
     */
    readonly rankBy: 'built-in' | 'clip' | undefined
}

/** How many candidates can be asked for at once. */
export const MAX_CANDIDATES = 12

export const DEFAULT_PROMPT = 'a stone tower'

/**
 * Four is the default because generation is *slow*: 7–20 s per candidate against the local
 * Qwen3.6-27B, measured 2026-08-08, sequentially because the server shares both GPUs with nothing
 * else. Four is about a minute, which is a wait somebody will sit through; twelve is four minutes,
 * which is why it is the ceiling rather than the default.
 */
export const DEFAULT_COUNT = 4

/**
 * The canvases on offer, and the one a new dialog opens on.
 *
 * Cubes, because the generator has no notion of a tall subject and a flat one — it is handed a box
 * and told to fill it.
 *
 * **32 is the default, because 32 is the size every finding on the record was measured at.** The
 * bigger two are not a claim that the model draws well at them. Measured 2026-08-11 against the live
 * server on "a stone tower", one candidate each: fitted it drew 13 wide × 25 tall, at 64 it drew
 * 30 × 55, and at 128 it drew 61 × 128 at 88 % of its own bounding box — which is the solid brick
 * `score.ts` exists to sink. The instruction to fill the box works; filling a big box with *shape*
 * is a different thing and is not measured. So the default is the ground that has been walked, and
 * 64 and 128 are there to be tried.
 */
export const CANVAS_SIZES = [32, 64, 128] as const

export const DEFAULT_CANVAS = 32

export const FIRST_ASK: Ask = {
    prompt: DEFAULT_PROMPT,
    count: DEFAULT_COUNT,
    naming: false,
    enforcePalette: true,
    canvas: DEFAULT_CANVAS,
    rankBy: undefined
}

const isCanvas = (value: number | undefined): value is number =>
    CANVAS_SIZES.some(size => size === value)

/**
 * Change part of the ask, with the count held inside its bounds.
 *
 * Clamped here rather than on the field, for the reason the reducer clamps the brush size and the
 * export padding: the bound is a property of the thing being asked for, and it has to hold however
 * the value was set. The field's own `min`/`max` are what a mouse obeys; a typed `40` is not.
 *
 * The canvas is narrowed the same way and for a stronger reason: it reaches the grid allocator, so
 * anything but one of the three offered sizes is off. A stray `1000` would be 1000³ cells.
 */
export const asking = (ask: Ask, change: Partial<Ask>): Ask => {
    const next = {...ask, ...change}
    return {
        ...next,
        count: Math.min(MAX_CANDIDATES, Math.max(1, Math.round(next.count))),
        canvas: isCanvas(next.canvas) ? next.canvas : undefined
    }
}

/**
 * Whether a batch may start right now.
 *
 * Two things, and both have to be true: something is answering on :8080, and there is not already a
 * batch running. The second is what stops Enter held down in the prompt field from starting a second
 * batch over the first — twelve more calls to a 27B model whose results nothing will ever show.
 */
export const startable = (connection: Connection, batch: BatchState): boolean =>
    connection.kind === 'ready' && batch.stage !== 'generating'

/** The ask a new batch begins from: whatever order was clicked belonged to the last one. */
export const starting = (ask: Ask): Ask => ({...ask, rankBy: undefined})

/** The order the grid is actually in — the artist's click if there was one, the batch's otherwise. */
export const showing = (ask: Ask, batch: BatchState): 'built-in' | 'clip' =>
    ask.rankBy ?? batch.rankBy
