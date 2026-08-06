import {describe, expect, test} from 'bun:test'
import {
    clearSelection,
    copySelection,
    emptySelection,
    intersectSelection,
    invertSelection,
    isEmptySelection,
    isSelected,
    lassoSelection,
    moveSelection,
    offsetSelection,
    pasteClipboard,
    rectSelection,
    selectionBounds,
    selectionCount,
    subtractSelection,
    unionSelection,
    wandSelection
} from './selection'
import {Volume} from './volume'
import {rect} from './tools'
import {createDocument, celAt, editCel} from './document'

const size = {sx: 8, sy: 8, sz: 8}
const ctx = {size}

describe('making selections', () => {
    test('a rectangle selects its inclusive box and clips to the canvas', () => {
        const selection = rectSelection(size, 1, 1, 3, 2)
        expect(selectionCount(selection)).toBe(6)
        expect(isSelected(selection, 1, 1)).toBe(true)
        expect(isSelected(selection, 3, 2)).toBe(true)
        expect(isSelected(selection, 4, 2)).toBe(false)

        expect(selectionCount(rectSelection(size, -5, -5, 1, 1))).toBe(4)
    })

    test('an empty selection reports itself as one', () => {
        expect(isEmptySelection(emptySelection(size))).toBe(true)
        expect(selectionBounds(emptySelection(size))).toBeNull()
    })

    test('a lasso fills the traced polygon', () => {
        const triangle = lassoSelection(size, [
            [0, 0],
            [6, 0],
            [0, 6]
        ])
        expect(isSelected(triangle, 1, 1)).toBe(true)
        expect(isSelected(triangle, 5, 5)).toBe(false)
        // roughly half the 6×6 box
        expect(selectionCount(triangle)).toBeGreaterThan(12)
        expect(selectionCount(triangle)).toBeLessThan(24)
    })

    test('fewer than three points selects nothing rather than throwing', () => {
        expect(
            selectionCount(
                lassoSelection(size, [
                    [0, 0],
                    [1, 1]
                ])
            )
        ).toBe(0)
    })

    test('the wand takes the contiguous same-colour run, not every matching cell', () => {
        const volume = new Volume()
        rect(volume, ctx, 0, 0, 2, 2, 0, 5)
        rect(volume, ctx, 6, 6, 7, 7, 0, 5) // same colour, not connected

        const selection = wandSelection(volume, size, 0, 0, 0)
        expect(selectionCount(selection)).toBe(9)
        expect(isSelected(selection, 6, 6)).toBe(false)
    })

    test('the wand on empty space selects the empty region', () => {
        const volume = new Volume()
        rect(volume, ctx, 0, 0, 7, 3, 0, 5)
        expect(selectionCount(wandSelection(volume, size, 0, 7, 0))).toBe(8 * 4)
    })
})

describe('combining selections', () => {
    const a = rectSelection(size, 0, 0, 3, 3)
    const b = rectSelection(size, 2, 2, 5, 5)

    test('union, intersect and subtract', () => {
        expect(selectionCount(unionSelection(a, b))).toBe(16 + 16 - 4)
        expect(selectionCount(intersectSelection(a, b))).toBe(4)
        expect(selectionCount(subtractSelection(a, b))).toBe(12)
    })

    test('invert flips every cell', () => {
        expect(selectionCount(invertSelection(a))).toBe(64 - 16)
    })

    test('offsetting drops what falls off the canvas', () => {
        expect(selectionCount(offsetSelection(a, 6, 0))).toBe(8)
    })
})

