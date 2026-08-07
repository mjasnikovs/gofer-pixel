import {describe, expect, test} from 'bun:test'
import {
    applyStroke,
    beginStroke,
    copyToClipboard,
    deleteSelected,
    deselect,
    extendStroke,
    isSelectionTool,
    labelFor,
    pasteAt,
    selectAll,
    type EditorSnapshot,
    type Tool
} from './state'
import {addRamp, celAt, createDocument, editCel} from '../doc/document'
import {rectSelection, selectionBounds, selectionCount} from '../doc/selection'
import {PALETTE} from '../vox/palette'

const size = {sx: 16, sy: 16, sz: 8}

const snapshot = (): EditorSnapshot => ({
    doc: createDocument({size, palette: PALETTE}),
    selection: null,
    slice: 0,
    layer: 0,
    frame: 0
})

const drag = (
    base: EditorSnapshot,
    tool: Tool,
    path: [number, number][],
    color = 5
): ReturnType<typeof applyStroke> => {
    const first = path[0] ?? [0, 0]
    let stroke = beginStroke(tool, first, {color})
    for (const point of path.slice(1)) {
        stroke = extendStroke(stroke, point)
    }
    return applyStroke(base, stroke)
}

const cel = (snap: EditorSnapshot) => celAt(snap.doc, snap.layer, snap.frame)

describe('strokes', () => {
    test('a pencil drag paints the whole path, not just the sampled points', () => {
        const {snapshot: after, changed} = drag(snapshot(), 'pencil', [
            [0, 0],
            [5, 5]
        ])

        expect(changed).toBe(true)
        expect(cel(after)?.count).toBe(6)
        expect(cel(after)?.get(3, 3, 0)).toBe(5)
    })

    test('replaying a longer drag from the same base is stable', () => {
        const base = snapshot()
        const short = drag(base, 'pencil', [
            [0, 0],
            [2, 2]
        ])
        const long = drag(base, 'pencil', [
            [0, 0],
            [2, 2],
            [4, 4]
        ])

        // the base is untouched, so the longer replay is a superset of the shorter one
        expect(cel(base)).toBeNull()
        expect(cel(short.snapshot)?.count).toBe(3)
        expect(cel(long.snapshot)?.count).toBe(5)
    })

    test('the eraser clears rather than painting index 0 as a colour', () => {
        const drawn = drag(snapshot(), 'pencil', [
            [1, 1],
            [3, 1]
        ]).snapshot
        const erased = drag(drawn, 'eraser', [[2, 1]]).snapshot

        expect(cel(erased)?.count).toBe(2)
        expect(cel(erased)?.get(2, 1, 0)).toBe(0)
    })

    test('a stroke that changes nothing reports changed: false', () => {
        const drawn = drag(snapshot(), 'pencil', [[1, 1]]).snapshot
        expect(drag(drawn, 'pencil', [[1, 1]]).changed).toBe(false)
    })

    test('the eyedropper picks without touching the document', () => {
        const drawn = drag(snapshot(), 'pencil', [[2, 2]], 7).snapshot
        const picked = drag(drawn, 'eyedropper', [[2, 2]])

        expect(picked.pickedColor).toBe(7)
        expect(picked.snapshot.doc).toBe(drawn.doc)
        expect(picked.changed).toBe(false)
    })

    test('shade steps along the ramp under the cursor', () => {
        let base = snapshot()
        base = {...base, doc: addRamp(base.doc, {name: 'grey', indices: [1, 2, 3]})}
        base = {
            ...base,
            doc: editCel(base.doc, 0, 0, v => v.set(4, 4, 0, 2))
        }

        const lighter = drag(base, 'shade', [[4, 4]], 1)
        expect(cel(lighter.snapshot)?.get(4, 4, 0)).toBe(3)

        const darker = drag(base, 'shade', [[4, 4]], -1)
        expect(cel(darker.snapshot)?.get(4, 4, 0)).toBe(1)
    })

    test('shape tools use the drag start and the current point', () => {
        const rectangle = drag(snapshot(), 'rect', [
            [1, 1],
            [9, 9],
            [4, 4]
        ])
        expect(cel(rectangle.snapshot)?.count).toBe(16)
    })

    test('a stroke lands on the active slice, not always the bottom one', () => {
        const base = {...snapshot(), slice: 5}
        const after = drag(base, 'pencil', [[3, 3]]).snapshot

        expect(cel(after)?.get(3, 3, 5)).toBe(5)
        expect(cel(after)?.get(3, 3, 0)).toBe(0)
    })

    test('a locked layer cannot be drawn on', () => {
        const base = snapshot()
        const locked = {
            ...base,
            doc: {
                ...base.doc,
                layers: base.doc.layers.map(layer => ({...layer, locked: true}))
            }
        }
        expect(drag(locked, 'pencil', [[1, 1]]).changed).toBe(false)
    })
})

