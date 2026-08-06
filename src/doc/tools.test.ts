import {describe, expect, test} from 'bun:test'
import {
    copySlice,
    ellipse,
    floodFill,
    line,
    mirrorVolume,
    plot,
    rect,
    replaceColor,
    type ToolContext
} from './tools'
import {Volume} from './volume'
import {createDocument, editCel, celAt} from './document'

const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({
    size: {sx: 16, sy: 16, sz: 16},
    ...extra
})

/** ASCII of one slice, for assertions a human can read. */
const slice = (volume: Volume, z: number, size = 8): string =>
    Array.from({length: size}, (_unused, y) =>
        Array.from({length: size}, (_unusedX, x) => (volume.get(x, y, z) === 0 ? '.' : '#')).join(
            ''
        )
    ).join('\n')

describe('plot', () => {
    test('clips to the canvas instead of writing outside it', () => {
        const volume = new Volume()
        expect(plot(volume, ctx(), 16, 0, 0, 3)).toBe(0)
        expect(plot(volume, ctx(), -1, 0, 0, 3)).toBe(0)
        expect(plot(volume, ctx(), 0, 0, 16, 3)).toBe(0)
        expect(volume.count).toBe(0)
    })

    test('mirror paints both sides in one call', () => {
        const volume = new Volume()
        expect(plot(volume, ctx({mirrorX: true}), 2, 5, 0, 7)).toBe(2)
        expect(volume.get(13, 5, 0)).toBe(7)

        const both = new Volume()
        expect(plot(both, ctx({mirrorX: true, mirrorY: true}), 2, 3, 0, 7)).toBe(4)
    })

    test('a voxel on the mirror axis is painted once, not twice', () => {
        const odd = new Volume()
        // sx 15 puts x=7 on the axis
        expect(plot(odd, {size: {sx: 15, sy: 15, sz: 15}, mirrorX: true}, 7, 1, 0, 4)).toBe(1)
    })

    test('a mirrored erase erases both sides', () => {
        const volume = new Volume()
        plot(volume, ctx({mirrorX: true}), 2, 5, 0, 7)
        expect(plot(volume, ctx({mirrorX: true}), 2, 5, 0, 0)).toBe(2)
        expect(volume.count).toBe(0)
    })
})

describe('line', () => {
    test('leaves no gap on a diagonal', () => {
        const volume = new Volume()
        expect(line(volume, ctx(), 0, 0, 7, 7, 0, 1)).toBe(8)
        expect(slice(volume, 0)).toBe(
            [
                '#.......',
                '.#......',
                '..#.....',
                '...#....',
                '....#...',
                '.....#..',
                '......#.',
                '.......#'
            ].join('\n')
        )
    })

    test('a shallow line steps once per column', () => {
        const volume = new Volume()
        expect(line(volume, ctx(), 0, 0, 7, 2, 0, 1)).toBe(8)
    })

    test('a single point is one voxel', () => {
        const volume = new Volume()
        expect(line(volume, ctx(), 3, 3, 3, 3, 0, 1)).toBe(1)
    })
})

describe('rect and ellipse', () => {
    test('an outline rect is hollow', () => {
        const volume = new Volume()
        rect(volume, ctx(), 1, 1, 5, 4, 0, 2, false)
        expect(slice(volume, 0)).toBe(
            [
                '........',
                '.#####..',
                '.#...#..',
                '.#...#..',
                '.#####..',
                '........',
                '........',
                '........'
            ].join('\n')
        )
    })

    test('a filled rect covers its whole box, in either drag direction', () => {
        const a = new Volume()
        const b = new Volume()
        expect(rect(a, ctx(), 1, 1, 4, 3, 0, 2)).toBe(12)
        expect(rect(b, ctx(), 4, 3, 1, 1, 0, 2)).toBe(12)
        expect(slice(a, 0)).toBe(slice(b, 0))
    })

    test('a filled ellipse is round and inside its box', () => {
        const volume = new Volume()
        ellipse(volume, ctx(), 0, 0, 6, 6, 0, 3)
        expect(slice(volume, 0)).toBe(
            [
                '..###...',
                '.#####..',
                '#######.',
                '#######.',
                '#######.',
                '.#####..',
                '..###...',
                '........'
            ].join('\n')
        )
    })

    test('an outline ellipse is hollow', () => {
        const volume = new Volume()
        ellipse(volume, ctx(), 0, 0, 6, 6, 0, 3, false)
        expect(volume.get(3, 3, 0)).toBe(0)
        expect(volume.get(3, 0, 0)).toBe(3)
    })
})

