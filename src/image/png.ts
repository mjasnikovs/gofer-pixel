/**
 * A PNG encoder with no dependencies, carried over from `legacy/src/image/png.ts`.
 *
 * Only the encoder: the app writes sprite sheets and never reads one back. `deflate` comes from
 * the platform's `CompressionStream`, which is why this is async — the alternative is shipping a
 * zlib implementation to save an `await`.
 */

const CRC_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
        let c = n
        for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        table[n] = c >>> 0
    }
    return table
})()

/**
 * CRC-32/ISO-HDLC. Exported because a zip entry's checksum is the same function over the same
 * polynomial — see `zip.ts`. Two copies of a lookup table is two chances to get one of them wrong.
 */
export const crc32 = (bytes: Uint8Array): number => {
    let c = 0xffffffff
    for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}

const chunk = (tag: string, payload: Uint8Array): Uint8Array => {
    const out = new Uint8Array(payload.length + 12)
    const view = new DataView(out.buffer)
    view.setUint32(0, payload.length)
    for (let i = 0; i < 4; i += 1) out[4 + i] = tag.charCodeAt(i)
    out.set(payload, 8)
    view.setUint32(payload.length + 8, crc32(out.subarray(4, payload.length + 8)))
    return out
}

/**
 * Prefix every row with filter byte 0. A real filter would compress better, but a sprite sheet is
 * flat colour with large transparent runs and already collapses to almost nothing.
 */
const addFilterBytes = (width: number, height: number, data: Uint8Array): Uint8Array => {
    const stride = width * 4
    const raw = new Uint8Array(height * (stride + 1))
    for (let y = 0; y < height; y += 1) {
        raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
    }
    return raw
}

const deflate = async (bytes: Uint8Array): Promise<Uint8Array> => {
    // 'deflate' is the zlib-wrapped variant PNG's IDAT expects; 'deflate-raw' is not.
    const stream = new Blob([bytes as BlobPart])
        .stream()
        .pipeThrough(new CompressionStream('deflate'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
}

export const encodePng = async (
    width: number,
    height: number,
    data: Uint8Array
): Promise<Uint8Array> => {
    const ihdr = new Uint8Array(13)
    const view = new DataView(ihdr.buffer)
    view.setUint32(0, width)
    view.setUint32(4, height)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 6 // colour type: RGBA

    const parts = [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', await deflate(addFilterBytes(width, height, data))),
        chunk('IEND', new Uint8Array(0))
    ]

    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
    let offset = 0
    for (const part of parts) {
        out.set(part, offset)
        offset += part.length
    }
    return out
}
