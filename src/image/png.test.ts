import {describe, expect, test} from 'bun:test'
import {blit, createImage} from './rgba'
import {decodePng, encodePng} from './png'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Pull the IDAT payload back out, inflate it, and drop the per-row filter byte. */
const decodePixels = async (png: Uint8Array): Promise<Uint8Array> => {
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
    const width = view.getUint32(16)
    const height = view.getUint32(20)

    let pos = 8
    let idat: Uint8Array | null = null
    while (pos < png.length) {
        const length = view.getUint32(pos)
        const tag = String.fromCharCode(...png.subarray(pos + 4, pos + 8))
        if (tag === 'IDAT') {
            idat = png.subarray(pos + 8, pos + 8 + length)
            break
        }
        pos += length + 12
    }
    if (!idat) {
        throw new Error('no IDAT chunk')
    }

    const stream = new Blob([idat as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream('deflate'))
    const raw = new Uint8Array(await new Response(stream).arrayBuffer())

    const stride = width * 4
    const pixels = new Uint8Array(height * stride)
    for (let y = 0; y < height; y += 1) {
        expect(raw[y * (stride + 1)]).toBe(0) // filter type 0
        pixels.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride)
    }
    return pixels
}

describe('encodePng', () => {
    test('writes a header a decoder can find', async () => {
        const png = await encodePng(createImage(3, 5))
        const view = new DataView(png.buffer)

        expect([...png.subarray(0, 8)]).toEqual(PNG_MAGIC)
        expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR')
        expect(view.getUint32(16)).toBe(3)
        expect(view.getUint32(20)).toBe(5)
        expect(png[24]).toBe(8) // 8 bits per channel
        expect(png[25]).toBe(6) // RGBA
    })

    test('round-trips pixels unchanged', async () => {
        const image = createImage(7, 4)
        const patch = createImage(2, 2)
        patch.data.fill(200)
        blit(image, patch, 3, 1)

        expect(await decodePixels(await encodePng(image))).toEqual(image.data)
    })

    test('ends with IEND', async () => {
        const png = await encodePng(createImage(1, 1))
        expect(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4))).toBe('IEND')
    })
})

const fixture = async (name: string): Promise<Uint8Array> =>
    new Uint8Array(await Bun.file(`${import.meta.dir}/fixtures/${name}`).arrayBuffer())

describe('decodePng', () => {
    test('round-trips our own encoder', async () => {
        const image = createImage(7, 4)
        const patch = createImage(2, 2)
        patch.data.fill(200)
        blit(image, patch, 3, 1)

        const back = await decodePng(await encodePng(image))
        expect(back.width).toBe(7)
        expect(back.height).toBe(4)
        expect(back.data).toEqual(image.data)
    })

    /**
     * The fixtures come from Pillow, which picks a row filter per row — so this is the test that
     * says the unfilter step is right, which our own encoder (filter 0 everywhere) cannot say.
     */
    test('reads an RGB file written by another tool, filters and all', async () => {
        const image = await decodePng(await fixture('gradient-rgb.png'))
        expect([image.width, image.height]).toEqual([16, 8])
        for (let y = 0; y < 8; y += 1) {
            for (let x = 0; x < 16; x += 1) {
                const at = (y * 16 + x) * 4
                expect([...image.data.subarray(at, at + 4)]).toEqual([
                    (x * 16) % 256,
                    (y * 32) % 256,
                    (x * y) % 256,
                    255
                ])
            }
        }
    })

    test('reads RGBA', async () => {
        const image = await decodePng(await fixture('gradient-rgba.png'))
        expect([...image.data.subarray(0, 8)]).toEqual([0, 0, 0, 255, 16, 0, 0, 255])
    })

    test('reads an indexed palette strip', async () => {
        const image = await decodePng(await fixture('strip-indexed.png'))
        expect([image.width, image.height]).toEqual([8, 1])
        const pixels = Array.from({length: 8}, (_unused, i) => [
            ...image.data.subarray(i * 4, i * 4 + 3)
        ])
        expect(pixels).toEqual([
            [0, 0, 0],
            [255, 0, 0],
            [0, 255, 0],
            [0, 0, 255],
            [255, 255, 0],
            [0, 255, 255],
            [255, 0, 255],
            [255, 255, 255]
        ])
    })

    test('refuses a file it cannot read rather than half-reading it', async () => {
        let message = ''
        try {
            await decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
        } catch (error) {
            message = String(error)
        }
        expect(message).toContain('not a PNG')
    })
})
