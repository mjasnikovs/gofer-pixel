import {describe, expect, test} from 'bun:test'
import {flipY, renderSlice, selectionOutline, toVoxel} from './canvas'
import {createDocument, editCel, celAt} from '../doc/document'
import {rectSelection} from '../doc/selection'
import {PALETTE} from '../vox/palette'

const size = {sx: 8, sy: 8, sz: 8}
const doc = () => createDocument({size, palette: PALETTE})

const pixel = (image: {width: number; data: Uint8Array}, x: number, y: number) => {
    const at = (y * image.width + x) * 4
    return [image.data[at], image.data[at + 1], image.data[at + 2], image.data[at + 3]]
}

describe('slice rendering', () => {
    test('the y axis flips, so voxel y=0 is the bottom row of the image', () => {
        expect(flipY(0, size)).toBe(7)
        expect(flipY(7, size)).toBe(0)

        const drawn = editCel(doc(), 0, 0, v => v.set(0, 0, 0, 5))
        const image = renderSlice(drawn, celAt(drawn, 0, 0), 0, {onionSkin: false})

        expect(pixel(image, 0, 7)[3]).toBe(255)
        expect(pixel(image, 0, 0)[3]).toBe(0)
    })

    test('onion skin draws the neighbouring slices faded and the active one solid', () => {
        const drawn = editCel(doc(), 0, 0, v => {
            v.set(1, 1, 0, 5)
            v.set(2, 1, 1, 5)
            v.set(3, 1, 2, 5)
        })
        const image = renderSlice(drawn, celAt(drawn, 0, 0), 1, {onionSkin: true, onionAlpha: 0.4})

        expect(pixel(image, 2, flipY(1, size))[3]).toBe(255)
        expect(pixel(image, 1, flipY(1, size))[3]).toBe(102)
        expect(pixel(image, 3, flipY(1, size))[3]).toBe(102)
    })

    test('onion skin off shows only the active slice', () => {
        const drawn = editCel(doc(), 0, 0, v => {
            v.set(1, 1, 0, 5)
            v.set(2, 1, 1, 5)
        })
        const image = renderSlice(drawn, celAt(drawn, 0, 0), 1, {onionSkin: false})

        expect(pixel(image, 1, flipY(1, size))[3]).toBe(0)
        expect(pixel(image, 2, flipY(1, size))[3]).toBe(255)
    })

    test('an empty cel renders transparent rather than throwing', () => {
        const image = renderSlice(doc(), null, 0)
        expect([...image.data].every(byte => byte === 0)).toBe(true)
    })
})

describe('selection outline', () => {
    test('only the edge cells are marked', () => {
        const outline = selectionOutline(rectSelection(size, 1, 1, 4, 4), size)
        const on = (x: number, y: number): boolean => outline[flipY(y, size) * size.sx + x] ?? false

        expect(on(1, 1)).toBe(true)
        expect(on(4, 4)).toBe(true)
        expect(on(2, 2)).toBe(false)
        expect(on(0, 0)).toBe(false)
    })

    test('a single selected cell is all edge', () => {
        const outline = selectionOutline(rectSelection(size, 3, 3, 3, 3), size)
        expect(outline.filter(Boolean).length).toBe(1)
    })
})

describe('pointer mapping', () => {
    const rect = {left: 100, top: 50, width: 320, height: 320}

    test('a click in the top-left corner is voxel (0, sy-1)', () => {
        expect(toVoxel(100, 50, rect, size)).toEqual([0, 7])
    })

    test('a click in the bottom-right corner is voxel (sx-1, 0)', () => {
        expect(toVoxel(419, 369, rect, size)).toEqual([7, 0])
    })

    test('a click outside the canvas clamps instead of returning nonsense', () => {
        expect(toVoxel(0, 0, rect, size)).toEqual([0, 7])
        expect(toVoxel(9999, 9999, rect, size)).toEqual([7, 0])
    })

    test('the middle of a cell and its edges map to the same voxel', () => {
        expect(toVoxel(140, 90, rect, size)).toEqual(toVoxel(159, 129, rect, size))
    })
})

describe('frame onion skin', () => {
    test('the neighbouring frames draw faded under the active one, tinted apart', () => {
        const base = editCel(doc(), 0, 0, v => {
            v.set(1, 1, 0, 5)
        })
        const before = editCel(doc(), 0, 0, v => {
            v.set(2, 1, 0, 5)
        })
        const after = editCel(doc(), 0, 0, v => {
            v.set(3, 1, 0, 5)
        })

        const image = renderSlice(base, celAt(base, 0, 0), 0, {
            onionSkin: false,
            frameOnion: {before: celAt(before, 0, 0), after: celAt(after, 0, 0)}
        })

        const active = pixel(image, 1, flipY(1, size))
        const ghostBefore = pixel(image, 2, flipY(1, size))
        const ghostAfter = pixel(image, 3, flipY(1, size))

        expect(active[3]).toBe(255)
        expect(ghostBefore[3]).toBeGreaterThan(0)
        expect(ghostBefore[3]).toBeLessThan(255)
        expect(ghostAfter[3]).toBe(ghostBefore[3])
        // warm for the frame before, cool for the frame after
        expect(ghostBefore[0]).toBeGreaterThan(active[0] ?? 0)
        expect(ghostAfter[2]).toBeGreaterThan(active[2] ?? 0)
    })

    test('no neighbouring frames is the same picture as no option at all', () => {
        const drawn = editCel(doc(), 0, 0, v => {
            v.set(1, 1, 0, 5)
        })
        const plain = renderSlice(drawn, celAt(drawn, 0, 0), 0, {onionSkin: false})
        const empty = renderSlice(drawn, celAt(drawn, 0, 0), 0, {
            onionSkin: false,
            frameOnion: {before: null, after: null}
        })
        expect(empty.data).toEqual(plain.data)
    })
})
