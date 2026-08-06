import {describe, expect, test} from 'bun:test'
import {createImage} from '../image/rgba'
import {renderAngle} from '../vox/render'
import {DEFAULT_PALETTE, packKey, type VoxModel} from '../vox/model'
import {applyPasses, dither, lambert, normalOcclusion, outline, paletteCycle} from './passes'

const RED = {r: 255, g: 0, b: 0, a: 255}
const GREEN = {r: 0, g: 255, b: 0, a: 255}
const BLUE = {r: 0, g: 0, b: 255, a: 255}

const dot = (): {image: ReturnType<typeof createImage>; at: (x: number, y: number) => number[]} => {
    const image = createImage(5, 5)
    image.data.set([200, 200, 200, 255], (2 * 5 + 2) * 4)
    return {
        image,
        at: (x, y) => [...image.data.subarray((y * 5 + x) * 4, (y * 5 + x) * 4 + 4)]
    }
}

const pixel = (image: {width: number; data: Uint8Array}, x: number, y: number): number[] => [
    ...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)
]

describe('outline', () => {
    test('draws outside the silhouette by default and leaves the art alone', () => {
        const {image} = dot()
        const out = outline(RED)(image)
        expect(pixel(out, 2, 2)).toEqual([200, 200, 200, 255])
        expect(pixel(out, 1, 2)).toEqual([255, 0, 0, 255])
        expect(pixel(out, 0, 2)).toEqual([0, 0, 0, 0])
        expect(pixel(out, 1, 1)).toEqual([0, 0, 0, 0]) // no diagonals unless asked
    })

    test('diagonal adds the corners', () => {
        const out = outline(RED, {diagonal: true})(dot().image)
        expect(pixel(out, 1, 1)).toEqual([255, 0, 0, 255])
    })

    test('inside overwrites the edge of the art instead of growing it', () => {
        const image = createImage(5, 5)
        for (let y = 1; y <= 3; y += 1) {
            for (let x = 1; x <= 3; x += 1) {
                image.data.set([200, 200, 200, 255], (y * 5 + x) * 4)
            }
        }
        const out = outline(RED, {inside: true})(image)
        expect(pixel(out, 1, 1)).toEqual([255, 0, 0, 255])
        expect(pixel(out, 2, 2)).toEqual([200, 200, 200, 255])
        expect(pixel(out, 0, 0)).toEqual([0, 0, 0, 0])
    })

    test('the input is never modified', () => {
        const {image} = dot()
        const before = new Uint8Array(image.data)
        outline(RED)(image)
        expect(image.data).toEqual(before)
    })
})

describe('dither', () => {
    test('varies brightness on a 4×4 cell without touching transparency', () => {
        const image = createImage(4, 4)
        image.data.fill(128)
        for (let i = 3; i < image.data.length; i += 4) {
            image.data[i] = 255
        }
        const out = dither(1)(image)
        const values = new Set<number>()
        for (let y = 0; y < 4; y += 1) {
            for (let x = 0; x < 4; x += 1) {
                values.add(pixel(out, x, y)[0] ?? 0)
                expect(pixel(out, x, y)[3]).toBe(255)
            }
        }
        expect(values.size).toBeGreaterThan(8)
    })

    test('strength 0 changes nothing', () => {
        const image = createImage(4, 4)
        image.data.fill(120)
        expect(dither(0)(image).data).toEqual(image.data)
    })

    test('transparent pixels stay transparent', () => {
        const out = dither(1)(createImage(4, 4))
        expect([...out.data]).toEqual([...createImage(4, 4).data])
    })
})

describe('paletteCycle', () => {
    test('rotates one colour into the next', () => {
        const image = createImage(3, 1)
        image.data.set([255, 0, 0, 255], 0)
        image.data.set([0, 255, 0, 255], 4)
        image.data.set([0, 0, 255, 255], 8)

        const out = paletteCycle([RED, GREEN, BLUE], 1)(image)
        expect(pixel(out, 0, 0)).toEqual([0, 255, 0, 255])
        expect(pixel(out, 1, 0)).toEqual([0, 0, 255, 255])
        expect(pixel(out, 2, 0)).toEqual([255, 0, 0, 255])
    })

    test('a colour outside the ramp is left alone, and negative steps go backwards', () => {
        const image = createImage(2, 1)
        image.data.set([255, 0, 0, 255], 0)
        image.data.set([9, 9, 9, 255], 4)
        const out = paletteCycle([RED, GREEN, BLUE], -1)(image)
        expect(pixel(out, 0, 0)).toEqual([0, 0, 255, 255])
        expect(pixel(out, 1, 0)).toEqual([9, 9, 9, 255])
    })
})

const stepModel = (): VoxModel => {
    const voxels = new Map<number, number>()
    for (let x = 0; x < 6; x += 1) {
        for (let y = 0; y < 6; y += 1) {
            const height = x < 3 ? 1 : 3
            for (let z = 0; z < height; z += 1) {
                voxels.set(packKey(x, y, z), 4)
            }
        }
    }
    return {sx: 6, sy: 6, sz: 3, voxels, palette: DEFAULT_PALETTE}
}

describe('normalOcclusion', () => {
    test('darkens where neighbouring normals turn away, and leaves flats alone', () => {
        const sheet = renderAngle(stepModel(), 0, {scale: 1})
        const out = normalOcclusion(1)(sheet.albedo, sheet)

        let darkened = 0
        let same = 0
        for (let i = 0; i < sheet.albedo.data.length; i += 4) {
            if ((sheet.albedo.data[i + 3] ?? 0) === 0) {
                continue
            }
            if ((out.data[i] ?? 0) < (sheet.albedo.data[i] ?? 0)) {
                darkened += 1
            } else {
                same += 1
            }
        }
        expect(darkened).toBeGreaterThan(0)
        expect(same).toBeGreaterThan(0)
    })

    test('without a normal sheet it is a no-op rather than an error', () => {
        const {image} = dot()
        expect(normalOcclusion()(image).data).toEqual(image.data)
    })
})

describe('applyPasses', () => {
    test('runs in order and never returns the input buffer', () => {
        const {image} = dot()
        const out = applyPasses(image, [outline(RED), dither(0.5)])
        expect(out.data).not.toBe(image.data)
        expect(pixel(out, 1, 2)[3]).toBe(255)
    })

    test('an empty pipeline still copies', () => {
        const {image} = dot()
        const out = applyPasses(image, [])
        expect(out.data).toEqual(image.data)
        expect(out.data).not.toBe(image.data)
    })

    test('lambert uses the normal sheet and dims what faces away', () => {
        const sheet = renderAngle(stepModel(), 30, {scale: 2})
        const lit = applyPasses(sheet.albedo, [lambert()], sheet)
        let different = 0
        for (let i = 0; i < lit.data.length; i += 4) {
            if ((lit.data[i] ?? 0) !== (sheet.albedo.data[i] ?? 0)) {
                different += 1
            }
        }
        expect(different).toBeGreaterThan(0)
    })
})
