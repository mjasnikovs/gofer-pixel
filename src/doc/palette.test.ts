import {describe, expect, test} from 'bun:test'
import {
    addGradientRamp,
    applyPaletteOrder,
    closeColors,
    gradientBetween,
    colorDistance,
    colorUsage,
    flatSlicePairs,
    fromHsv,
    gradient,
    gradientByHue,
    lightness,
    mergeDuplicates,
    rampFromGradient,
    replaceColorEverywhere,
    shadeStep,
    sortOrder,
    sortPalette,
    toHsv
} from './palette'
import {
    addRamp,
    celAt,
    createDocument,
    editCel,
    frameToModel,
    setPalette,
    type Document
} from './document'
import {
    decodePalette,
    fromGpl,
    fromHex,
    fromPal,
    fromStrip,
    toGpl,
    toHex,
    toPal,
    toStrip
} from './palette-formats'
import type {Rgba} from '../vox/palette'
import {PALETTE} from '../vox/palette'

const rgb = (r: number, g: number, b: number): Rgba => ({r, g, b, a: 255})

describe('colour maths', () => {
    test('lightness runs black to white on the CIE scale', () => {
        expect(lightness(rgb(0, 0, 0))).toBeCloseTo(0, 5)
        expect(lightness(rgb(255, 255, 255))).toBeCloseTo(100, 3)
        expect(lightness(rgb(128, 128, 128))).toBeGreaterThan(50)
        expect(lightness(rgb(128, 128, 128))).toBeLessThan(56)
    })

    test('a mid grey is perceptually lighter than a saturated blue', () => {
        expect(lightness(rgb(128, 128, 128))).toBeGreaterThan(lightness(rgb(0, 0, 255)))
    })

    test('hsv round-trips', () => {
        for (const color of [rgb(255, 0, 0), rgb(0, 128, 64), rgb(30, 30, 30), rgb(200, 180, 20)]) {
            const {h, s, v} = toHsv(color)
            expect(fromHsv(h, s, v)).toEqual(color)
        }
    })

    test('distance is zero for a colour against itself and grows with difference', () => {
        expect(colorDistance(rgb(10, 20, 30), rgb(10, 20, 30))).toBe(0)
        expect(colorDistance(rgb(0, 0, 0), rgb(255, 255, 255))).toBeGreaterThan(
            colorDistance(rgb(0, 0, 0), rgb(40, 40, 40))
        )
    })
})

describe('gradients', () => {
    test('a gradient hits both ends and has the length asked for', () => {
        const ramp = gradient(rgb(0, 0, 0), rgb(255, 255, 255), 5)
        expect(ramp.length).toBe(5)
        expect(ramp[0]).toEqual(rgb(0, 0, 0))
        expect(ramp[4]).toEqual(rgb(255, 255, 255))
        expect(ramp[2]).toEqual(rgb(128, 128, 128))
    })

    test('a hue gradient takes the short way round the circle', () => {
        // red (0°) to magenta (300°) should go backwards through 330, not forwards through 150
        const ramp = gradientByHue(rgb(255, 0, 0), rgb(255, 0, 255), 3)
        const middle = ramp[1]
        expect(middle).toBeDefined()
        expect(toHsv(middle ?? rgb(0, 0, 0)).h).toBeGreaterThan(300)
    })
})

