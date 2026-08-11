import {expect, test} from 'bun:test'
import {beganSpan, measured, type Span} from './measure'

/**
 * The one decision in this module is what "how far apart" means, and it is the decision that makes
 * every reading right or off by one. So it is here rather than left to be checked by eye against a
 * model on screen, which is the one place an off-by-one in a ruler is invisible.
 */

const span = (from: [number, number, number], to: [number, number, number]): Span => ({
    from,
    to,
    live: false
})

test('one voxel is one voxel across, and nothing is ever zero wide', () => {
    const {size, diagonal, box} = measured(beganSpan([4, 5, 6]))
    // The reading an artist gets by tapping a single voxel. Zero would be arithmetic about the gap
    // between the two ends, which is not what anybody counts.
    expect(size).toEqual([1, 1, 1])
    expect(box.min).toEqual([4, 5, 6])
    expect(box.max).toEqual([4, 5, 6])
    // The diagonal is a length rather than a count, so it is zero — the two ends are the same place.
    expect(diagonal).toBe(0)
})

test('the size counts both ends, so a four-tall leg reads four', () => {
    // Bottom voxel to top voxel of a leg four voxels tall. The delta is 3 and the answer is 4,
    // because 4 is the number of voxels the artist would count.
    const {size} = measured(span([2, 2, 0], [2, 2, 3]))
    expect(size).toEqual([1, 1, 4])
})

test('the diagonal does not count both ends, and the two disagree on purpose', () => {
    const {size, diagonal} = measured(span([0, 0, 0], [3, 4, 0]))
    // Five voxels of size across x and four across y — inclusive.
    expect(size).toEqual([4, 5, 1])
    // And a 3-4-5 triangle between the centres, which is a length and takes no `+ 1`. The two
    // numbers are counted differently and the hint bar's tooltip is where that is said out loud.
    expect(diagonal).toBe(5)
})

test('a tape dragged backwards measures the same as one dragged forwards', () => {
    const forwards = measured(span([1, 2, 3], [5, 2, 9]))
    const backwards = measured(span([5, 2, 9], [1, 2, 3]))
    expect(backwards.size).toEqual(forwards.size)
    expect(backwards.diagonal).toBe(forwards.diagonal)
    // The box is the same box either way, which is what the overlay outlines. The *line* inside it
    // is not — that runs `from` to `to`, and `spanMesh` takes the ends for exactly that reason.
    expect(backwards.box).toEqual(forwards.box)
})

test('a fresh tape has both ends in one place and knows the button is down', () => {
    const started = beganSpan([7, 7, 7])
    expect(started.to).toEqual(started.from)
    expect(started.live).toBe(true)
})
