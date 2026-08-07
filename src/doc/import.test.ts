import {expect, test} from 'bun:test'
import {voxelAt} from '../render/volume'
import {voxelsFromImage} from './import'

/** Two pixels wide, three tall: red over green over a hole, then all transparent. */
const sample = (): Uint8Array =>
    Uint8Array.from([
        255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ])

test('every opaque pixel becomes a voxel and every transparent one becomes a hole', () => {
    const {volume, colors, dropped} = voxelsFromImage(sample(), 2, 3, 1)

    expect([volume.sx, volume.sy, volume.sz]).toEqual([2, 1, 3])
    expect(colors).toBe(2)
    expect(dropped).toBe(0)

    // Row 0 of the image is its top, and +z is up, so the red pixel lands at the top of the model.
    expect(voxelAt(volume, 0, 0, 2)).toBeGreaterThan(0)
    expect(voxelAt(volume, 0, 0, 1)).toBeGreaterThan(0)
    expect(voxelAt(volume, 1, 0, 2)).toBe(0)
    expect(voxelAt(volume, 0, 0, 0)).toBe(0)
})

test('the palette comes from the image rather than from somebody else’s 255 entries', () => {
    const {volume} = voxelsFromImage(sample(), 2, 3, 1)
    const top = voxelAt(volume, 0, 0, 2)
    const below = voxelAt(volume, 0, 0, 1)

    expect([...volume.palette.subarray(top * 4, top * 4 + 4)]).toEqual([255, 0, 0, 255])
    expect([...volume.palette.subarray(below * 4, below * 4 + 4)]).toEqual([0, 255, 0, 255])
    // The same colour twice is one entry, not two.
    expect(top).not.toBe(below)
})

test('the extrusion depth is how thick the slab comes out', () => {
    const {volume} = voxelsFromImage(sample(), 2, 3, 4)
    expect(volume.sy).toBe(4)
    for (let y = 0; y < 4; y += 1) expect(voxelAt(volume, 0, y, 2)).toBeGreaterThan(0)

    // Zero and nonsense both mean one voxel thick rather than a model with no depth at all.
    expect(voxelsFromImage(sample(), 2, 3, 0).volume.sy).toBe(1)
    expect(voxelsFromImage(sample(), 2, 3, -3).volume.sy).toBe(1)
})

test('an image with more colours than a palette holds says how many it dropped', () => {
    const width = 300
    const rgba = new Uint8Array(width * 4)
    // Distinct for all 300, so the count is about the palette running out and not about the
    // generator wrapping round and handing the same colour in twice.
    for (let i = 0; i < width; i += 1) rgba.set([i & 255, (i >> 8) & 255, 7, 255], i * 4)
    const {colors, dropped} = voxelsFromImage(rgba, width, 1, 1)

    expect(colors).toBe(255)
    expect(dropped).toBeGreaterThan(0)
    expect(colors + dropped).toBe(width)
})

test('a half-transparent pixel is a hole, not a faint voxel', () => {
    const rgba = Uint8Array.from([255, 255, 255, 100, 255, 255, 255, 200])
    const {volume} = voxelsFromImage(rgba, 2, 1, 1)
    expect(voxelAt(volume, 0, 0, 0)).toBe(0)
    expect(voxelAt(volume, 1, 0, 0)).toBeGreaterThan(0)
})