describe('floodFill', () => {
    test('fills up to a drawn boundary and no further', () => {
        const volume = new Volume()
        rect(volume, ctx(), 1, 1, 5, 5, 0, 2, false)

        expect(floodFill(volume, ctx(), 3, 3, 0, 4)).toBe(9)
        expect(volume.get(0, 0, 0)).toBe(0)
        expect(volume.get(1, 1, 0)).toBe(2)
    })

    test('does not leak into the slices above or below', () => {
        const volume = new Volume()
        floodFill(volume, ctx(), 0, 0, 5, 4)
        expect(volume.get(0, 0, 4)).toBe(0)
        expect(volume.get(0, 0, 5)).toBe(4)
    })

    test('filling with the colour already there is a no-op, not a hang', () => {
        const volume = new Volume()
        volume.set(2, 2, 0, 6)
        expect(floodFill(volume, ctx(), 2, 2, 0, 6)).toBe(0)
    })

    test('a mirrored fill reaches the far half the flood cannot walk to', () => {
        const painted = (mirrorX: boolean): number => {
            const volume = new Volume()
            // a wall down the middle, so the two halves are separate regions
            rect(volume, ctx(), 8, 0, 8, 15, 0, 2)
            floodFill(volume, ctx({mirrorX}), 0, 0, 0, 5)
            let n = 0
            volume.forEach((_x, _y, _z, color) => {
                if (color === 5) {
                    n += 1
                }
            })
            return n
        }

        // the flood alone stops at the wall; mirrored, the reflection covers the far half —
        // including the wall itself, which is the reflection of the last column it filled
        expect(painted(false)).toBe(8 * 16)
        expect(painted(true)).toBe(16 * 16)
    })
})

describe('volume-wide operations', () => {
    test('replaceColor swaps one index everywhere', () => {
        const volume = new Volume()
        rect(volume, ctx(), 0, 0, 3, 3, 0, 2)
        rect(volume, ctx(), 0, 0, 1, 1, 1, 3)

        expect(replaceColor(volume, 2, 9)).toBe(16)
        expect(volume.get(0, 0, 0)).toBe(9)
        expect(volume.get(0, 0, 1)).toBe(3)
        expect(replaceColor(volume, 9, 9)).toBe(0)
    })

    test('copySlice duplicates a slice, including its empty cells', () => {
        const volume = new Volume()
        rect(volume, ctx(), 1, 1, 4, 4, 0, 7)
        volume.set(0, 0, 3, 5)

        copySlice(volume, ctx(), 0, 3)
        expect(slice(volume, 3)).toBe(slice(volume, 0))
        expect(volume.get(0, 0, 3)).toBe(0)
    })

    test('mirrorVolume reflects the lower half onto the upper', () => {
        const volume = new Volume()
        volume.set(1, 2, 0, 4)
        volume.set(14, 9, 0, 8)

        expect(mirrorVolume(volume, ctx(), 'x')).toBe(1)
        expect(volume.get(14, 2, 0)).toBe(4)
        // the voxel already past the midline is a source for nothing
        expect(volume.get(1, 9, 0)).toBe(0)
    })
})

describe('tools through the document', () => {
    test('a whole stroke is one undoable edit', () => {
        const doc = createDocument({size: {sx: 16, sy: 16, sz: 16}})
        const drawn = editCel(doc, 0, 0, v => {
            line(v, ctx(), 0, 0, 15, 15, 0, 4)
            floodFill(v, ctx(), 0, 15, 0, 5)
        })

        expect(celAt(doc, 0, 0)).toBeNull()
        expect(celAt(drawn, 0, 0)?.count).toBeGreaterThan(100)
    })
})
