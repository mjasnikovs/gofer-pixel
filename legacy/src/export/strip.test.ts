import {describe, expect, test} from 'bun:test'
import {celAt, createDocument, editCel, frameToModel, type Document} from '../doc/document'
import {PALETTE} from '../vox/palette'
import {applyStrip, documentFromStrip, sliceStrip, stripLayout, stripSize} from './strip'

const size = {sx: 6, sy: 5, sz: 4}

const build = (): Document =>
    editCel(createDocument({size, palette: PALETTE, name: 'strip'}), 0, 0, volume => {
        volume.fillBox({x0: 1, y0: 1, z0: 0, x1: 3, y1: 3, z1: 1}, 5)
        volume.set(0, 0, 3, 9)
    })

describe('sliceStrip', () => {
    test('lays every slice out in the grid', () => {
        const layout = stripLayout({columns: 2, pad: 1, scale: 1})
        const {width, height, rows} = stripSize(size, layout)
        const image = sliceStrip(build(), 0, layout)
        expect([image.width, image.height]).toEqual([width, height])
        expect(rows).toBe(2)
    })

    test('a round trip through the strip preserves every voxel', () => {
        const doc = build()
        for (const layout of [
            stripLayout(),
            stripLayout({columns: 3, pad: 0, scale: 1}),
            stripLayout({columns: 2, pad: 2, scale: 3})
        ]) {
            const back = applyStrip(doc, 0, sliceStrip(doc, 0, layout), layout)
            const before = frameToModel(doc, 0)
            const after = frameToModel(back, 0)
            expect(after.voxels.size).toBe(before.voxels.size)
            for (const [key, color] of before.voxels) {
                expect(after.palette[(after.voxels.get(key) ?? 0) - 1]).toEqual(
                    before.palette[color - 1] ?? {r: 0, g: 0, b: 0, a: 0}
                )
            }
        }
    })

    test('a colour the palette does not have is appended, not snapped to the nearest', () => {
        const doc = build()
        const image = sliceStrip(doc, 0)
        // paint one pixel of the bottom slice a colour the palette has never seen
        image.data.set([1, 2, 3, 255], ((1 + size.sy - 1 - 0) * image.width + 1 + 0) * 4)
        const back = applyStrip(doc, 0, image)

        expect(back.palette.length).toBe(doc.palette.length + 1)
        expect(back.palette[back.palette.length - 1]).toEqual({r: 1, g: 2, b: 3, a: 255})
    })

    test('an erased pixel erases the voxel', () => {
        const doc = build()
        const image = sliceStrip(doc, 0)
        image.data.fill(0)
        expect(celAt(applyStrip(doc, 0, image), 0, 0)?.count).toBe(0)
    })

    test('a strip from another tool becomes a document on its own', () => {
        const doc = build()
        const rebuilt = documentFromStrip(sliceStrip(doc, 0), size, 'round trip')
        expect(rebuilt.name).toBe('round trip')
        expect(frameToModel(rebuilt, 0).voxels.size).toBe(frameToModel(doc, 0).voxels.size)
        expect(rebuilt.palette.length).toBe(2) // only the two colours the model actually uses
    })
})
