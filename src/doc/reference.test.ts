import {expect, test} from 'bun:test'
import {drop, fade, lock, place, readReference, type Reference} from './reference'

const PIXEL = 'data:image/png;base64,iVBORw0KGgo='
const OTHER = 'data:image/png;base64,QUJDREVGRw=='

const front = (): readonly Reference[] => place([], 1, PIXEL)

const locked = (): readonly Reference[] => lock(front(), 1, true)

test('a picture arrives half-faded and unlocked', () => {
    expect(front()).toEqual([{plane: 1, url: PIXEL, opacity: 0.5, locked: false}])
})

test('one picture per plane — a second drop on the front replaces the first', () => {
    const both = place(place(front(), 0, OTHER), 1, OTHER)
    expect(both).toHaveLength(2)
    expect(both.find(entry => entry.plane === 1)?.url).toBe(OTHER)
})

/**
 * The bug the module exists for. The lock was checked in three of the four operations and written
 * three different ways; the one that had no check at all was the one that replaces the picture, so
 * a drop went straight through the lock the artist had set.
 */
test('a locked plane refuses a new picture, a fade and a drop', () => {
    expect(place(locked(), 1, OTHER)).toEqual(locked())
    expect(fade(locked(), 1, 0.9)).toEqual(locked())
    expect(drop(locked(), 1)).toEqual(locked())
})

test('a lock can always be undone, or the lock is a trap', () => {
    expect(lock(locked(), 1, false)[0]?.locked).toBe(false)
    expect(drop(lock(locked(), 1, false), 1)).toEqual([])
})

test('a lock on one plane does not reach the others', () => {
    const two = place(locked(), 0, OTHER)
    expect(drop(two, 0)).toEqual(locked())
    expect(fade(two, 0, 0.25).find(entry => entry.plane === 0)?.opacity).toBe(0.25)
})

test('opacity is clamped here, so no caller can put it out of range', () => {
    expect(fade(front(), 1, 4)[0]?.opacity).toBe(1)
    expect(fade(front(), 1, -4)[0]?.opacity).toBe(0)
})

test('acting on a plane with no picture does nothing', () => {
    expect(fade(front(), 2, 0.1)).toEqual(front())
    expect(lock(front(), 2, true)).toEqual(front())
    expect(drop(front(), 2)).toEqual(front())
})

/**
 * The other half of the module: what may be read off a file. A reference with a missing plane would
 * draw somewhere the artist never put it, and a URL that is not a `data:` URL is either a dead
 * `blob:` from another session or an outbound request from a document somebody else wrote.
 */
test('a reference off a file is refused unless every field is right', () => {
    expect(readReference({plane: 1, url: PIXEL, opacity: 0.4, locked: true})).toEqual({
        plane: 1,
        url: PIXEL,
        opacity: 0.4,
        locked: true
    })
    expect(readReference({plane: 9, url: PIXEL, opacity: 0.4})).toBeUndefined()
    expect(readReference({plane: 1, url: 'blob:x', opacity: 0.4})).toBeUndefined()
    expect(readReference({plane: 1, url: PIXEL, opacity: 2})).toBeUndefined()
    expect(readReference(null)).toBeUndefined()
})
