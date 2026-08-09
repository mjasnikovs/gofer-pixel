import {browserLlama, type Llama} from './llama'
import type {Library} from './library'

/**
 * How far the generate dialog has got in reaching the local model.
 *
 * It used to be four `useState`s — the bank, the client built from it, the model name the probe
 * came back with, and the status line — set one after another inside a single effect. They were
 * never independent: four fields with sixteen combinations, of which three were reachable. This is
 * the same fold `app/session.ts` did when `pending`/`asking`/`generating` became one `Dialog`.
 *
 * The wording lives here rather than in the JSX because it is the answer to a question about the
 * environment, and the environment is what this module is about.
 */
export type Connection =
    | {readonly kind: 'loading'; readonly note: string}
    /** The bank loaded, but nothing is answering on :8080. Nothing can be generated. */
    | {readonly kind: 'offline'; readonly note: string; readonly library: Library}
    | {
          readonly kind: 'ready'
          readonly note: string
          readonly library: Library
          readonly llama: Llama
          /** What the server said it is running, for the status line. */
          readonly model: string
      }

export const CONNECTING: Connection = {kind: 'loading', note: ''}

export const OFFLINE_NOTE = 'No local model. Start llama-server on :8080 and reopen this.'

/** The client, when there is one to hand to a batch. */
export const clientOf = (connection: Connection): Llama | undefined =>
    connection.kind === 'ready' ? connection.llama : undefined

/**
 * Load the bank, build the client from it, then ask whether the server is there.
 *
 * In that order, and the order is a rule rather than a convenience: the picking call's prompt *is*
 * the manifest, so `browserLlama` cannot be constructed before the bank has loaded. A supplied
 * `llama` skips the middle step, which is how the tests drive the dialog without a bank.
 */
export const connect = async (
    library: () => Promise<Library>,
    llama?: Llama
): Promise<Connection> => {
    const loaded = await library()
    const built = llama ?? browserLlama(loaded.manifest)
    const model = await built.probe()
    return model === undefined ?
            {kind: 'offline', note: OFFLINE_NOTE, library: loaded}
        :   {kind: 'ready', note: `Ready — ${model}`, library: loaded, llama: built, model}
}
