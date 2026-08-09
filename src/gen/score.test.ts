import {expect, test} from 'bun:test'
import {createVolume, setVoxel, type Volume} from '../render/volume'
import {bboxFill, connectivity, overallScore, scoreModel, sliceUsage} from './score'

const box = (
    volume: Volume,
    [x0, y0, z0]: readonly [number, number, number],
    [x1, y1, z1]: readonly [number, number, number],
    value = 1
): Volume => {
    for (let x = x0; x <= x1; x += 1)
        for (let y = y0; y <= y1; y += 1)
            for (let z = z0; z <= z1; z += 1) setVoxel(volume, x, y, z, value)
    return volume
}

test('one lump is whole; a lump and a detached hat are not', () => {
    const one = box(createVolume(8, 8, 8), [0, 0, 0], [1, 1, 1])
    expect(connectivity(one)).toBe(1)

    const two = box(createVolume(8, 8, 8), [0, 0, 0], [1, 1, 1])
    setVoxel(two, 7, 7, 7, 1)
    expect(connectivity(two)).toBeCloseTo(8 / 9, 5)
})

test('voxels touching only at a corner are two lumps, matching selection', () => {
    const volume = createVolume(8, 8, 8)
    setVoxel(volume, 1, 1, 1, 1)
    setVoxel(volume, 2, 2, 1, 1)

    expect(connectivity(volume)).toBe(0.5)
})

test('an empty grid scores zero everywhere rather than dividing by nothing', () => {
    const scores = scoreModel(createVolume(4, 4, 4))

    expect(scores).toEqual({
        connectivity: 0,
        sliceUsage: 0,
        bboxFill: 0,
        colorsUsed: 0,
        voxels: 0
    })
})

test('slice usage is layers that hold something, over the height of the model', () => {
    // Half a grid, but a solid half: nothing is missing from the shape, so this is a 1.
    const half = box(createVolume(4, 4, 8), [0, 0, 0], [3, 3, 3])
    expect(sliceUsage(half)).toBe(1)

    const pancake = box(createVolume(4, 4, 8), [0, 0, 2], [3, 3, 2])
    expect(sliceUsage(pancake)).toBe(1)

    // A floating hat: 2 filled layers spanning 8, which is what the term is for.
    const floating = box(createVolume(4, 4, 8), [0, 0, 0], [3, 3, 0])
    box(floating, [0, 0, 7], [3, 3, 7])
    expect(sliceUsage(floating)).toBe(2 / 8)
})

test('a solid block fills its box; a hollow one does not', () => {
    const solid = box(createVolume(6, 6, 6), [0, 0, 0], [5, 5, 5])
    expect(bboxFill(solid)).toBe(1)

    const hollow = box(createVolume(6, 6, 6), [0, 0, 0], [5, 5, 5])
    box(hollow, [1, 1, 1], [4, 4, 4], 0)
    expect(bboxFill(hollow)).toBeCloseTo((216 - 64) / 216, 5)
})

test('colours counted are the ones on voxels, not the ones in the palette', () => {
    const volume = createVolume(4, 4, 4)
    setVoxel(volume, 0, 0, 0, 3)
    setVoxel(volume, 1, 0, 0, 3)
    setVoxel(volume, 2, 0, 0, 7)

    expect(scoreModel(volume).colorsUsed).toBe(2)
    expect(scoreModel(volume).voxels).toBe(3)
})

test('a solid brick sorts below a carved model, which is the failure mode this ranks against', () => {
    const brick = box(createVolume(8, 8, 8), [0, 0, 0], [7, 7, 7])
    const carved = box(createVolume(8, 8, 8), [0, 0, 0], [7, 7, 7])
    box(carved, [2, 2, 2], [5, 5, 7], 0)

    // The brick is perfect on every other measure — one component, every layer used — which is
    // exactly why fill had to change sign. Both are whole; only one has a silhouette.
    expect(connectivity(brick)).toBe(1)
    expect(sliceUsage(brick)).toBe(1)
    expect(overallScore(scoreModel(carved))).toBeGreaterThan(overallScore(scoreModel(brick)))
})

test('a cloud of debris does not win by being empty of its own box', () => {
    const debris = createVolume(8, 8, 8)
    for (let i = 0; i < 8; i += 1) setVoxel(debris, i, i, i, 1)
    const carved = box(createVolume(8, 8, 8), [0, 0, 0], [7, 7, 7])
    box(carved, [2, 2, 2], [5, 5, 7], 0)

    // Debris has almost no fill at all, so connectivity is what has to hold it down.
    expect(bboxFill(debris)).toBeLessThan(bboxFill(carved))
    expect(overallScore(scoreModel(carved))).toBeGreaterThan(overallScore(scoreModel(debris)))
})
