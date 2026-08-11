import {expect, test} from 'bun:test'
import {memoryStore} from '../doc/store'
import {
    DEFAULT_FLAGS,
    experimenting,
    FLAG_NOTES,
    flagsOn,
    flip,
    readFlags,
    resetFlags,
    writeFlags,
    type Flags
} from './flags'

/**
 * The experiments, and the one rule that makes them experiments: every flag is off by default, and
 * anything that is not an explicit `true` from the switch reads as off.
 */

const keys = Object.keys(DEFAULT_FLAGS) as (keyof Flags)[]

test('every experiment is off by default', () => {
    for (const key of keys) expect(DEFAULT_FLAGS[key]).toBe(false)
    expect(experimenting(DEFAULT_FLAGS)).toBe(false)
    expect(flagsOn(DEFAULT_FLAGS)).toEqual([])
})

/**
 * The list the dialog draws from has to be the whole set, or an experiment ships with no way to
 * turn it off — and `readFlags` reads through the same list, so a missing entry would also be a
 * flag that could never be loaded back.
 */
test('every flag has a note, and every note names a flag', () => {
    expect(FLAG_NOTES.map(note => note.key).sort()).toEqual([...keys].sort())
    for (const note of FLAG_NOTES) {
        expect(note.title).not.toBe('')
        expect(note.note).not.toBe('')
        expect(note.where).not.toBe('')
    }
})

test('an empty store is every experiment off', () => {
    expect(readFlags(memoryStore())).toEqual(DEFAULT_FLAGS)
})

test('a flag survives being written and read back', () => {
    const store = memoryStore()
    writeFlags(store, {...DEFAULT_FLAGS, repair: true, gates: true})
    const read = readFlags(store)
    expect(read.repair).toBe(true)
    expect(read.gates).toBe(true)
    expect(read.silhouette).toBe(false)
})

test('flipping a switch remembers it', () => {
    const store = memoryStore()
    const on = flip(store, DEFAULT_FLAGS, 'repair', true)
    expect(on.repair).toBe(true)
    expect(readFlags(store).repair).toBe(true)

    const off = flip(store, on, 'repair', false)
    expect(off.repair).toBe(false)
    expect(readFlags(store).repair).toBe(false)
})

test('reset puts every experiment back, on disk as well as in hand', () => {
    const store = memoryStore()
    writeFlags(store, {...DEFAULT_FLAGS, repair: true, procedural: true})
    expect(resetFlags(store)).toEqual(DEFAULT_FLAGS)
    expect(readFlags(store)).toEqual(DEFAULT_FLAGS)
})

/**
 * The three shapes of stored rubbish, and they all mean off. A flag nobody can see in the dialog
 * must not be running, so a graduated flag, a flag from another branch and a hand-edited value are
 * one case with one answer.
 */
test('anything that is not an explicit true reads as off', () => {
    const store = memoryStore()

    store.set('gofer-pixel/flags', 'not json at all')
    expect(readFlags(store)).toEqual(DEFAULT_FLAGS)

    store.set('gofer-pixel/flags', 'null')
    expect(readFlags(store)).toEqual(DEFAULT_FLAGS)

    store.set('gofer-pixel/flags', '["repair"]')
    expect(readFlags(store)).toEqual(DEFAULT_FLAGS)

    store.set('gofer-pixel/flags', JSON.stringify({repair: 'yes', gates: 1}))
    expect(readFlags(store)).toEqual(DEFAULT_FLAGS)
})

test('a flag this build has never heard of is dropped rather than carried', () => {
    const store = memoryStore()
    store.set('gofer-pixel/flags', JSON.stringify({repair: true, wormhole: true}))
    const read = readFlags(store) as unknown as Record<string, unknown>
    expect(read['repair']).toBe(true)
    expect(read['wormhole']).toBeUndefined()
})

/** The status line: which experiments are on, in the order the dialog lists them. */
test('the ids of what is on come back cheapest-first', () => {
    const on: Flags = {...DEFAULT_FLAGS, relational: true, repair: true}
    expect(experimenting(on)).toBe(true)
    expect(flagsOn(on)).toEqual(['repair', 'relational'])
})
