import {expect, test} from 'bun:test'
import {createVolume, filledBounds, setVoxel} from './volume'

test('the filled box is the voxels, not the grid they are lying in', () => {
    const volume = createVolume(32, 32, 20)
    // An empty document has no model, and callers have to be able to tell that apart from a model
    // that happens to sit at the origin.
    expect(filledBounds(volume)).toBeUndefined()

    setVoxel(volume, 12, 14, 9, 1)
    setVoxel(volume, 14, 14, 9, 1)
    setVoxel(volume, 15, 20, 3, 2)
    expect(filledBounds(volume)).toEqual({min: [12, 14, 3], max: [15, 20, 9]})

    // This is the whole point of it: three voxels in a 32³ grid describe a box a fraction of the
    // size, and the ground grid masks the small one. Masking the big one left no floor at all.
    setVoxel(volume, 12, 14, 9, 0)
    setVoxel(volume, 14, 14, 9, 0)
    setVoxel(volume, 15, 20, 3, 0)
    expect(filledBounds(volume)).toBeUndefined()
})
