import {DEFAULT_FLAGS, type Flags} from './flags'
import {gateStatus, NOTHING_GATED, type GateTally} from './gate'
import {generateMany, randomSeed, type Candidate, type Llama} from './llama'
import {overallScore, type ModelScores} from './score'
import {judge, type Veto, type Verdict} from './veto'
import type {WorkedExample} from './bank'
import type {Swatches} from './palette'
import {teachingSet} from './teaching'

/**
 * One batch of candidates, end to end: ask the model N times, score what lands, and optionally ask
 * what each one reads as.
 *
 * This used to be a callback inside the generate dialog, which meant the only way to test the
 * *order of the stages* was to mount React and click a button. The stages are where the measured
 * findings live — see `docs/GEN_RESEARCH.md` and the four settled points in `CLAUDE.md` — so they
 * belong somewhere a 1 ms test can reach them:
 *
 * 1. **Generation is sequential.** llama-server has two slots and shares both GPUs; N at once buys
 *    queueing. `generateMany` owns that, and this owns everything around it.
 * 2. **Naming sorts nothing.** It is one vision call per candidate and the word it returns is a
 *    label. Measured over 8 cats and 8 knights, ranking by it threw away a real cat for being
 *    called "dog" and the best knight of eight for being called "santa".
 * 3. **A dropped model outranks the bank's guess.** The artist's own example is appended after the
 *    bank's picks, which puts it nearest the prompt — the position the model imitates hardest.
 *
 * Every stage checks the signal before it starts. Cancelling mid-batch keeps what landed.
 */
export interface Ranked {
    readonly candidate: Candidate
    readonly scores: ModelScores
    readonly overall: number
    /**
     * What the vision model called it — see `veto.ts`. `null` until it has been asked.
     *
     * A failed verdict marks a candidate and never removes one: the judge is loose enough to have
     * called a good cat a sheep, and the artist is looking at the same picture it was.
     */
    readonly veto: Verdict | null
}

/**
 * Which stage the batch is in.
 *
 * `generating` is the only one that blocks the controls, which is why it is not simply "not done":
 * naming and ranking both run after the grid is complete, and an artist who has seen the pictures
 * should be able to start a new batch without waiting for a label.
 */
export type BatchStage = 'idle' | 'generating' | 'naming' | 'done'

/** How far the naming has got, and what it found. `undefined` when naming was not asked for. */
export interface NamingProgress {
    /** Candidates asked about so far. */
    readonly asked: number
    readonly of: number
    /** Of those the model gave a word for, how many read as the subject. */
    readonly matched: number
    /** How many gave a word at all — the model sometimes will not say. */
    readonly answered: number
    readonly done: boolean
}

export interface BatchState {
    readonly stage: BatchStage
    /** The candidates that landed, in the order they landed. For display, see `ordered`. */
    readonly ranked: readonly Ranked[]
    /** Attempts finished — candidates and failures alike, so a failure closes its own slot. */
    readonly done: number
    readonly count: number
    /** The examples the whole batch was taught from, as ids, plus the artist's own model. */
    readonly taughtBy: readonly string[]
    /** Every failed attempt's message, in the order they failed. */
    readonly failures: readonly string[]
    readonly naming: NamingProgress | undefined
    /** What the gate did, when the `gates` experiment is on — see `gen/gate.ts`. */
    readonly gate: GateTally
}

export const idleBatch = (count: number): BatchState => ({
    stage: 'idle',
    ranked: [],
    done: 0,
    count,
    taughtBy: [],
    failures: [],
    naming: undefined,
    gate: NOTHING_GATED
})

export interface BatchPorts {
    readonly llama: Llama
    /** The naming judge. The same server as `llama`, a different question. */
    readonly veto: Veto
}

export interface BatchRequest {
    readonly prompt: string
    readonly count: number
    /** Whether to ask what each candidate reads as. Off by default: one vision call each. */
    readonly naming: boolean
    /**
     * The bank's examples for the ids the picking call chose — see `library.ts`.
     *
     * A function rather than the bank itself, because what teaches a batch is composed here from
     * two sources and neither one of them is the bank alone.
     */
    readonly teach?: (ids: readonly string[]) => readonly WorkedExample[]
    /** A model the artist dropped on the dialog. Appended last; see the note on this module. */
    readonly reference?: WorkedExample | undefined
    /** The cube every candidate is asked for and gets. `undefined` is the switch off — 32, fitted. */
    readonly canvas?: number | undefined
    /** The project's colours, when the palette is enforced — see `gen/palette.ts`. */
    readonly swatches?: Swatches | undefined
    readonly seed?: number
    /** Which experiments are on — see `gen/flags.ts`. Absent is the measured generator. */
    readonly flags?: Flags
    readonly now?: () => Date
}

/** The label a dropped model is taught under, since it has no id in the bank. */
export const OWN_MODEL = 'your model'

/**
 * Run one batch, calling back with the whole state every time any of it changes.
 *
 * A snapshot per change rather than a stream of events, because the caller is a React component and
 * a component that has to fold events back into a picture is the twelve `useState` calls this
 * replaced. The final state is also returned, so a test needs no callback at all.
 */
