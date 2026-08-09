import {expect, test} from 'bun:test'
import {createVolume} from '../render/volume'
import {initialObjects} from './objects'
import {DEFAULT_OUTPUT, saveDocument, type Document, type SavedDocument} from './save'
import {NO_SYMMETRY} from './symmetry'
import {
    browserStore,
    clearSnapshots,
    latestSnapshot,
    memoryStore,
    putSnapshot,
    SNAPSHOTS,
    snapshots,
    type Store
} from './store'

/**
 * The snapshot rotation, on its own.
 *
 * This module's own header says the thing that can lose an artist's work is the rotation and not
 * the browser API, and that testing it must not need a browser — and then it had no test file at
 * all. What covered it was two whole-window mounts in `App.test.tsx`, at 209 ms each, neither of
 * which could reach the cases that matter: a store that is full, a sixth snapshot, or a key that
 * holds something other than a document.
 */

const grid = createVolume(4, 4, 4)

const document: Document = {
    volume: grid,
    objects: initialObjects(grid),
    cameras: [],
    references: [],
    symmetry: NO_SYMMETRY,
    output: DEFAULT_OUTPUT,
    origin: undefined
}

const at = (when: number, name = 'car.vox'): SavedDocument => saveDocument(document, name, when)

test('a snapshot goes in and comes back as the newest', () => {
    const store = memoryStore()
    expect(snapshots(store)).toEqual([])
    expect(latestSnapshot(store)).toBeUndefined()

    putSnapshot(store, at(1000, 'knight.gpix'))
    putSnapshot(store, at(2000, 'car.vox'))

    // Newest first, which is the order anyone reads a list of restore points in.
    expect(snapshots(store).map(entry => entry.name)).toEqual(['car.vox', 'knight.gpix'])
    expect(latestSnapshot(store)).toContain('"name":"car.vox"')
})

test('the sixth snapshot pushes the oldest out and no more than that', () => {
    const store = memoryStore()
    for (let i = 1; i <= SNAPSHOTS + 3; i += 1)
        putSnapshot(store, at(i * 1000, `take-${String(i)}`))

    const kept = snapshots(store)
    expect(kept).toHaveLength(SNAPSHOTS)
    // The three oldest are the three that went.
    expect(kept.map(entry => entry.name)).toEqual([
        'take-8',
        'take-7',
        'take-6',
        'take-5',
        'take-4'
    ])
})

/*
 * The rule the comment on `putSnapshot` states, and the one a window test cannot reach: the write
 * happens *before* the trim, so a store that is full fails on the new snapshot and leaves every old
 * one standing. Trimming first would clear space by throwing away the artist's history and then
 * fail to write the thing it made room for.
 */
test('a store that refuses the write keeps every snapshot it already had', () => {
    const backing = new Map<string, string>()
    const kind = memoryStore(backing)
    for (let i = 1; i <= SNAPSHOTS; i += 1) putSnapshot(kind, at(i * 1000, `take-${String(i)}`))
    const before = snapshots(kind)
    expect(before).toHaveLength(SNAPSHOTS)

    const full: Store = {...kind, set: () => undefined}
    putSnapshot(full, at(9000, 'the one that did not fit'))

    expect(snapshots(full)).toEqual(before)
})

test('a key that is not a snapshot is not in the list, whatever it holds', () => {
    const backing = new Map<string, string>([
        ['gofer-pixel/something-else', '{"name":"not mine"}'],
        ['unrelated', 'hello']
    ])
    const store = memoryStore(backing)
    putSnapshot(store, at(1000))

    expect(snapshots(store)).toHaveLength(1)
    expect(snapshots(store)[0]?.name).toBe('car.vox')
})

/*
 * The name is scraped out of the JSON rather than parsed out of it, because parsing means turning
 * megabytes of base64 back into a grid to draw one row of a menu. Which means the scrape has to
 * survive a name that is not there, and a name with a quote in it.
 */
test('a snapshot with no readable name still has something to call itself', () => {
    const store = memoryStore(new Map([['gofer-pixel/snapshot/1000', 'not json at all']]))
    expect(snapshots(store)[0]?.name).toBe('Snapshot')

    const empty = memoryStore(new Map([['gofer-pixel/snapshot/2000', '']]))
    expect(snapshots(empty)[0]?.name).toBe('Snapshot')
})

test('a name with a quote in it comes back whole', () => {
    const store = memoryStore()
    putSnapshot(store, at(1000, 'the "good" one.gpix'))
    expect(snapshots(store)[0]?.name).toBe(String.raw`the \"good\" one.gpix`)
})

test('forgetting the snapshots leaves everything that was not one', () => {
    const backing = new Map<string, string>([['unrelated', 'hello']])
    const store = memoryStore(backing)
    putSnapshot(store, at(1000))
    putSnapshot(store, at(2000))

    clearSnapshots(store)
    expect(snapshots(store)).toEqual([])
    expect(latestSnapshot(store)).toBeUndefined()
    expect(backing.get('unrelated')).toBe('hello')
})

/*
 * A private window, a quota and a browser with the feature switched off all fail in `browserStore`,
 * and all three must cost the artist a missing autosave rather than a window that will not open.
 */
test('a browser with no localStorage still hands back a working store', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {value: undefined, configurable: true})
    try {
        const store = browserStore()
        putSnapshot(store, at(1000))
        expect(snapshots(store)).toHaveLength(1)
    } finally {
        if (real) Object.defineProperty(globalThis, 'localStorage', real)
    }
})

test('a localStorage that throws on write loses the snapshot and nothing else', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const held = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (key: string) => held.get(key) ?? null,
            setItem: () => {
                throw new Error('QuotaExceededError')
            },
            removeItem: (key: string) => held.delete(key)
        }
    })
    try {
        const store = browserStore()
        // Silent by design: a failed autosave must not be an exception out of a render.
        expect(() => {
            putSnapshot(store, at(1000))
        }).not.toThrow()
        expect(store.get('gofer-pixel/snapshot/1000')).toBeUndefined()
    } finally {
        if (real) Object.defineProperty(globalThis, 'localStorage', real)
    }
})
