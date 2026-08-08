import {expect, test} from 'bun:test'
import {createVolume} from '../render/volume'
import {canRadial, isSymmetric, NO_SYMMETRY, symmetricCells, symmetryMaps} from './symmetry'

/**
 * Mirrored drawing — `FEATURESET.md` §12.
 *
 * The maps rather than the cells, because a *drag* has to mirror its two endpoints and draw a line
 * between each mirrored pair. Mirroring the cells of an already-walked line would work too, and it
 * would walk the line once per image — the line being the expensive part.
 */
const square = createVolume(8, 8, 6, new Uint8Array(256 * 4))
const oblong = createVolume(8, 5, 6, new Uint8Array(256 * 4))

test('no symmetry is one map, and it is the identity', () => {
    const [only, ...rest] = symmetryMaps(square, NO_SYMMETRY)

    expect(rest).toEqual([])
    expect(only?.([3, 1, 2])).toEqual([3, 1, 2])
    expect(isSymmetric(NO_SYMMETRY)).toBe(false)
})

/*
 * Each plane doubles the images, because every existing image gets a mirror of its own. Three
 * planes is therefore eight, not four — the corner cases are what an artist building a symmetric
 * model is relying on.
 */
test('each plane doubles the images, so all three give eight', () => {
    expect(symmetryMaps(square, {...NO_SYMMETRY, x: true})).toHaveLength(2)
    expect(symmetryMaps(square, {...NO_SYMMETRY, x: true, y: true})).toHaveLength(4)
    expect(symmetryMaps(square, {x: true, y: true, z: true, radial: false})).toHaveLength(8)
    expect(isSymmetric({...NO_SYMMETRY, z: true})).toBe(true)
})

test('a mirror reflects across the grid, not across the origin', () => {
    const [, mirrored] = symmetryMaps(square, {...NO_SYMMETRY, x: true})

    // Eight wide, so 0 and 7 are the pair and the reflection is `size - 1 - x`.
    expect(mirrored?.([0, 2, 1])).toEqual([7, 2, 1])
    expect(mirrored?.([7, 2, 1])).toEqual([0, 2, 1])
    // The other two axes are left alone, or a mirror would be a rotation.
    expect(mirrored?.([3, 4, 5])).toEqual([4, 4, 5])
})

test('radial is four-fold, and needs a grid that is square in X and Y', () => {
    expect(canRadial(square)).toBe(true)
    expect(canRadial(oblong)).toBe(false)

    expect(symmetryMaps(square, {...NO_SYMMETRY, radial: true})).toHaveLength(4)
    // Asked for on a grid that cannot carry it, it is simply not applied — the panel disables the
    // control, and the maps refuse it again rather than trusting the panel.
    expect(symmetryMaps(oblong, {...NO_SYMMETRY, radial: true})).toHaveLength(1)

    // Four quarter turns bring a cell back to itself, which is what makes it a rotation.
    const maps = symmetryMaps(square, {...NO_SYMMETRY, radial: true})
    const quarter = maps[1]
    if (!quarter) throw new Error('a radial grid has a quarter turn')
    expect(quarter(quarter(quarter(quarter([1, 0, 2]))))).toEqual([1, 0, 2])
    // And the vertical axis is the one it turns about, so z never moves.
    for (const map of maps) expect(map([1, 0, 2])[2]).toBe(2)
})

test('radial on top of a plane multiplies rather than replaces', () => {
    expect(symmetryMaps(square, {...NO_SYMMETRY, x: true, radial: true})).toHaveLength(8)
})

/*
 * A cell sitting on a mirror plane is its own image, so the writes have to be deduplicated or a
 * stroke down the centre line would paint the same voxel twice — harmless for draw, wrong for
 * anything that counts what it changed.
 */
test('a cell on the mirror is written once, not twice', () => {
    const centred = createVolume(7, 7, 6, new Uint8Array(256 * 4))

    expect(symmetricCells(centred, {...NO_SYMMETRY, x: true}, [3, 1, 1])).toEqual([[3, 1, 1]])
    expect(symmetricCells(centred, {...NO_SYMMETRY, x: true}, [0, 1, 1])).toEqual([
        [0, 1, 1],
        [6, 1, 1]
    ])
})

test('an image that would land outside the grid is dropped rather than clamped', () => {
    // Nothing here can leave an 8-wide grid, so the count is the honest one: a mirror of a cell
    // inside the box is inside the box.
    expect(
        symmetricCells(square, {x: true, y: true, z: true, radial: false}, [1, 2, 3])
    ).toHaveLength(8)
})