describe('palette reordering', () => {
    const build = (): Document => {
        const doc = createDocument({
            size: {sx: 8, sy: 8, sz: 8},
            palette: [rgb(255, 255, 255), rgb(0, 0, 0), rgb(128, 128, 128)]
        })
        return editCel(doc, 0, 0, v => {
            v.set(0, 0, 0, 1) // white
            v.set(1, 0, 0, 2) // black
            v.set(2, 0, 0, 3) // grey
        })
    }

    test('sorting by luminance puts the darkest first and leaves index 0 alone', () => {
        const order = sortOrder([rgb(255, 255, 255), rgb(0, 0, 0), rgb(128, 128, 128)], 'luminance')
        expect(order[0]).toBe(0)
    })

    test('reordering rewrites the voxels so the render is unchanged', () => {
        const before = build()
        const after = sortPalette(before, 'luminance')

        const pixelsBefore = frameToModel(before, 0)
        const pixelsAfter = frameToModel(after, 0)

        const colorAt = (
            doc: typeof before,
            model: typeof pixelsBefore,
            x: number
        ): Rgba | undefined => {
            const index = model.voxels.get((x * 256 + 0) * 256 + 0) ?? 0
            return doc.palette[index - 1]
        }

        for (const x of [0, 1, 2]) {
            expect(colorAt(after, pixelsAfter, x)).toEqual(colorAt(before, pixelsBefore, x))
        }
    })

    test('reordering moves ramp indices with the colours', () => {
        const doc = addRamp(build(), {name: 'value', indices: [2, 3, 1]})
        const sorted = sortPalette(doc, 'luminance')
        const ramp = sorted.ramps[0]

        expect(ramp?.indices.length).toBe(3)
        const colors = ramp?.indices.map(i => sorted.palette[i - 1]) ?? []
        expect(colors).toEqual([rgb(0, 0, 0), rgb(128, 128, 128), rgb(255, 255, 255)])
    })

    test('an identity order changes nothing', () => {
        const before = build()
        const after = applyPaletteOrder(before, [0, 1, 2])
        expect(after.palette).toEqual(before.palette)
        expect(celAt(after, 0, 0)?.get(1, 0, 0)).toBe(2)
    })
})

describe('document-wide palette operations', () => {
    test('colorUsage counts every voxel of every cel', () => {
        let doc = createDocument({size: {sx: 8, sy: 8, sz: 8}, palette: PALETTE})
        doc = editCel(doc, 0, 0, v => v.fillBox({x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 0}, 5))
        doc = editCel(doc, 0, 0, v => v.set(7, 7, 7, 9))

        const usage = colorUsage(doc)
        expect(usage.get(5)).toBe(4)
        expect(usage.get(9)).toBe(1)
        expect(usage.get(2)).toBeUndefined()
    })

    test('replaceColorEverywhere hits every cel', () => {
        let doc = createDocument({size: {sx: 8, sy: 8, sz: 8}, palette: PALETTE})
        doc = editCel(doc, 0, 0, v => v.set(0, 0, 0, 5))
        doc = replaceColorEverywhere(doc, 5, 7)

        expect(celAt(doc, 0, 0)?.get(0, 0, 0)).toBe(7)
    })

    test('mergeDuplicates points voxels at the first copy of a repeated colour', () => {
        let doc = createDocument({
            size: {sx: 8, sy: 8, sz: 8},
            palette: [rgb(200, 0, 0), rgb(0, 200, 0), rgb(200, 0, 0)]
        })
        doc = editCel(doc, 0, 0, v => {
            v.set(0, 0, 0, 1)
            v.set(1, 0, 0, 3)
        })

        const merged = mergeDuplicates(doc)
        expect(celAt(merged, 0, 0)?.get(1, 0, 0)).toBe(1)
        expect(merged.palette.length).toBe(3)
    })
})

describe('contrast checks', () => {
    test('closeColors reports the pair that is nearly a duplicate, and not the rest', () => {
        const found = closeColors([rgb(100, 100, 100), rgb(101, 101, 101), rgb(0, 0, 255)], 4)
        expect(found.map(({a, b}) => [a, b])).toEqual([[1, 2]])
    })

    test('flatSlicePairs finds stacked slices that will read as one blob', () => {
        let doc = createDocument({
            size: {sx: 8, sy: 8, sz: 4},
            // two nearly identical mid greys, then a clearly darker one
            palette: [rgb(120, 120, 120), rgb(124, 124, 124), rgb(20, 20, 20)]
        })
        doc = editCel(doc, 0, 0, v => {
            v.fillBox({x0: 0, y0: 0, z0: 0, x1: 7, y1: 7, z1: 0}, 1)
            v.fillBox({x0: 0, y0: 0, z0: 1, x1: 7, y1: 7, z1: 1}, 2)
            v.fillBox({x0: 0, y0: 0, z0: 2, x1: 7, y1: 7, z1: 2}, 3)
        })

        const flat = flatSlicePairs(doc, 0, 3)
        expect(flat.map(({lower, upper}) => [lower, upper])).toEqual([[0, 1]])
    })

    test('an empty slice is skipped, not reported as flat', () => {
        let doc = createDocument({size: {sx: 8, sy: 8, sz: 4}, palette: [rgb(120, 120, 120)]})
        doc = editCel(doc, 0, 0, v => {
            v.set(0, 0, 0, 1)
            v.set(0, 0, 3, 1)
        })
        // the two occupied slices are the same colour, so they are a real flat pair
        expect(flatSlicePairs(doc, 0, 3).map(({lower, upper}) => [lower, upper])).toEqual([[0, 3]])
    })
})

