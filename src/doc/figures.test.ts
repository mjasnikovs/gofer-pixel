import {expect, test} from 'bun:test'
import {ellipseFigure, figureCells, lineFigure, rectFigure, rectFillFigure} from './figures'
import type {Offset} from './brush'

const key = (cell: Offset): string => cell.join(',')
const keys = (cells: readonly Offset[]): string[] => [...new Set(cells.map(key))].sort()

test('a line has no gaps and both of its ends', () => {
    const cells = lineFigure([0, 0, 0], [7, 3, 0])
    expect(cells[0]).toEqual([0, 0, 0])
    expect(cells.at(-1)).toEqual([7, 3, 0])
    // One cell per step of the longest axis, so nothing is skipped along it.
    expect(new Set(cells.map(cell => cell[0])).size).toBe(8)
})

test('a rectangle is a border, not a slab, and a one-cell drag is one cell', () => {
    const cells = keys(rectFigure([1, 1, 4], [5, 3, 4], 2))
    // 5 × 3 border is 12 cells; the 3 × 1 inside is not in it.
    expect(cells).toHaveLength(12)
    expect(cells).not.toContain('2,2,4')
    expect(cells).toContain('1,1,4')
    expect(cells).toContain('5,3,4')
    for (const cell of rectFigure([1, 1, 4], [5, 3, 4], 2)) expect(cell[2]).toBe(4)

    expect(keys(rectFigure([2, 2, 0], [2, 2, 0], 2))).toEqual(['2,2,0'])
    // A one-voxel-wide drag is a line of cells, each counted once rather than twice.
    expect(keys(rectFigure([0, 0, 0], [0, 4, 0], 2))).toHaveLength(5)
})

test('a filled rectangle is the whole slab, on one layer, however the drag ran', () => {
    const cells = keys(rectFillFigure([1, 1, 4], [5, 3, 4], 2))
    expect(cells).toHaveLength(15)
    expect(cells).toContain('2,2,4')
    expect(cells).toEqual(keys(rectFillFigure([5, 3, 4], [1, 1, 4], 2)))
    for (const cell of rectFillFigure([1, 1, 4], [5, 3, 4], 2)) expect(cell[2]).toBe(4)

    // It is a superset of the outline it fills, and a one-cell drag is still one cell.
    for (const cell of keys(rectFigure([1, 1, 4], [5, 3, 4], 2))) expect(cells).toContain(cell)
    expect(keys(rectFillFigure([2, 2, 0], [2, 2, 0], 2))).toEqual(['2,2,0'])
})

test('an ellipse is a closed ring with nothing inside it', () => {
    const cells = keys(ellipseFigure([0, 0, 0], [8, 8, 0], 2))
    expect(cells.length).toBeGreaterThan(8)
    // The middle of a nine-wide ellipse is inside, so it is not on the boundary.
    expect(cells).not.toContain('4,4,0')
    // It is closed: every row the ellipse spans has at least one cell in it.
    const rows = new Set(cells.map(cell => cell.split(',')[1]))
    expect(rows.size).toBe(9)

    // And it fits the box it was dragged in, both ways round.
    for (const [x, y] of ellipseFigure([0, 0, 0], [8, 4, 0], 2)) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(8)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(4)
    }
})

test('every figure stays on the plane it was started on', () => {
    for (const axis of [0, 1, 2] as const) {
        const from: Offset = [3, 3, 3]
        const to: Offset = [7, 6, 3]
        // The two ends share the layer, which is what a plane-locked stroke guarantees.
        const ends: Offset = [...to] as unknown as Offset
        for (const figure of ['rect', 'rectFill', 'ellipse'] as const) {
            for (const cell of figureCells(figure, from, ends, axis)) {
                expect(cell[axis]).toBe(from[axis])
            }
        }
    }
})