describe('clipboard', () => {
    const drawn = (): Volume => {
        const volume = new Volume()
        rect(volume, ctx, 1, 1, 3, 3, 0, 5)
        volume.set(2, 2, 0, 7)
        return volume
    }

    test('copy lifts the selected cells, empty ones included', () => {
        const volume = drawn()
        const clipboard = copySelection(volume, rectSelection(size, 1, 1, 3, 3), 0)

        expect(clipboard?.width).toBe(3)
        expect(clipboard?.height).toBe(3)
        expect(clipboard?.cells[4]).toBe(7)
        expect(clipboard?.cells[0]).toBe(5)
    })

    test('copying nothing gives null, not an empty clipboard to paste by accident', () => {
        expect(copySelection(drawn(), emptySelection(size), 0)).toBeNull()
    })

    test('a selected hole stays a hole when pasted over something', () => {
        const source = new Volume()
        rect(source, ctx, 0, 0, 2, 2, 0, 5)
        source.set(1, 1, 0, 0) // punch the middle out

        const clipboard = copySelection(source, rectSelection(size, 0, 0, 2, 2), 0)
        const target = new Volume()
        rect(target, ctx, 0, 0, 7, 7, 0, 9)

        expect(clipboard).not.toBeNull()
        if (clipboard) {
            pasteClipboard(target, clipboard, size, 0, 0, 0)
        }
        expect(target.get(1, 1, 0)).toBe(0)
        expect(target.get(0, 0, 0)).toBe(5)
        expect(target.get(4, 4, 0)).toBe(9)
    })

    test('paste onto another slice leaves the source slice alone', () => {
        const volume = drawn()
        const clipboard = copySelection(volume, rectSelection(size, 1, 1, 3, 3), 0)
        if (clipboard) {
            pasteClipboard(volume, clipboard, size, 1, 1, 4)
        }

        expect(volume.get(2, 2, 4)).toBe(7)
        expect(volume.get(2, 2, 0)).toBe(7)
    })

    test('paste clips at the canvas edge instead of piling up against it', () => {
        const volume = drawn()
        const clipboard = copySelection(volume, rectSelection(size, 1, 1, 3, 3), 0)
        const target = new Volume()
        if (clipboard) {
            pasteClipboard(target, clipboard, size, 7, 7, 0)
        }

        expect(target.count).toBe(1)
        expect(target.get(7, 7, 0)).toBe(5)
    })

    test('clear empties the selected cells and nothing else', () => {
        const volume = drawn()
        clearSelection(volume, rectSelection(size, 2, 2, 3, 3), 0)

        expect(volume.get(2, 2, 0)).toBe(0)
        expect(volume.get(1, 1, 0)).toBe(5)
    })
})

describe('moving', () => {
    test('a move that overlaps its own source does not eat itself', () => {
        const volume = new Volume()
        rect(volume, ctx, 0, 0, 3, 0, 0, 5)

        moveSelection(volume, rectSelection(size, 0, 0, 3, 0), size, 1, 0, 0)

        expect(volume.count).toBe(4)
        expect(volume.get(0, 0, 0)).toBe(0)
        expect(volume.get(1, 0, 0)).toBe(5)
        expect(volume.get(4, 0, 0)).toBe(5)
    })

    test('the returned selection follows the voxels', () => {
        const volume = new Volume()
        rect(volume, ctx, 1, 1, 2, 2, 0, 5)

        const moved = moveSelection(volume, rectSelection(size, 1, 1, 2, 2), size, 2, 3, 0)
        expect(selectionBounds(moved)).toEqual({x0: 3, y0: 4, x1: 4, y1: 5})
    })

    test('a move between slices leaves the old slice empty', () => {
        const volume = new Volume()
        rect(volume, ctx, 1, 1, 2, 2, 0, 5)

        moveSelection(volume, rectSelection(size, 1, 1, 2, 2), size, 0, 0, 0, 3)
        expect(volume.get(1, 1, 0)).toBe(0)
        expect(volume.get(1, 1, 3)).toBe(5)
    })

    test('moving off the canvas discards what leaves it', () => {
        const volume = new Volume()
        rect(volume, ctx, 0, 0, 1, 0, 0, 5)

        moveSelection(volume, rectSelection(size, 0, 0, 1, 0), size, 7, 0, 0)
        expect(volume.count).toBe(1)
    })
})

describe('selection through the document', () => {
    test('a move is one undoable edit like any other', () => {
        const doc = editCel(createDocument({size}), 0, 0, v => rect(v, ctx, 0, 0, 2, 2, 0, 4))
        const selection = rectSelection(size, 0, 0, 2, 2)
        const moved = editCel(doc, 0, 0, v => {
            moveSelection(v, selection, size, 3, 3, 0)
        })

        expect(celAt(doc, 0, 0)?.get(0, 0, 0)).toBe(4)
        expect(celAt(moved, 0, 0)?.get(0, 0, 0)).toBe(0)
        expect(celAt(moved, 0, 0)?.get(3, 3, 0)).toBe(4)
    })
})