describe('ramps and shading', () => {
    test('rampFromGradient appends colours and numbers them 1-based', () => {
        const {palette, ramp} = rampFromGradient(
            [rgb(0, 0, 0)],
            'skin',
            rgb(80, 40, 30),
            rgb(255, 220, 200),
            4
        )

        expect(palette.length).toBe(5)
        expect(ramp.indices).toEqual([2, 3, 4, 5])
        expect(palette[(ramp.indices[0] ?? 0) - 1]).toEqual(rgb(80, 40, 30))
    })

    test('shading steps along the ramp and stops at its ends', () => {
        const ramps = [{name: 'grey', indices: [1, 2, 3]}]
        expect(shadeStep(ramps, 2, 1)).toBe(3)
        expect(shadeStep(ramps, 2, -1)).toBe(1)
        expect(shadeStep(ramps, 3, 1)).toBe(3)
        expect(shadeStep(ramps, 1, -1)).toBe(1)
    })

    test('a colour on no ramp is left alone', () => {
        expect(shadeStep([{name: 'grey', indices: [1, 2]}], 9, 1)).toBe(9)
    })
})

describe('palette file formats', () => {
    const sample = [rgb(255, 0, 0), rgb(0, 255, 0), rgb(18, 52, 86)]

    test('gpl round-trips', () => {
        const text = toGpl(sample, 'test')
        expect(text.startsWith('GIMP Palette')).toBe(true)
        expect(fromGpl(text)).toEqual(sample)
    })

    test('hex round-trips and is one colour per line', () => {
        const text = toHex(sample)
        expect(text.split('\n').filter(Boolean)).toEqual(['ff0000', '00ff00', '123456'])
        expect(fromHex(text)).toEqual(sample)
    })

    test('pal round-trips and carries the JASC header', () => {
        const text = toPal(sample)
        expect(text.split('\r\n').slice(0, 3)).toEqual(['JASC-PAL', '0100', '3'])
        expect(fromPal(text)).toEqual(sample)
    })

    test('a file that is not a JASC pal is refused', () => {
        expect(() => fromPal('nonsense\n')).toThrow('not a JASC')
    })

    test('the format is sniffed from the content, not the extension', () => {
        expect(decodePalette(toGpl(sample))).toEqual(sample)
        expect(decodePalette(toPal(sample))).toEqual(sample)
        expect(decodePalette(toHex(sample))).toEqual(sample)
    })

    test('transparent entries are dropped on export', () => {
        expect(fromHex(toHex([...sample, {r: 0, g: 0, b: 0, a: 0}]))).toEqual(sample)
    })

    test('a strip round-trips at any scale', () => {
        expect(fromStrip(toStrip(sample))).toEqual(sample)
        expect(fromStrip(toStrip(sample, 8))).toEqual(sample)
        expect(toStrip(sample, 8).width).toBe(24)
    })

    test('an imported palette can be dropped straight onto a document', () => {
        const doc = setPalette(
            createDocument({size: {sx: 8, sy: 8, sz: 8}}),
            decodePalette(toGpl(sample))
        )
        expect(doc.palette).toEqual(sample)
    })
})

