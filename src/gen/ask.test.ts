import {expect, test} from 'bun:test'
import MANIFEST from '../assets/examples/examples.json'
import {asking, CANVAS_SIZES, DEFAULT_CANVAS, FIRST_ASK, MAX_CANDIDATES, startable} from './ask'
import {readManifest} from './bank'
import {connect, CONNECTING, type Connection} from './connect'
import {buildLibrary, type Library} from './library'
import {memoryLlama, type Llama} from './llama'

/**
 * The rules that used to be written inline in `GenerateDialog.tsx`'s JSX.
 *
 * Two of them were written *twice* — the count's bound once as the field's `min`/`max` and once as
 * a clamp, the start guard once as `!busy && connection.kind === 'ready'` on the Enter key and once
 * as `!busy && connection.kind !== 'ready'` on the button. That is the shape a guard and the control
 * it guards drift apart in, and it took a mount to ask either of them a question.
 */

const manifest = readManifest(MANIFEST)
if (!manifest) throw new Error('src/assets/examples/examples.json is not a manifest')

/** The real `connect`, so the two states under test are the ones the dialog actually reaches. */
const bank = async (): Promise<Library> => buildLibrary(manifest, () => Promise.resolve(undefined))
const absent = (): Llama => ({...memoryLlama([]), probe: () => Promise.resolve(undefined)})

const READY: Connection = await connect(bank, memoryLlama([], 'test'))
const OFFLINE: Connection = await connect(bank, absent())

test('a count is held inside its bounds however it was set', () => {
    expect(asking(FIRST_ASK, {count: 40}).count).toBe(MAX_CANDIDATES)
    expect(asking(FIRST_ASK, {count: 0}).count).toBe(1)
    expect(asking(FIRST_ASK, {count: -3}).count).toBe(1)
    // A number field hands back what was typed, and 2.6 candidates is not a thing to ask for.
    expect(asking(FIRST_ASK, {count: 2.6}).count).toBe(3)
})

test('changing one part of the ask leaves the rest of it alone', () => {
    const asked = asking(asking(FIRST_ASK, {prompt: 'a knight'}), {naming: true})

    expect(asked.prompt).toBe('a knight')
    expect(asked.naming).toBe(true)
    expect(asked.count).toBe(FIRST_ASK.count)
})

/*
 * The guard the Enter key and the Generate button now share. Held down in the prompt field
 * mid-batch, an unguarded Enter starts a second batch over the first — twelve more calls to a 27B
 * model whose results nothing will ever show.
 */
test('a batch may start only when the server is there and no batch is running', () => {
    expect(startable(READY, false)).toBe(true)
    expect(startable(READY, true)).toBe(false)
    expect(startable(OFFLINE, false)).toBe(false)
    expect(startable(CONNECTING, false)).toBe(false)
})

/*
 * The canvas and the palette switch. Both are bounds on what a batch may produce rather than
 * descriptions of it, and the canvas one reaches the grid allocator — so the narrowing is here,
 * beside the count's, and not on the control.
 */

test('the dialog opens on a canvas and on the project palette', () => {
    expect(FIRST_ASK.canvas).toBe(DEFAULT_CANVAS)
    expect(CANVAS_SIZES).toContain(DEFAULT_CANVAS)
    // On by default, unlike naming: a model that invents colours costs the artist their palette.
    expect(FIRST_ASK.enforcePalette).toBe(true)
    expect(FIRST_ASK.naming).toBe(false)
})

test('a canvas that is not one of the three is off, not a grid of that size', () => {
    for (const size of CANVAS_SIZES) expect(asking(FIRST_ASK, {canvas: size}).canvas).toBe(size)
    expect(asking(FIRST_ASK, {canvas: undefined}).canvas).toBeUndefined()
    // 1000³ is a billion cells. The control cannot ask for it; nothing else may either.
    expect(asking(FIRST_ASK, {canvas: 1000}).canvas).toBeUndefined()
    expect(asking(FIRST_ASK, {canvas: 48}).canvas).toBeUndefined()
})

test('changing one part of the ask leaves the rest of it standing', () => {
    const asked = asking(asking(FIRST_ASK, {canvas: 32}), {enforcePalette: false})

    expect(asked.canvas).toBe(32)
    expect(asked.enforcePalette).toBe(false)
    expect(asked.prompt).toBe(FIRST_ASK.prompt)
})

/*
 * The two small canvases, added 2026-08-11. A sprite sheet is mostly props, and a 16³ barrel is a
 * subject the model has fewer chances to get wrong than a 128³ figure.
 */
test('the small canvases are on offer and are narrowed like the rest', () => {
    expect(CANVAS_SIZES).toContain(8)
    expect(CANVAS_SIZES).toContain(16)
    expect(asking(FIRST_ASK, {canvas: 8}).canvas).toBe(8)
    expect(asking(FIRST_ASK, {canvas: 16}).canvas).toBe(16)
    // Still only the offered sizes: 4 and 12 are as off as 1000 is.
    expect(asking(FIRST_ASK, {canvas: 4}).canvas).toBeUndefined()
    expect(asking(FIRST_ASK, {canvas: 12}).canvas).toBeUndefined()
    // And the default has not moved: 32 is the ground every finding was measured on.
    expect(DEFAULT_CANVAS).toBe(32)
})
