import {expect, test} from 'bun:test'
import {encodePng} from './png'

const inflate = async (bytes: Uint8Array): Promise<Uint8Array> => {
    const stream = new Blob([bytes as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream('deflate'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
}

test('the encoder writes a PNG a decoder would accept, pixels intact', async () => {
    const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 9, 9, 9, 0])
    const png = await encodePng(2, 2, data)

    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const view = new DataView(png.buffer)
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR')
    expect(view.getUint32(16)).toBe(2)
    expect(view.getUint32(20)).toBe(2)
    expect(png[24]).toBe(8)
    expect(png[25]).toBe(6)

    // IDAT starts after the 8-byte signature and the 25-byte IHDR chunk.
    const idatLength = view.getUint32(33)
    expect(String.fromCharCode(...png.subarray(37, 41))).toBe('IDAT')
    const raw = await inflate(png.subarray(41, 41 + idatLength))
    expect(Array.from(raw)).toEqual([
        0, 255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 0, 255, 255, 9, 9, 9, 0
    ])
    expect(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4))).toBe('IEND')
})

test('every chunk carries a CRC the standard table agrees with', async () => {
    const png = await encodePng(1, 1, new Uint8Array([1, 2, 3, 4]))
    // A wrong CRC is the one PNG error a viewer reports as a corrupt file rather than ignoring.
    const view = new DataView(png.buffer)
    let pos = 8
    let chunks = 0
    while (pos + 8 <= png.length) {
        const length = view.getUint32(pos)
        const stored = view.getUint32(pos + 8 + length)
        let c = 0xffffffff
        for (const byte of png.subarray(pos + 4, pos + 8 + length)) {
            let acc = (c ^ byte) & 0xff
            for (let k = 0; k < 8; k += 1) {
                acc = (acc & 1) === 1 ? 0xedb88320 ^ (acc >>> 1) : acc >>> 1
            }
            c = (acc >>> 0) ^ (c >>> 8)
        }
        expect(stored).toBe((c ^ 0xffffffff) >>> 0)
        chunks += 1
        pos += 12 + length
    }
    expect(chunks).toBe(3)
})
