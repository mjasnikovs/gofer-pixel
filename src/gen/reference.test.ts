import {expect, test} from 'bun:test'
import {memoryFiles, type Files} from '../doc/files'
import {memoryStore} from '../doc/store'
import {saveDocument} from '../doc/save'
import {initialObjects} from '../doc/objects'
import {NO_SYMMETRY} from '../doc/symmetry'
import {DEFAULT_OUTPUT} from '../doc/save'
import {createVolume, setVoxel} from '../render/volume'
import {magicaPalette} from '../vox/vox-file'
import {LINE_BUDGET} from './bank'
import {choose, forget, recall, REFERENCE_KEY, take, takeFile} from './reference'

/**
 * The artist's own teacher, asked directly.
 *
 * The three failure paths below — a file that will not read, a model over the line budget, a corrupt
 * key in `localStorage` — used to need a mounted dialog and a synthetic drop event to reach.
 */

/** A little model that decomposes to a handful of boxes: two solid slabs, well inside the budget. */
const simple = (): ReturnType<typeof createVolume> => {
    const volume = createVolume(8, 8, 8, magicaPalette())
    for (let x = 1; x < 5; x += 1) {
        for (let y = 1; y < 5; y += 1) {
            for (let z = 1; z < 3; z += 1) setVoxel(volume, x, y, z, 1)
        }
    }
    return volume
}

/** A model with no two neighbours the same colour, so every voxel costs its own line. */
const noisy = (): ReturnType<typeof createVolume> => {
    const volume = createVolume(16, 16, 16, magicaPalette())
    for (let i = 0; i < 16 * 16; i += 1) {
        const x = i % 16
        const y = Math.floor(i / 16)
        setVoxel(volume, x, y, (x + y) % 16, 1 + ((x * 7 + y * 3) % 200))
    }
    return volume
}

const gpix = (volume: ReturnType<typeof createVolume>): Uint8Array =>
    new TextEncoder().encode(
        JSON.stringify(
            saveDocument(
                {
                    volume,
                    objects: initialObjects(volume),
                    cameras: [],
                    references: [],
                    symmetry: NO_SYMMETRY,
                    output: DEFAULT_OUTPUT,
                    origin: undefined
                },
                'mine.gpix'
            )
        )
    )

test('a model that reads and fits becomes the teacher, and is remembered', () => {
    const store = memoryStore()
    const outcome = take(store, 'mine.gpix', gpix(simple()), 'a knight')

    expect(outcome.ok).toBe(true)
    expect(outcome.note).toBe('Teaching from mine.gpix')
    // The prompt in the field becomes the example's user turn: the model imitates the *pairing*,
    // so an example labelled with the wrong subject teaches the wrong lesson.
    expect(outcome.example?.prompt).toBe('a knight')
    expect(outcome.example?.reply).toContain('box(')

    // Remembered as the decomposed example, never as the file — a few hundred bytes of text
    // against a `.vox` that could be anything.
    expect(recall(store)).toEqual(outcome.example)
    expect(store.get(REFERENCE_KEY)).not.toContain('gpix')
})

test('a file that will not read is refused, and says so by name', () => {
    const store = memoryStore()
    const outcome = take(store, 'notes.txt', new TextEncoder().encode('hello'), 'a knight')

    expect(outcome.ok).toBe(false)
    expect(outcome.example).toBeUndefined()
    expect(outcome.note).toBe('notes.txt is not a .vox or .gpix this build can read')
    // Nothing was remembered, so a previous teacher is still the teacher.
    expect(recall(store)).toBeUndefined()
})

test('a model too detailed to teach from is refused at the drop, not thirty seconds into a batch', () => {
    const store = memoryStore()
    const outcome = take(store, 'busy.gpix', gpix(noisy()), 'a knight')

    expect(outcome.ok).toBe(false)
    expect(outcome.example).toBeUndefined()
    expect(outcome.note).toContain('too detailed to teach from')
    expect(outcome.note).toContain(String(LINE_BUDGET))
    expect(recall(store)).toBeUndefined()
})

test('a failed take leaves the teacher that was already there standing', () => {
    const store = memoryStore()
    const good = take(store, 'mine.gpix', gpix(simple()), 'a knight')

    take(store, 'notes.txt', new Uint8Array([1, 2, 3]), 'a knight')
    take(store, 'busy.gpix', gpix(noisy()), 'a knight')

    expect(recall(store)).toEqual(good.example)
})

test('a key that is not an example is nothing there, whatever it holds', () => {
    const store = memoryStore()
    for (const junk of ['', 'not json', '[]', 'null', '3', '{"prompt":"a cat"}', '{"reply":""}']) {
        store.set(REFERENCE_KEY, junk)
        expect(recall(store)).toBeUndefined()
    }
    // Anything else with two strings in the right places is taken at face value.
    store.set(REFERENCE_KEY, '{"prompt":"a cat","reply":"box(0,0,0,1,1,1,1)","extra":9}')
    expect(recall(store)).toEqual({prompt: 'a cat', reply: 'box(0,0,0,1,1,1,1)'})
})

test('forgetting clears the store as well as the answer', () => {
    const store = memoryStore()
    take(store, 'mine.gpix', gpix(simple()), 'a knight')

    const outcome = forget(store)
    expect(outcome).toEqual({example: undefined, note: '', ok: true})
    expect(recall(store)).toBeUndefined()
})

test('an empty drop is not an outcome at all, so nothing is said about it', async () => {
    expect(await takeFile(memoryStore(), undefined, 'a knight')).toBeUndefined()
})

test('a drop goes through the same path as a picked file', async () => {
    const store = memoryStore()
    const bytes = gpix(simple())
    const dropped = await takeFile(
        store,
        new File([bytes as BlobPart], 'mine.gpix', {type: 'application/json'}),
        'a knight'
    )

    expect(dropped?.ok).toBe(true)
    expect(dropped?.example).toEqual(take(memoryStore(), 'mine.gpix', bytes, 'a knight').example)
})

test('a cancelled picker is not a failure and must not be reported as one', async () => {
    // Nothing on this disk matches `.vox,.gpix`, so the port hands back nothing.
    const empty: Files = memoryFiles(new Map([['notes.txt', 'hello']]))
    expect(await choose(memoryStore(), empty, 'a knight')).toBeUndefined()
})

test('a chosen model is taken through the port Open and Save use', async () => {
    const store = memoryStore()
    const disk = new Map<string, string | Uint8Array>([['mine.gpix', gpix(simple())]])
    const outcome = await choose(store, memoryFiles(disk), 'a knight')

    expect(outcome?.ok).toBe(true)
    expect(recall(store)).toEqual(outcome?.example)
})
