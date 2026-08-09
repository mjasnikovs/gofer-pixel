import {MODEL_ACCEPT, volumeFromFile} from '../doc/models'
import type {Files} from '../doc/files'
import type {Store} from '../doc/store'
import {exampleFrom, LINE_BUDGET, overBudget, type WorkedExample} from './bank'

/**
 * The artist's own model, as the example it teaches the next batch with.
 *
 * `gen/batch.ts` took the batch out of the generate dialog and left this behind: ninety lines of
 * reading, decomposing, budget-checking and remembering, inside a component, reachable only by
 * mounting a dialog and firing a synthetic drop at it. The rules in here are the same kind of rule
 * the batch's are — measured, and easy to break by accident:
 *
 * 1. **A dropped model is decomposed at the moment of the drop.** The failures — a file that will
 *    not read, a model too detailed to fit the line budget — belong where there is somebody to tell,
 *    not thirty seconds into a batch that is already spending a minute of the artist's time.
 * 2. **It is remembered as the decomposed example, never as the file.** A few hundred bytes of text
 *    against a `.vox` that could be anything, and `localStorage` is about five megabytes shared with
 *    the autosave.
 * 3. **Anything that fails leaves the previous teacher standing.** A bad drop is not a reason to
 *    forget the good model the artist chose ten minutes ago.
 *
 * Every function here comes back as an `Outcome`, so the note the dialog shows and the example it
 * teaches from can never disagree about what just happened.
 */

/** Where a dropped model is remembered, across reloads. */
export const REFERENCE_KEY = 'gofer-pixel/gen-reference'

export {MODEL_ACCEPT}

/**
 * What a read attempt came to.
 *
 * `example` is `undefined` on every failure and on a deliberate clear, and the caller keeps whatever
 * it had — see rule 3. `note` is what the artist is told, and the empty string means "say nothing",
 * which is the state the dialog opens in.
 */
export interface Outcome {
    readonly example: WorkedExample | undefined
    readonly note: string
    /** False when the attempt failed, so a caller can tell a clear from a rejection. */
    readonly ok: boolean
}

/**
 * What was remembered from last time, if anything.
 *
 * Hand-checked rather than trusted: this is a key in `localStorage`, which any other tab, any older
 * build of this app and the artist's own devtools can write. A shape that is not two strings is
 * treated as nothing there, silently — there is nobody to tell at startup, and the cost of being
 * wrong is a batch taught by garbage.
 */
export const recall = (store: Store): WorkedExample | undefined => {
    const held = store.get(REFERENCE_KEY)
    if (held === undefined) return undefined
    try {
        const parsed: unknown = JSON.parse(held)
        if (typeof parsed !== 'object' || parsed === null) return undefined
        const {prompt, reply} = parsed as Record<string, unknown>
        if (typeof prompt !== 'string' || typeof reply !== 'string' || reply === '') {
            return undefined
        }
        return {prompt, reply}
    } catch {
        return undefined
    }
}

/**
 * Take a model as the teacher, decomposing it now and remembering it if it fits.
 *
 * `subject` is the prompt in the field, which becomes the example's user turn — the model imitates
 * the pairing, so an example labelled with the wrong subject teaches the wrong lesson.
 */
export const take = (store: Store, name: string, bytes: Uint8Array, subject: string): Outcome => {
    const volume = volumeFromFile(name, bytes)
    if (!volume) {
        return {
            example: undefined,
            note: `${name} is not a .vox or .gpix this build can read`,
            ok: false
        }
    }
    const example = exampleFrom({id: 'reference', subject, use: '', notes: ''}, volume)
    if (overBudget(example)) {
        const lines = example.reply.split('\n').length
        return {
            example: undefined,
            note:
                `${name} decomposes into ${String(lines)} lines`
                + ` — too detailed to teach from, over the ${String(LINE_BUDGET)}-line budget`,
            ok: false
        }
    }
    store.set(REFERENCE_KEY, JSON.stringify(example))
    return {example, note: `Teaching from ${name}`, ok: true}
}

/** The same, for a drop, which hands over a `File` rather than a port's bytes. */
export const takeFile = async (
    store: Store,
    file: File | undefined,
    subject: string
): Promise<Outcome | undefined> => {
    if (!file) return undefined
    return take(store, file.name, new Uint8Array(await file.arrayBuffer()), subject)
}

/**
 * "Choose a model", through the same port Open, Save and the palette loader use.
 *
 * `undefined` when the picker was cancelled — the same convention `app/session.ts` uses, and for the
 * same reason: a cancel is not a failure and must not be reported as one.
 */
export const choose = async (
    store: Store,
    files: Files,
    subject: string
): Promise<Outcome | undefined> => {
    const picked = await files.open(MODEL_ACCEPT, 'Voxel model')
    if (!picked) return undefined
    return take(store, picked.name, picked.bytes, subject)
}

/** Forget the teacher. Its own function because it has to clear the store as well as the state. */
export const forget = (store: Store): Outcome => {
    store.remove(REFERENCE_KEY)
    return {example: undefined, note: '', ok: true}
}
