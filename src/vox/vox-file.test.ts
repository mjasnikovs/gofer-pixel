import {expect, test} from 'bun:test'
import {voxelAt} from '../render/volume'
import {countVoxels, readVox} from './vox-file'

const carBytes = new Uint8Array(
    await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer()
)

test('car.vox reads back its own header', () => {
    const volume = readVox(carBytes)
    expect([volume.sx, volume.sy, volume.sz]).toEqual([16, 10, 7])
    expect(countVoxels(volume)).toBe(478)
})

test('a file with no RGBA chunk falls back to the built-in palette, 1-based', () => {
    const {palette} = readVox(carBytes)
    // Colour index 1 is white, and index 0 stays empty rather than becoming a colour.
    expect(Array.from(palette.subarray(0, 4))).toEqual([0, 0, 0, 0])
    expect(Array.from(palette.subarray(4, 8))).toEqual([255, 255, 255, 255])
    expect(Array.from(palette.subarray(8, 12))).toEqual([3, 3, 0, 255])
})

test('a hand-built file lands its voxels where the chunk put them', () => {
    const chunk = (tag: string, content: Uint8Array): Uint8Array => {
        const out = new Uint8Array(12 + content.length)
        for (let i = 0; i < 4; i += 1) out[i] = tag.charCodeAt(i)
        new DataView(out.buffer).setInt32(4, content.length, true)
        out.set(content, 12)
        return out
    }
    const size = new Uint8Array(12)
    const sizeView = new DataView(size.buffer)
    sizeView.setInt32(0, 3, true)
    sizeView.setInt32(4, 4, true)
    sizeView.setInt32(8, 5, true)

    const xyzi = new Uint8Array(4 + 2 * 4)
    new DataView(xyzi.buffer).setInt32(0, 2, true)
    xyzi.set([0, 0, 0, 1, 2, 3, 4, 200], 4)

    const rgba = new Uint8Array(256 * 4)
    rgba.set([10, 20, 30, 255], 0) // chunk entry 0 is the colour of voxel value 1
    rgba.set([40, 50, 60, 255], 199 * 4)

    const sizeChunk = chunk('SIZE', size)
    const xyziChunk = chunk('XYZI', xyzi)
    const rgbaChunk = chunk('RGBA', rgba)
    const header = new Uint8Array(8)
    header.set([0x56, 0x4f, 0x58, 0x20])
    new DataView(header.buffer).setInt32(4, 150, true)
    const main = chunk('MAIN', new Uint8Array(0))
    new DataView(main.buffer).setInt32(
        8,
        sizeChunk.length + xyziChunk.length + rgbaChunk.length,
        true
    )

    const bytes = new Uint8Array([...header, ...main, ...sizeChunk, ...xyziChunk, ...rgbaChunk])
    const volume = readVox(bytes)

    expect([volume.sx, volume.sy, volume.sz]).toEqual([3, 4, 5])
    expect(voxelAt(volume, 0, 0, 0)).toBe(1)
    expect(voxelAt(volume, 2, 3, 4)).toBe(200)
    expect(voxelAt(volume, 1, 1, 1)).toBe(0)
    expect(Array.from(volume.palette.subarray(4, 8))).toEqual([10, 20, 30, 255])
    expect(Array.from(volume.palette.subarray(200 * 4, 200 * 4 + 4))).toEqual([40, 50, 60, 255])
})
