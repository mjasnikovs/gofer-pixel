import {describe, expect, test} from 'bun:test'
import {addFrame, createDocument, editCel, type Document} from '../doc/document'
import {atlasMeta, atlasModels, packAtlas} from '../export/atlas'
import {PALETTE} from './palette'
import {runBake} from './render-worker'

const build = (): Document => {
    let doc = createDocument({size: {sx: 8, sy: 8, sz: 4}, palette: PALETTE, name: 'worker'})
    doc = editCel(doc, 0, 0, volume => {
        volume.fillBox({x0: 1, y0: 1, z0: 0, x1: 5, y1: 5, z1: 2}, 4)
    })
    doc = addFrame(doc)
    return editCel(doc, 0, 1, volume => {
        volume.fillBox({x0: 2, y0: 2, z0: 0, x1: 4, y1: 4, z1: 3}, 6)
    })
}

describe('runBake', () => {
    /**
     * The job the Worker does, run here. If these two ever diverge the Worker path would be
     * producing different sprites from the same document, which is the failure that would be
     * hardest to notice.
     */
    test('produces byte-identical pixels to baking on the calling thread', () => {
        const doc = build()
        const options = {angles: 8, scale: 3, trim: true}
        const direct = packAtlas(doc, options)
        const viaWorker = runBake({
            id: 1,
            models: atlasModels(doc),
            meta: atlasMeta(doc),
            options
        })

        expect(viaWorker.albedo.data).toEqual(direct.albedo.data)
        expect(viaWorker.normal.data).toEqual(direct.normal.data)
        expect(viaWorker.sidecar).toEqual(direct.sidecar)
    })

    test('echoes the request id, so a stale reply can be told apart', () => {
        const doc = build()
        expect(
            runBake({id: 42, models: atlasModels(doc), meta: atlasMeta(doc), options: {angles: 2}})
                .id
        ).toBe(42)
    })

    test('reports how long the render took', () => {
        const doc = build()
        const result = runBake({
            id: 1,
            models: atlasModels(doc),
            meta: atlasMeta(doc),
            options: {angles: 4, scale: 2}
        })
        expect(result.ms).toBeGreaterThan(0)
    })

    test('the models it is sent survive structured cloning', () => {
        const models = atlasModels(build())
        const cloned = structuredClone(models)
        expect(cloned[0]?.voxels.size).toBe(models[0]?.voxels.size ?? -1)
        expect(cloned[0]?.palette[3]).toEqual(models[0]?.palette[3] ?? {r: 0, g: 0, b: 0, a: 0})

        const direct = runBake({id: 1, models, meta: atlasMeta(build()), options: {angles: 4}})
        const viaClone = runBake({
            id: 1,
            models: cloned,
            meta: structuredClone(atlasMeta(build())),
            options: {angles: 4}
        })
        expect(viaClone.albedo.data).toEqual(direct.albedo.data)
    })

    test('an empty document is an error, not an empty sheet', () => {
        expect(() =>
            runBake({
                id: 1,
                models: [],
                meta: atlasMeta(build()),
                options: {}
            })
        ).toThrow('nothing to pack')
    })
})
