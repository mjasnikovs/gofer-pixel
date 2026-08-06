import {describe, expect, test} from 'bun:test'
import {Vox} from './grid'

describe('Vox', () => {
    test('writes and reads a cell', () => {
        const v = new Vox({sx: 8, sy: 8, sz: 8})
        v.set(1, 2, 3, 5)
        expect(v.get(1, 2, 3)).toBe(5)
        expect(v.get(3, 2, 1)).toBe(0)
    })

    test('drops out-of-bounds writes instead of wrapping', () => {
        const v = new Vox({sx: 4, sy: 4, sz: 4})
        v.set(4, 0, 0, 5)
        expect(v.filled).toBe(0)
    })

    test('box fills an inclusive range', () => {
        const v = new Vox({sx: 8, sy: 8, sz: 8})
        expect(v.box(0, 0, 0, 1, 1, 1, 2)).toBe(8)
        expect(v.filled).toBe(8)
    })

    test('mirrorX makes the model symmetric', () => {
        const v = new Vox({sx: 8, sy: 4, sz: 4})
        v.set(1, 0, 0, 7)
        v.mirrorX()
        expect(v.get(6, 0, 0)).toBe(7)
    })
})