describe('selection clipping', () => {
    test('a stroke outside the selection is refused', () => {
        const base = {...snapshot(), selection: rectSelection(size, 0, 0, 3, 3)}

        expect(drag(base, 'pencil', [[8, 8]]).changed).toBe(false)
        expect(drag(base, 'pencil', [[1, 1]]).changed).toBe(true)
    })

    test('a line crossing the selection edge only paints the inside', () => {
        const base = {...snapshot(), selection: rectSelection(size, 0, 0, 3, 15)}
        const after = drag(base, 'pencil', [
            [0, 0],
            [8, 0]
        ]).snapshot

        expect(cel(after)?.count).toBe(4)
    })
})

describe('selection tools', () => {
    test('dragging a rectangle sets the selection and leaves voxels alone', () => {
        const result = drag(snapshot(), 'select', [
            [2, 2],
            [5, 6]
        ])

        expect(result.changed).toBe(false)
        expect(
            selectionBounds(result.snapshot.selection ?? rectSelection(size, 0, 0, 0, 0))
        ).toEqual({x0: 2, y0: 2, x1: 5, y1: 6})
    })

    test('the wand selects the region under the cursor', () => {
        const drawn = drag(snapshot(), 'rect', [
            [0, 0],
            [3, 3]
        ]).snapshot
        const wanded = drag(drawn, 'wand', [[1, 1]])

        expect(selectionCount(wanded.snapshot.selection ?? rectSelection(size, 0, 0, 0, 0))).toBe(
            16
        )
    })

    test('select all then deselect', () => {
        const all = selectAll(snapshot())
        expect(selectionCount(all.selection ?? rectSelection(size, 0, 0, 0, 0))).toBe(16 * 16)
        expect(deselect(all).selection).toBeNull()
    })

    test('every tool is either a selection tool or a drawing tool, and all are labelled', () => {
        const tools: Tool[] = [
            'pencil',
            'eraser',
            'line',
            'rect',
            'ellipse',
            'fill',
            'shade',
            'eyedropper',
            'select',
            'lasso',
            'wand',
            'move'
        ]
        for (const tool of tools) {
            expect(labelFor(tool).length).toBeGreaterThan(0)
        }
        expect(tools.filter(isSelectionTool)).toEqual(['select', 'lasso', 'wand'])
    })
})

describe('move, cut and paste', () => {
    const drawn = (): EditorSnapshot => {
        const after = drag(snapshot(), 'rect', [
            [1, 1],
            [3, 3]
        ]).snapshot
        return {...after, selection: rectSelection(size, 1, 1, 3, 3)}
    }

    test('a move drag carries the voxels and the marquee together', () => {
        const moved = drag(drawn(), 'move', [
            [2, 2],
            [7, 2]
        ]).snapshot

        expect(cel(moved)?.get(1, 1, 0)).toBe(0)
        expect(cel(moved)?.get(6, 1, 0)).toBe(5)
        expect(selectionBounds(moved.selection ?? rectSelection(size, 0, 0, 0, 0))).toEqual({
            x0: 6,
            y0: 1,
            x1: 8,
            y1: 3
        })
    })

    test('a move with nothing selected does nothing', () => {
        const base = {...drawn(), selection: null}
        expect(
            drag(base, 'move', [
                [2, 2],
                [7, 2]
            ]).changed
        ).toBe(false)
    })

    test('copy then paste onto another slice reproduces the shape', () => {
        const base = drawn()
        const clipboard = copyToClipboard(base)
        expect(clipboard).not.toBeNull()

        const pasted = clipboard ? pasteAt({...base, slice: 4, selection: null}, clipboard) : null
        expect(pasted?.changed).toBe(true)
        expect(cel(pasted?.snapshot ?? base)?.get(0, 0, 4)).toBe(5)
    })

    test('delete clears the selected cells only', () => {
        const {snapshot: after, changed} = deleteSelected(drawn())

        expect(changed).toBe(true)
        expect(cel(after)?.count).toBe(0)
    })

    test('delete with no selection is a no-op', () => {
        expect(deleteSelected(snapshot()).changed).toBe(false)
    })
})