describe('gradientBetween', () => {
    const doc = () =>
        setPalette(createDocument({size: {sx: 4, sy: 4, sz: 4}}), [
            rgb(0, 0, 0),
            rgb(9, 9, 9),
            rgb(9, 9, 9),
            rgb(9, 9, 9),
            rgb(100, 100, 100)
        ])

    test('fills the entries in between and leaves the ends alone', () => {
        const out = gradientBetween(doc(), 1, 5)
        expect(out.palette).toEqual([
            rgb(0, 0, 0),
            rgb(25, 25, 25),
            rgb(50, 50, 50),
            rgb(75, 75, 75),
            rgb(100, 100, 100)
        ])
    })

    test('the order the two are picked in does not matter', () => {
        expect(gradientBetween(doc(), 5, 1).palette).toEqual(gradientBetween(doc(), 1, 5).palette)
    })

    test('adjacent or identical entries are a no-op, not an error', () => {
        const d = doc()
        expect(gradientBetween(d, 1, 2)).toBe(d)
        expect(gradientBetween(d, 3, 3)).toBe(d)
    })

    test('voxels keep pointing at the same indices', () => {
        const drawn = editCel(doc(), 0, 0, volume => {
            volume.set(1, 1, 1, 3)
        })
        expect(celAt(gradientBetween(drawn, 1, 5), 0, 0)?.get(1, 1, 1)).toBe(3)
    })
})

describe('addGradientRamp', () => {
    const doc = () =>
        setPalette(createDocument({size: {sx: 4, sy: 4, sz: 4}}), [
            rgb(0, 0, 0),
            rgb(255, 255, 255)
        ])

    test('appends the ramp colours and names them', () => {
        const out = addGradientRamp(doc(), 'skin', 1, 2, 3)
        expect(out.palette.length).toBe(5)
        expect(out.ramps).toEqual([{name: 'skin', indices: [3, 4, 5]}])
        expect(out.palette[2]).toEqual(rgb(0, 0, 0))
        expect(out.palette[4]).toEqual(rgb(255, 255, 255))
    })

    test('the new ramp drives the shading tool', () => {
        const out = addGradientRamp(doc(), 'skin', 1, 2, 3)
        expect(shadeStep(out.ramps, 3, 1)).toBe(4)
        expect(shadeStep(out.ramps, 5, 1)).toBe(5)
    })

    test('an index that does not exist is refused', () => {
        const d = doc()
        expect(addGradientRamp(d, 'nope', 1, 99, 3)).toBe(d)
    })
})

describe('calibrated contrast defaults', () => {
    /**
     * The defaults come from `experiments/t23_contrast.ts`, against a stated criterion: a seam is
     * visible at a 2-level rendered step and comfortable at 5, which a palette ΔL* of 1 and 2 reach
     * respectively. These pin the calibration so a future edit has to argue with the measurement.
     */
    test('closeColors flags a pair two 8-bit levels apart and leaves five alone', () => {
        // measured: 2 levels of grey is ~1 ΔL* and a colour distance of ~0.8; 5 levels is ~2 ΔL*
        expect(closeColors([rgb(119, 119, 119), rgb(121, 121, 121)]).length).toBe(1)
        expect(closeColors([rgb(119, 119, 119), rgb(124, 124, 124)]).length).toBe(0)
        // the guessed default of 4 called that second pair a duplicate, which it plainly is not
        expect(closeColors([rgb(119, 119, 119), rgb(124, 124, 124)], 4).length).toBe(1)
    })

    test('flatSlicePairs uses the comfortable threshold, not the guessed one', () => {
        const stack = (colors: Rgba[]): Document => {
            let doc = createDocument({size: {sx: 2, sy: 2, sz: 3}, palette: colors})
            doc = editCel(doc, 0, 0, volume => {
                for (let z = 0; z < 3; z += 1) {
                    volume.fillBox({x0: 0, y0: 0, z0: z, x1: 1, y1: 1, z1: z}, z + 1)
                }
            })
            return doc
        }

        // 119 → 126 is ~2.6 L*, above the calibrated floor of 2, so it is not a blob
        const fine = stack([rgb(119, 119, 119), rgb(126, 126, 126), rgb(200, 200, 200)])
        expect(flatSlicePairs(fine, 0).length).toBe(0)
        // the old guess of 3 would have reported it
        expect(flatSlicePairs(fine, 0, 3).length).toBe(1)

        // 119 → 121 is ~1 L*: visible at all, but not comfortably, and still reported
        const flat = stack([rgb(119, 119, 119), rgb(121, 121, 121), rgb(200, 200, 200)])
        expect(flatSlicePairs(flat, 0).map(pair => [pair.lower, pair.upper])).toEqual([[0, 1]])
    })
})
