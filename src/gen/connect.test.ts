import {expect, test} from 'bun:test'
import MANIFEST from '../assets/examples/examples.json'
import {readManifest} from './bank'
import {clientOf, connect, CONNECTING, OFFLINE_NOTE} from './connect'
import {buildLibrary, type Library, type ModelSource} from './library'
import {memoryLlama, type Llama} from './llama'

/**
 * How far the dialog has got in reaching the local model — four `useState`s that were never
 * independent, and whose one interesting path, the offline one, could previously only be reached
 * by mounting the dialog.
 */

const manifest = readManifest(MANIFEST)
if (!manifest) throw new Error('src/assets/examples/examples.json is not a manifest')

/** Nothing on disk: every entry falls back to the hand-written reply in `builtin.ts`. */
const noModels: ModelSource = () => Promise.resolve(undefined)

const bank = async (): Promise<Library> => buildLibrary(manifest, noModels)

/** A server that is not there. `probe` answering `undefined` is the whole of "offline". */
const absent = (): Llama => ({...memoryLlama([]), probe: () => Promise.resolve(undefined)})

test('nothing has been reached yet, and the status line is empty', () => {
    expect(CONNECTING.kind).toBe('loading')
    expect(CONNECTING.note).toBe('')
    expect(clientOf(CONNECTING)).toBeUndefined()
})

test('a server that answers is ready, and says what it is running', async () => {
    const reached = await connect(bank, memoryLlama([], 'Qwen3.6-27B'))
    expect(reached.kind).toBe('ready')
    expect(reached.note).toBe('Ready — Qwen3.6-27B')
    expect(clientOf(reached)).toBeDefined()
})

test('a server that is not there is offline, and tells the artist how to start it', async () => {
    const reached = await connect(bank, absent())
    expect(reached.kind).toBe('offline')
    expect(reached.note).toBe(OFFLINE_NOTE)
    // No client, so nothing can start a batch — which is what the disabled button reads.
    expect(clientOf(reached)).toBeUndefined()
})

/**
 * The bank still loads when the server does not, and that matters: the manifest is what the picking
 * call's prompt is built from, so it has to be there before a client can exist at all.
 */
test('the bank loads whether or not the server answers', async () => {
    const offline = await connect(bank, absent())
    if (offline.kind === 'loading') throw new Error('the load has landed by now')
    expect(offline.library.manifest.entries.length).toBeGreaterThan(0)
    expect(offline.library.teach([manifest.fallback])).toHaveLength(1)
})

test('a supplied client is used as it is, and the bank is never asked to build one', async () => {
    const supplied = memoryLlama([], 'supplied')
    const reached = await connect(bank, supplied)
    expect(clientOf(reached)).toBe(supplied)
})

test('a bank that will not load fails the connection rather than half-making one', async () => {
    const broken = (): Promise<Library> => Promise.reject(new Error('no manifest'))
    expect(connect(broken, memoryLlama([]))).rejects.toThrow('no manifest')
})