export const runBatch = async (
    ports: BatchPorts,
    request: BatchRequest,
    onProgress?: (state: BatchState) => void,
    signal?: AbortSignal
): Promise<BatchState> => {
    const {
        prompt,
        count,
        naming,
        teach,
        reference,
        canvas,
        swatches,
        seed = randomSeed(),
        flags = DEFAULT_FLAGS,
        now
    } = request
    // Read through a call, never as a field: it flips during an `await`, and a plain read narrows
    // for the rest of the function under the type-aware lint rules.
    const stopped = (): boolean => signal?.aborted === true

    let state: BatchState = {...idleBatch(count), stage: 'generating'}
    const publish = (next: Partial<BatchState>): void => {
        state = {...state, ...next}
        onProgress?.(state)
    }
    onProgress?.(state)

    const landed: Ranked[] = []
    const failures: string[] = []
    const attempts = await generateMany(ports.llama, prompt, count, {
        temperature: 0.9,
        seed,
        canvas,
        swatches,
        flags,
        ...(signal ? {signal} : {}),
        ...(now ? {now} : {}),
        /*
         * Named rather than left implicit. The worked examples are the strongest single influence
         * on what comes back — a chicken built against the dog example comes back with four legs —
         * so an artist looking at twelve wrong candidates can see *why* without reading the source.
         */
        onPick: ids => {
            publish({taughtBy: [...ids, ...(reference ? [OWN_MODEL] : [])]})
        },
        // The gate's running tally, so the line under the grid moves while seeds are being spent.
        onGate: gate => {
            publish({gate})
        },
        // Which examples, in what order, within what budget — all four rules are `teaching.ts`.
        teach: ids => teachingSet(teach?.(ids) ?? [], reference),
        onAttempt: (attempt, at) => {
            if (attempt.ok) {
                // Scored once, in `generateMany`, where the pre-shading grid still exists.
                const {scores} = attempt.candidate
                landed.push({
                    candidate: attempt.candidate,
                    scores,
                    // A prop is ranked on its surface and not on its silhouette — `gen/face.ts`.
                    overall: overallScore(scores, attempt.candidate.spec.surface === true),
                    veto: null
                })
            } else {
                failures.push(attempt.error)
            }
            // A copy per attempt, so the grid fills in rather than appearing at the end.
            publish({done: at, ranked: [...landed], failures: [...failures]})
        }
    })
    // `generateMany` stops early on an abort, so the requested count is not what arrived.
    publish({done: attempts.length, stage: 'done'})
    if (landed.length === 0 || stopped()) return state

    const judged = [...landed]
    if (naming) {
        let answered = 0
        let matched = 0
        publish({
            stage: 'naming',
            naming: {asked: 0, of: judged.length, matched: 0, answered: 0, done: false}
        })
        for (let i = 0; i < judged.length; i += 1) {
            const entry = judged[i]
            if (!entry || stopped()) break
            const verdict = await judge(ports.veto, entry.candidate.volume, prompt, signal)
            judged[i] = {...entry, veto: verdict}
            if (verdict.word !== '') {
                answered += 1
                if (verdict.pass) matched += 1
            }
            publish({
                ranked: [...judged],
                naming: {asked: i + 1, of: judged.length, matched, answered, done: false}
            })
        }
        publish({
            stage: 'done',
            naming: {...(state.naming ?? {asked: 0, of: 0, matched: 0, answered: 0}), done: true}
        })
    }
    if (stopped()) return state

    publish({stage: 'done', ranked: judged})
    return state
}

/**
 * The grid's order.
 *
 * The naming does not appear here and that is a measurement rather than caution — see `veto.ts`
 * and `docs/GEN_RESEARCH.md`, 2026-08-08. The word is shown because it says what the sprite reads
 * as; it does not get to move anything.
 */
export const ordered = (state: BatchState): readonly Ranked[] =>
    [...state.ranked].sort((a, b) => b.overall - a.overall)

/**
 * The slots still to fill, so the grid has its final shape from the first second.
 *
 * A candidate is 7–20 s and only the finished ones can be drawn, so without these the artist
 * watches an empty box for twenty seconds and cannot tell a slow model from a broken one. `done`
 * counts attempts, not candidates, so a failed attempt closes its own placeholder.
 */
export const pendingSlots = (state: BatchState): number =>
    state.stage === 'generating' ? Math.max(0, state.count - state.done) : 0

/* The status lines. Here rather than in the dialog so the wording is testable without React. */

export const generateNote = (state: BatchState): string => {
    if (state.stage === 'idle') return ''
    if (state.stage === 'generating') {
        /*
         * The failures are counted here as well as at the end, because `done` counts *attempts* and
         * `pendingSlots` is `count - done`: a failed attempt closes its own placeholder, so the grid
         * silently loses a box. Seen from the outside that is "I asked for four and there are
         * three", with a line above it saying 1/4 and nothing anywhere saying why. The reason still
         * waits for the end — it is one long line and it would make this one jump on every attempt.
         */
        const lost = state.failures.length
        return (
            `Generating ${String(state.done)}/${String(state.count)}…`
            + (lost === 0 ? '' : ` · ${String(lost)} failed`)
        )
    }
    const taught = state.taughtBy.length === 0 ? '' : ` · taught by ${state.taughtBy.join(', ')}`
    const first = state.failures[0]
    return (
        `${String(state.ranked.length)} candidates, ${String(state.failures.length)} failed`
        + taught
        + (first === undefined ? '' : ` — ${first.slice(0, 90)}`)
    )
}

export const namingNote = (state: BatchState): string => {
    const {naming} = state
    if (!naming) return ''
    if (!naming.done) return `Naming: ${String(naming.asked)}/${String(naming.of)}…`
    if (naming.answered === 0) return 'Naming: the model would not say what these are'
    return `Naming: ${String(naming.matched)} of ${String(naming.answered)} read as the subject`
}

/** The gate's line, or nothing at all when the experiment is off — see `gen/gate.ts`. */
export const gateNote = (state: BatchState): string => gateStatus(state.gate)
