import {expect, test} from 'bun:test'
import {previewScale, wholeRows} from './preview'

/*
 * The preview's scale on screen — `previewScale`.
 *
 * Measured in Chromium before this existed: a 64 px sprite was drawn 129.856 px wide, because the
 * canvas was `width: 100%` of a fluid grid column. 2.029×, under `image-rendering: pixelated`, is
 * most source pixels at two screen pixels and every thirty-fourth at three. `PixelCanvas`'s own
 * comment forbids exactly that, and it was happening in the panel whose job is to show the file.
 *
 * Arithmetic only — happy-dom has no `ResizeObserver` and lays nothing out, so the browser suite
 * is what proves the number reaches the canvas.
 */
test('a sprite pixel gets a whole number of screen pixels, or one', () => {
    // The width the dialog actually had: four columns, three 4 px gaps.
    expect(previewScale(531, 64)).toBe(2)
    expect(previewScale(531, 32)).toBe(4)
    expect(previewScale(531, 128)).toBe(1)
})

test('a fractional scale is always rounded down, never up', () => {
    // 2.9 each. Rounding up would clip; rounding to nearest would resample.
    expect(previewScale(4 * 2.9 * 32 + 12, 32)).toBe(2)
    expect(previewScale(4 * 3.999 * 32 + 12, 32)).toBe(3)
})

test('a sprite too big for its column is clipped rather than shrunk', () => {
    // A half-scale preview is the same lie as a 2.029 one, in the other direction.
    expect(previewScale(100, 128)).toBe(1)
    expect(previewScale(0, 128)).toBe(1)
})

test('the column count is part of the question', () => {
    expect(previewScale(531, 64, 2)).toBe(4)
    expect(previewScale(531, 64, 8)).toBe(1)
})

/*
 * A list that scrolls must not cut a row in half — `wholeRows`.
 *
 * At a 900 px window the map list was seven rows and a sliver of the eighth: a scrollbar for half
 * an item. Same rule as `previewScale`: nothing on screen is a fraction of a thing.
 */

/** Eight rows: the first 36 px, the rest 37 because of the rule above each one. */
const EDGES = [36, 73, 110, 147, 184, 221, 258, 295]

test('a list stops on a row boundary rather than part way through one', () => {
    expect(wholeRows(243, EDGES)).toBe(221)
    expect(wholeRows(148, EDGES)).toBe(147)
    expect(wholeRows(295, EDGES)).toBe(295)
})

/*
 * The bug this replaced an average with real edges for: eight rows averaging 36.875 comes to 295,
 * but seven of that average is 258.1 — a tenth of a pixel past the seventh row's real bottom, which
 * is enough to show a sliver of the eighth.
 */
test('a row that ends just past the room does not count as fitting', () => {
    expect(wholeRows(258.1, EDGES)).toBe(258)
    expect(wholeRows(257.9, EDGES)).toBe(221)
})

test('a list with room to spare is not stretched past its last row', () => {
    expect(wholeRows(400, EDGES)).toBe(295)
})

test('one row is the floor, however little room there is', () => {
    expect(wholeRows(10, EDGES)).toBe(36)
    expect(wholeRows(0, EDGES)).toBe(36)
})

/* A list that has not been measured yet has no rows, and guessing one would move it twice. */
test('an unmeasured list is left exactly as it is', () => {
    expect(wholeRows(243, [])).toBe(243)
})
