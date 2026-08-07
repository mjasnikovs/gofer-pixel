import {expect, test} from 'bun:test'
import {createVolume, setVoxel, voxelAt} from '../render/volume'
import {clampLayer, layerCount, slicedVolume} from './slice'

/** A solid block, so every layer is there to be cut away or kept. */
const block = () => {
    const volume = createVolume(4, 4, 6, new Uint8Array(256 * 4))
    for (let z = 0; z < 6; z += 1) {
        for (let y = 0; y < 4; y += 1) {
            for (let x = 0; x < 4; x += 1) setVoxel(volume, x, y, z, z + 1)
        }
    }
    return volume
}

test('a layer count is the grid’s own depth along that axis, and a step stops at the ends', () => {
    const volume = block()
    expect([layerCount(volume, 0), layerCount(volume, 1), layerCount(volume, 2)]).toEqual([4, 4, 6])
    expect(clampLayer(volume, 2, 99)).toBe(5)
    expect(clampLayer(volume, 2, -4)).toBe(0)
    expect(clampLayer(volume, 2, 2.6)).toBe(3)
})

test('the layers in front of the slice go and the ones behind stay', () => {
    const volume = block()
    // Looking down: forward's z is negative, so the high layers are the near ones.
    const down = slicedVolume(volume, {axis: 2, layer: 2}, [0, 0, -1])
    expect(voxelAt(down, 0, 0, 3)).toBe(0)
    expect(voxelAt(down, 0, 0, 2)).toBe(3)
    expect(voxelAt(down, 0, 0, 0)).toBe(1)

    // Turn the model over and the cut turns with it, or it would be behind the artist.
    const up = slicedVolume(volume, {axis: 2, layer: 2}, [0, 0, 1])
    expect(voxelAt(up, 0, 0, 1)).toBe(0)
    expect(voxelAt(up, 0, 0, 2)).toBe(3)
    expect(voxelAt(up, 0, 0, 5)).toBe(6)
})

test('a camera looking along the plane has no front to cut, so nothing is cut', () => {
    const volume = block()
    expect(slicedVolume(volume, {axis: 2, layer: 2}, [1, 0, 0])).toBe(volume)
})

test('slicing empties cells rather than resizing, and leaves ownership alone', () => {
    const volume = block()
    volume.owner.fill(1)
    const cut = slicedVolume(volume, {axis: 2, layer: 2}, [0, 0, -1])

    expect([cut.sx, cut.sy, cut.sz]).toEqual([4, 4, 6])
    expect(cut.owner).toBe(volume.owner)
    // The document is untouched: slicing is a way of looking, not an edit.
    expect(voxelAt(volume, 0, 0, 5)).toBe(6)
})
