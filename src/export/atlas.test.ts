import {describe, expect, test} from 'bun:test'
import {addFrame, addTag, createDocument, editCel, type Document} from '../doc/document'
import {PALETTE} from '../vox/palette'
import {createImage} from '../image/rgba'
import {opaqueBounds, packAtlas, sidecarJson} from './atlas'

const build = (): Document => {
    let doc = createDocument({size: {sx: 8, sy: 8, sz: 4}, palette: PALETTE, name: 'test'})
    doc = editCel(doc, 0, 0, volume => {
        volume.fillBox({x0: 2, y0: 2, z0: 0, x1: 5, y1: 5, z1: 2}, 4)
    })
    doc = addFrame(doc)
    doc = editCel(doc, 0, 1, volume => {
        volume.fillBox({x0: 1, y0: 1, z0: 0, x1: 3, y1: 3, z1: 1}, 6)
    })
    return addTag(doc, {name: 'idle', from: 0, to: 1})
}

const alphaAt = (image: {width: number; data: Uint8Array}, x: number, y: number): number =>
    image.data[(y * image.width + x) * 4 + 3] ?? 0

describe('opaqueBounds', () => {
    test('finds the tight box', () => {
        const image = createImage(6, 5)
        image.data.set([1, 2, 3, 255], (2 * 6 + 1) * 4)
        image.data.set([1, 2, 3, 255], (3 * 6 + 4) * 4)
        expect(opaqueBounds(image)).toEqual({x: 1, y: 2, width: 4, height: 2})
    })

    test('an empty image gives a 1×1 box rather than a negative one', () => {
        expect(opaqueBounds(createImage(4, 4))).toEqual({x: 0, y: 0, width: 1, height: 1})
    })
})

describe('packAtlas', () => {
    test('angles run across and frames run down', () => {
        const {albedo, normal, sidecar} = packAtlas(build(), {angles: 4, scale: 2})

        expect(sidecar.rects.length).toBe(8)
        expect(sidecar.angles).toBe(4)
        expect(sidecar.frames).toBe(2)
        expect(albedo.width).toBe(sidecar.sheet.width)
        expect(normal.width).toBe(albedo.width)
        expect(normal.height).toBe(albedo.height)

        const [a, b] = sidecar.rects
        expect(a?.frame).toBe(0)
        expect(b?.angle).toBe(1)
        expect(b?.x).toBeGreaterThan(a?.x ?? 0)
        expect(b?.y).toBe(a?.y ?? -1)

        const secondRow = sidecar.rects.find(rect => rect.frame === 1)
        expect(secondRow?.y).toBeGreaterThan(a?.y ?? 0)
    })

    test('the normal sheet lines up with the albedo pixel for pixel', () => {
        const {albedo, normal} = packAtlas(build(), {angles: 2, scale: 1})
        let mismatch = 0
        for (let i = 3; i < albedo.data.length; i += 4) {
            if ((albedo.data[i] ?? 0) !== (normal.data[i] ?? 0)) {
                mismatch += 1
            }
        }
        expect(mismatch).toBe(0)
    })

    test('every angle actually drew something', () => {
        const {albedo, sidecar} = packAtlas(build(), {angles: 8, scale: 2})
        for (const rect of sidecar.rects) {
            let opaque = 0
            for (let y = rect.y; y < rect.y + rect.height; y += 1) {
                for (let x = rect.x; x < rect.x + rect.width; x += 1) {
                    opaque += alphaAt(albedo, x, y) > 0 ? 1 : 0
                }
            }
            expect(opaque).toBeGreaterThan(0)
        }
    })

    test('trimming shrinks the sheet and records offsets that restore the position', () => {
        const loose = packAtlas(build(), {angles: 4, scale: 2})
        const tight = packAtlas(build(), {angles: 4, scale: 2, trim: true})

        expect(tight.sidecar.trimmed).toBe(true)
        expect(tight.albedo.width * tight.albedo.height).toBeLessThan(
            loose.albedo.width * loose.albedo.height
        )
        const trimmedRect = tight.sidecar.rects[0]
        expect((trimmedRect?.offsetX ?? 0) + (trimmedRect?.offsetY ?? 0)).toBeGreaterThan(0)
        // the untrimmed cell is still reported, so a consumer can put the content back
        expect(tight.sidecar.cell).toEqual(loose.sidecar.cell)
        expect((trimmedRect?.offsetX ?? 0) + (trimmedRect?.width ?? 0)).toBeLessThanOrEqual(
            tight.sidecar.cell.width
        )
    })

    test('the power-of-two option rounds both axes up', () => {
        const {sidecar} = packAtlas(build(), {angles: 4, scale: 2, powerOfTwo: true})
        const isPowerOfTwo = (v: number): boolean => (v & (v - 1)) === 0
        expect(isPowerOfTwo(sidecar.sheet.width)).toBe(true)
        expect(isPowerOfTwo(sidecar.sheet.height)).toBe(true)
    })

    test('the sidecar carries the tags, the palette and the generation record', () => {
        const doc = {
            ...build(),
            origin: {
                prompt: 'a test',
                sampler: {temperature: 0.8, seed: 7},
                model: 'stub',
                at: '2026-08-06T00:00:00.000Z'
            }
        }
        const {sidecar} = packAtlas(doc, {angles: 2, scale: 1})
        expect(sidecar.tags).toEqual([{name: 'idle', from: 0, to: 1}])
        expect(sidecar.palette.length).toBe(doc.palette.length)
        expect(sidecar.origin?.sampler.seed).toBe(7)
        expect(JSON.parse(sidecarJson(sidecar))).toEqual(sidecar)
    })

    test('the pivot sits inside the cell, on its horizontal centre', () => {
        const {sidecar} = packAtlas(build(), {angles: 4, scale: 2})
        expect(sidecar.pivot.x).toBe(sidecar.cell.width / 2)
        expect(sidecar.pivot.y).toBeGreaterThan(0)
        expect(sidecar.pivot.y).toBeLessThan(sidecar.cell.height)
    })
})
