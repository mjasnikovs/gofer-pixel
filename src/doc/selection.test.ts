import {expect, test} from 'bun:test'
import {basisFor, type Camera} from './../render/camera'
import {render} from '../render/raycast'
import {createVolume, setVoxel, voxelIndex, type Volume} from '../render/volume'
import {
    cellOf,
    grow,
    selectBox,
    selectColor,
    selectConnectedColor,
    selectionBounds,
    selectObject,
    selectRect,
    selectVoxel,
    shrink
} from './selection'

/** Two blobs of two colours, touching each other but not touching the other pair. */
const twoBlobs = (): Volume => {
    const volume = createVolume(16, 16, 16, new Uint8Array(256 * 4))
    for (let x = 0; x < 4; x += 1) {
        setVoxel(volume, x, 0, 0, 3)
        setVoxel(volume, x, 1, 0, 5)
    }
    for (let x = 10; x < 13; x += 1) setVoxel(volume, x, 0, 0, 3)
    return volume
}

test('a cell index and its coordinates are the same fact, both ways round', () => {
    const volume = createVolume(7, 5, 3)
    for (let z = 0; z < 3; z += 1) {
        for (let y = 0; y < 5; y += 1) {
            for (let x = 0; x < 7; x += 1) {
                expect(cellOf(volume, voxelIndex(volume, x, y, z))).toEqual([x, y, z])
            }
        }
    }
})

test('click takes a voxel, double-click takes its colour, modifier-click takes the solid', () => {
    const volume = twoBlobs()

    expect(selectVoxel(volume, 0, 0, 0).size).toBe(1)
    // Air is not a selection. There is nothing there to move, recolour or delete.
    expect(selectVoxel(volume, 8, 8, 8).size).toBe(0)

    // The colour run stops where the colour changes, even though the voxels touch.
    expect(selectConnectedColor(volume, 0, 0, 0).size).toBe(4)
    // The whole solid crosses the colour boundary but not the gap at x = 4…9.
    expect(selectObject(volume, 0, 0, 0).size).toBe(8)
    expect(selectObject(volume, 10, 0, 0).size).toBe(3)

    // Every voxel of a colour, wherever it is — both blobs, not just the near one.
    expect(selectColor(volume, 3).size).toBe(7)
    expect(selectColor(volume, 0).size).toBe(0)
})

test('a box selects what is occupied inside it and nothing outside it', () => {
    const volume = twoBlobs()
    const selection = selectBox(volume, [0, 0, 0], [3, 1, 0])
    expect(selection.size).toBe(8)
    expect(selectBox(volume, [0, 0, 0], [15, 15, 15]).size).toBe(11)
    // A box over air is an empty selection, not a box-shaped one.
    expect(selectBox(volume, [5, 5, 5], [9, 9, 9]).size).toBe(0)
    expect(selectionBounds(volume, selection)).toEqual({min: [0, 0, 0], max: [3, 1, 0]})
    expect(selectionBounds(volume, new Set())).toBeUndefined()
})

test('growing reaches only into solid, and shrinking gives back what growing took', () => {
    const volume = createVolume(9, 9, 9)
    for (let z = 2; z <= 6; z += 1) {
        for (let y = 2; y <= 6; y += 1) {
            for (let x = 2; x <= 6; x += 1) setVoxel(volume, x, y, z, 1)
        }
    }

    const core = new Set([voxelIndex(volume, 4, 4, 4)])
    const grown = grow(volume, core)
    expect(grown.size).toBe(7)
    // The cube is 5³; growing twice from the middle cannot leave it.
    expect(grow(volume, grown).size).toBe(25)
    expect(shrink(volume, grown)).toEqual(core)

    // A selection of the whole cube shrinks to its 3³ inside — the grid wall is not an edge, but
    // this cube does not touch one.
    const whole = selectObject(volume, 4, 4, 4)
    expect(whole.size).toBe(125)
    expect(shrink(volume, whole).size).toBe(27)
})

test('a selection touching the wall of the grid does not shrink away from it', () => {
    const volume = createVolume(4, 4, 4)
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) setVoxel(volume, x, y, 0, 1)
    const layer = selectObject(volume, 0, 0, 0)
    expect(layer.size).toBe(16)
    // Only the +z side is a real edge, and it is an edge for every cell, so nothing survives...
    expect(shrink(volume, layer).size).toBe(0)

    // ...but add a layer above and the bottom one is interior, walls and all. The new top layer is
    // the only edge, so exactly half survives.
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) setVoxel(volume, x, y, 1, 1)
    const both = shrink(volume, selectObject(volume, 0, 0, 0))
    expect(both.size).toBe(16)
    for (const index of both) expect(cellOf(volume, index)[2]).toBe(0)
})

test('a rubber band selects the surface the artist can see, not the far side of the model', () => {
    const volume = createVolume(8, 8, 8)
    for (let z = 0; z < 8; z += 1) {
        for (let y = 0; y < 8; y += 1) {
            for (let x = 0; x < 8; x += 1) setVoxel(volume, x, y, z, 1)
        }
    }
    // Straight down at one voxel per pixel: only the top layer is visible.
    const camera: Camera = {yaw: 0, pitch: Math.PI / 2, zoom: 8, panX: 0, panY: 0}
    const basis = basisFor(camera, volume, 8)
    expect(render(volume, basis, 8, 8).id.filter(value => value !== 0)).toHaveLength(64)

    const all = selectRect(volume, basis, {x0: 0, y0: 0, x1: 7, y1: 7}, 8, 8)
    expect(all.size).toBe(64)
    for (const index of all) expect(cellOf(volume, index)[2]).toBe(7)

    // A rectangle over part of the picture takes part of the surface, clipped to the frame.
    const part = selectRect(volume, basis, {x0: 2, y0: 2, x1: 4, y1: 3}, 8, 8)
    expect(part.size).toBe(6)
    expect(selectRect(volume, basis, {x0: -20, y0: -20, x1: 200, y1: 200}, 8, 8).size).toBe(64)
})
