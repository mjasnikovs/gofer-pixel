import {describe, expect, test} from 'bun:test'
import {History} from './history'
import {createDocument, documentBytes, editCel, type Document} from './document'
import {CHUNK_SIZE} from './volume'

const start = (): Document => createDocument({size: {sx: 32, sy: 32, sz: 32}})

const draw = (doc: Document, x: number): Document => editCel(doc, 0, 0, v => v.set(x, 0, 0, 4))

describe('History', () => {
    test('undo and redo walk the stack', () => {
        const history = new History(start())
        const initial = history.current
        const one = draw(initial, 1)
        history.commit(one, 'pencil')
        const two = draw(one, 2)
        history.commit(two, 'pencil')

        expect(history.current).toBe(two)
        expect(history.undo()).toBe(one)
        expect(history.undo()).toBe(initial)
        expect(history.canUndo).toBe(false)
        expect(history.redo()).toBe(one)
        expect(history.redo()).toBe(two)
        expect(history.canRedo).toBe(false)
    })

    test('undoing past the start or redoing past the end stays put', () => {
        const history = new History(start())
        const initial = history.current
        expect(history.undo()).toBe(initial)
        expect(history.redo()).toBe(initial)
    })

    test('committing after an undo discards the abandoned branch', () => {
        const history = new History(start())
        const a = draw(history.current, 1)
        history.commit(a, 'a')
        history.commit(draw(a, 2), 'b')
        history.undo()

        const c = draw(history.current, 3)
        history.commit(c, 'c')

        expect(history.labels).toEqual(['open', 'a', 'c'])
        expect(history.canRedo).toBe(false)
    })

    test('a commit that changes nothing is dropped', () => {
        const history = new History(start())
        history.commit(history.current, 'noop')
        expect(history.length).toBe(1)
    })

    test('replace updates the current entry without growing the stack', () => {
        const history = new History(start())
        const a = draw(history.current, 1)
        history.commit(a, 'pencil')

        const b = draw(a, 2)
        history.replace(b)

        expect(history.length).toBe(2)
        expect(history.current).toBe(b)
        expect(history.labels).toEqual(['open', 'pencil'])
        expect(history.undo().layers[0]?.cels[0]).toBeNull()
    })

    test('labels name the edit undo would reverse', () => {
        const history = new History(start())
        history.commit(draw(history.current, 1), 'pencil')
        history.commit(draw(history.current, 2), 'fill')

        expect(history.undoLabel).toBe('fill')
        expect(history.redoLabel).toBeNull()
        history.undo()
        expect(history.undoLabel).toBe('pencil')
        expect(history.redoLabel).toBe('fill')
    })

    test('the entry cap drops the oldest and keeps the cursor on the newest', () => {
        const history = new History(start(), {maxEntries: 3})
        for (let i = 1; i <= 5; i += 1) {
            history.commit(draw(history.current, i), `edit ${String(i)}`)
        }

        expect(history.length).toBe(3)
        expect(history.labels).toEqual(['edit 3', 'edit 4', 'edit 5'])
        expect(history.current.layers[0]?.cels[0]?.count).toBe(5)
    })

    /**
     * The claim this whole design rests on: with copy-on-write, an undo entry costs the voxels
     * the edit touched, not the model. A hundred one-voxel edits to a full 32³ document must not
     * cost a hundred copies of it.
     */
    test('a hundred snapshots of a 32³ model cost far less than a hundred models', () => {
        const filled = editCel(start(), 0, 0, v =>
            v.fillBox({x0: 0, y0: 0, z0: 0, x1: 31, y1: 31, z1: 31}, 4)
        )
        const one = documentBytes([filled])
        const history = new History(filled, {measure: documentBytes})

        for (let i = 0; i < 100; i += 1) {
            history.commit(
                editCel(history.current, 0, 0, v => v.set(i % 32, 1, 1, 9)),
                'pencil'
            )
        }

        expect(one).toBe(32 ** 3)
        // four chunk columns touched, one fresh copy of each per commit that crosses into it
        expect(history.bytes).toBeLessThan(one * 4)
        expect(history.bytes / 100).toBeLessThan(one / 10)
    })

    test('the byte cap evicts until the stack fits, never below one entry', () => {
        const filled = editCel(start(), 0, 0, v =>
            v.fillBox({x0: 0, y0: 0, z0: 0, x1: 31, y1: 31, z1: 31}, 4)
        )
        const history = new History(filled, {
            measure: documentBytes,
            maxBytes: documentBytes([filled]) + CHUNK_SIZE ** 3 * 2
        })

        for (let i = 0; i < 20; i += 1) {
            history.commit(
                editCel(history.current, 0, 0, v => v.set(i, i, i, 9)),
                'pencil'
            )
        }

        expect(history.length).toBeGreaterThanOrEqual(1)
        expect(history.length).toBeLessThan(20)
        expect(history.bytes).toBeLessThanOrEqual(documentBytes([filled]) + CHUNK_SIZE ** 3 * 2)
        expect(history.current.layers[0]?.cels[0]?.get(19, 19, 19)).toBe(9)
    })
})
