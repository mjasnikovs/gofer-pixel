import {createImage, type RgbaImage} from './rgba'

const CRC_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
        let c = n
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        }
        table[n] = c >>> 0
    }
    return table
})()

const crc32 = (bytes: Uint8Array): number => {
    let c = 0xffffffff
    for (const byte of bytes) {
        c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
    }
    return (c ^ 0xffffffff) >>> 0
}

const chunk = (tag: string, payload: Uint8Array): Uint8Array => {
    const out = new Uint8Array(payload.length + 12)
    const view = new DataView(out.buffer)
    view.setUint32(0, payload.length)
    for (let i = 0; i < 4; i += 1) {
        out[4 + i] = tag.charCodeAt(i)
    }
    out.set(payload, 8)
    view.setUint32(payload.length + 8, crc32(out.subarray(4, payload.length + 8)))
    return out
}

/**
 * Prefix every row with filter byte 0, which is what the Python original does. Filtering would
 * compress better, but the sprites are flat colour and already compress to almost nothing.
 */
const addFilterBytes = ({width, height, data}: RgbaImage): Uint8Array => {
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

const inflate = async (bytes: Uint8Array): Promise<Uint8Array> => {
    const stream = new Blob([bytes as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream('deflate'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Encode an RGBA image as a PNG. Async because deflate comes from the platform, not a library. */
export const encodePng = async (image: RgbaImage): Promise<Uint8Array> => {
    const ihdr = new Uint8Array(13)
    const view = new DataView(ihdr.buffer)
    view.setUint32(0, image.width)
    view.setUint32(4, image.height)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 6 // colour type: RGBA

    const parts = [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', await deflate(addFilterBytes(image))),
        chunk('IEND', new Uint8Array(0))
    ]

    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let offset = 0
    for (const part of parts) {
        out.set(part, offset)
        offset += part.length
    }
    return out
}

/** Undo one PNG row filter in place. `raw` is the already-unfiltered previous row. */
const unfilter = (
    type: number,
    row: Uint8Array,
    previous: Uint8Array | null,
    bytesPerPixel: number
): void => {
    for (let i = 0; i < row.length; i += 1) {
        const a = i >= bytesPerPixel ? (row[i - bytesPerPixel] ?? 0) : 0
        const b = previous?.[i] ?? 0
        const c = i >= bytesPerPixel ? (previous?.[i - bytesPerPixel] ?? 0) : 0
        const x = row[i] ?? 0
        if (type === 1) {
            row[i] = (x + a) & 0xff
        } else if (type === 2) {
            row[i] = (x + b) & 0xff
        } else if (type === 3) {
            row[i] = (x + ((a + b) >> 1)) & 0xff
        } else if (type === 4) {
            const p = a + b - c
            const pa = Math.abs(p - a)
            const pb = Math.abs(p - b)
            const pc = Math.abs(p - c)
            row[i] =
                (x
                    + (pa <= pb && pa <= pc ? a
                    : pb <= pc ? b
                    : c))
                & 0xff
        }
    }
}

const CHANNELS: Record<number, number> = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}

/** One sample out of an unfiltered row, at any of PNG's sub-byte depths. */
const sampleAt = (row: Uint8Array, index: number, depth: number): number => {
    if (depth === 8) {
        return row[index] ?? 0
    }
    const perByte = 8 / depth
    const byte = row[Math.floor(index / perByte)] ?? 0
    const shift = 8 - depth * ((index % perByte) + 1)
    return (byte >> shift) & ((1 << depth) - 1)
}

/**
 * Decode a PNG to RGBA.
 *
 * Non-interlaced; colour types greyscale / RGB / indexed / greyscale+alpha / RGBA at depth 8, plus
 * indexed and greyscale at 1, 2 and 4 bits — which is what a palette strip downloaded from Lospec
 * actually looks like, since encoders pack an 8-colour palette into 4-bit samples. A 16-bit or
 * interlaced file throws rather than being half-read: a palette silently read from the wrong bytes
 * is worse than a refusal.
 */
export const decodePng = async (bytes: Uint8Array): Promise<RgbaImage> => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    if (!signature.every((byte, i) => bytes[i] === byte)) {
        throw new Error('not a PNG')
    }

    let width = 0
    let height = 0
    let depth = 0
    let colorType = 0
    let palette: Uint8Array | null = null
    let alpha: Uint8Array | null = null
    const idat: Uint8Array[] = []

    let pos = 8
    while (pos + 8 <= bytes.length) {
        const length = view.getUint32(pos)
        const tag = String.fromCharCode(
            view.getUint8(pos + 4),
            view.getUint8(pos + 5),
            view.getUint8(pos + 6),
            view.getUint8(pos + 7)
        )
        const body = pos + 8
        if (tag === 'IHDR') {
            width = view.getUint32(body)
            height = view.getUint32(body + 4)
            depth = view.getUint8(body + 8)
            colorType = view.getUint8(body + 9)
            if (view.getUint8(body + 12) !== 0) {
                throw new Error('interlaced PNG is not supported')
            }
        } else if (tag === 'PLTE') {
            palette = bytes.subarray(body, body + length)
        } else if (tag === 'tRNS') {
            alpha = bytes.subarray(body, body + length)
        } else if (tag === 'IDAT') {
            idat.push(bytes.subarray(body, body + length))
        } else if (tag === 'IEND') {
            break
        }
        pos = body + length + 4
    }

    const channels = CHANNELS[colorType]
    if (channels === undefined) {
        throw new Error(`unsupported PNG colour type ${String(colorType)}`)
    }
    const subByte = depth === 1 || depth === 2 || depth === 4
    if (depth !== 8 && !(subByte && channels === 1)) {
        throw new Error(`unsupported PNG bit depth ${String(depth)}`)
    }

    const joined = new Uint8Array(idat.reduce((n, part) => n + part.length, 0))
    idat.reduce((offset, part) => {
        joined.set(part, offset)
        return offset + part.length
    }, 0)
    const raw = await inflate(joined)

    const bitsPerPixel = channels * depth
    const stride = Math.ceil((width * bitsPerPixel) / 8)
    // filtering works on bytes, and a sub-byte pixel counts as one byte for the "left" neighbour
    const filterBpp = Math.max(1, Math.ceil(bitsPerPixel / 8))
    const maxSample = (1 << depth) - 1
    const out = createImage(width, height)
    let previous: Uint8Array | null = null

    for (let y = 0; y < height; y += 1) {
        const at = y * (stride + 1)
        const row = raw.slice(at + 1, at + 1 + stride)
        unfilter(raw[at] ?? 0, row, previous, filterBpp)
        previous = row
        for (let x = 0; x < width; x += 1) {
            const to = (y * width + x) * 4
            const sample = (channel: number): number => sampleAt(row, x * channels + channel, depth)
            if (colorType === 3) {
                const index = sample(0)
                out.data[to] = palette?.[index * 3] ?? 0
                out.data[to + 1] = palette?.[index * 3 + 1] ?? 0
                out.data[to + 2] = palette?.[index * 3 + 2] ?? 0
                out.data[to + 3] = alpha?.[index] ?? 255
            } else if (colorType === 0 || colorType === 4) {
                const grey = Math.round((sample(0) * 255) / maxSample)
                out.data[to] = grey
                out.data[to + 1] = grey
                out.data[to + 2] = grey
                out.data[to + 3] = colorType === 4 ? sample(1) : 255
            } else {
                out.data[to] = sample(0)
                out.data[to + 1] = sample(1)
                out.data[to + 2] = sample(2)
                out.data[to + 3] = colorType === 6 ? sample(3) : 255
            }
        }
    }
    return out
}
