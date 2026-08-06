import {describe, expect, test} from 'bun:test'
import {
    colorFromHex,
    colorToHex,
    decodeVolume,
    encodeVolume,
    loadProject,
    saveProject,
    serializeDocument
} from './serialize'
import {
    addFrame,
    addLayer,
    addTag,
    celAt,
    createDocument,
    documentFromModel,
    editCel,
    frameToModel,
    frameToVox,
    updateLayer
} from './document'
import {Volume} from './volume'
import {readVox} from '../vox/vox-file'
import {PALETTE} from '../vox/palette'
import {rect} from './tools'

const size = {sx: 16, sy: 16, sz: 16}
const ctx = {size}

describe('colour hex', () => {
    test('round-trips including alpha', () => {
        expect(colorToHex({r: 255, g: 0, b: 128, a: 255})).toBe('#ff0080ff')
        expect(colorFromHex('#ff0080ff')).toEqual({r: 255, g: 0, b: 128, a: 255})
        expect(colorFromHex('#0a141e')).toEqual({r: 10, g: 20, b: 30, a: 255})
    })
})

describe('volume encoding', () => {
    test('round-trips an arbitrary volume exactly', () => {
        const volume = new Volume()
        rect(volume, ctx, 2, 2, 9, 9, 3, 7)
        rect(volume, ctx, 0, 0, 15, 15, 0, 2)
        volume.set(15, 15, 15, 200)

        const back = decodeVolume(encodeVolume(volume, size), size)
        expect(back.count).toBe(volume.count)
        const mismatches: string[] = []
        volume.forEach((x, y, z, color) => {
            if (back.get(x, y, z) !== color) {
                mismatches.push(`${String(x)},${String(y)},${String(z)}`)
            }
        })
        expect(mismatches).toEqual([])
    })

    test('an empty volume encodes small and comes back empty', () => {
        const encoded = encodeVolume(new Volume(), size)
        expect(encoded.length).toBeLessThan(64)
        expect(decodeVolume(encoded, size).isEmpty).toBe(true)
    })

    test('a full volume beats one byte per voxel by a wide margin', () => {
        const volume = new Volume()
        volume.fillBox({x0: 0, y0: 0, z0: 0, x1: 15, y1: 15, z1: 15}, 4)
        expect(encodeVolume(volume, size).length).toBeLessThan(16 ** 3 / 10)
    })

    test('runs longer than 255 survive the split', () => {
        const volume = new Volume()
        volume.fillBox({x0: 0, y0: 0, z0: 0, x1: 15, y1: 15, z1: 2}, 9)
        const back = decodeVolume(encodeVolume(volume, size), size)
        expect(back.count).toBe(16 * 16 * 3)
        expect(back.get(15, 15, 2)).toBe(9)
        expect(back.get(0, 0, 3)).toBe(0)
    })

    test('all 255 palette indices survive', () => {
        const volume = new Volume()
        for (let i = 1; i <= 255; i += 1) {
            volume.set(i % 16, Math.floor(i / 16), 0, i)
        }
        const back = decodeVolume(encodeVolume(volume, size), size)
        for (let i = 1; i <= 255; i += 1) {
            expect(back.get(i % 16, Math.floor(i / 16), 0)).toBe(i)
        }
    })
})

describe('project save and load', () => {
    const build = () => {
        let doc = createDocument({size, palette: PALETTE, name: 'test sprite'})
        doc = addLayer(doc, 'details')
        doc = addFrame(doc)
        doc = editCel(doc, 0, 0, v => rect(v, ctx, 1, 1, 8, 8, 0, 5))
        doc = editCel(doc, 1, 1, v => v.set(3, 3, 4, 9))
        doc = updateLayer(doc, 1, {
            visible: false,
            locked: true,
            opacity: 0.5,
            offset: {x: 1, y: 2, z: 3}
        })
        return addTag(doc, {name: 'walk', from: 0, to: 1})
    }

    test('a project round-trips through JSON with every field intact', () => {
        const before = build()
        const after = loadProject(saveProject(before))

        expect(after.name).toBe(before.name)
        expect(after.size).toEqual(before.size)
        expect(after.frames).toBe(before.frames)
        expect(after.tags).toEqual(before.tags)
        expect(after.palette).toEqual(before.palette)
        expect(after.layers.map(l => [l.id, l.name, l.visible, l.locked, l.opacity])).toEqual(
            before.layers.map(l => [l.id, l.name, l.visible, l.locked, l.opacity])
        )
        expect(after.layers[1]?.offset).toEqual({x: 1, y: 2, z: 3})
    })

    test('the voxels come back identical, empty cels stay empty', () => {
        const before = build()
        const after = loadProject(saveProject(before))

        expect(celAt(after, 0, 0)?.count).toBe(celAt(before, 0, 0)?.count ?? -1)
        expect(celAt(after, 1, 1)?.get(3, 3, 4)).toBe(9)
        expect(celAt(after, 1, 0)).toBeNull()
        expect(celAt(after, 0, 1)).toBeNull()
    })

    test('a reloaded document renders to the same pixels', () => {
        const before = build()
        const after = loadProject(saveProject(before))
        expect([...frameToModel(after, 0).voxels]).toEqual([...frameToModel(before, 0).voxels])
    })

    test('the file is text a human can read', () => {
        const text = saveProject(build())
        expect(text.startsWith('{')).toBe(true)
        expect(text).toContain('"name":"test sprite"')
        expect(text).toContain('"walk"')
    })

    test('an unknown version is refused rather than half-loaded', () => {
        const data = serializeDocument(build())
        expect(() => loadProject(JSON.stringify({...data, version: 99}))).toThrow('no migration')
    })

    test('a version 1 file still loads, and simply has no origin', () => {
        const data = serializeDocument(build())
        const old = JSON.stringify({...data, version: 1, origin: undefined})
        const loaded = loadProject(old)
        expect(loaded.name).toBe('test sprite')
        expect(loaded.origin).toBeUndefined()
        expect(celAt(loaded, 0, 0)?.count).toBe(celAt(build(), 0, 0)?.count)
    })

    test('the generation record survives a round trip', () => {
        const origin = {
            prompt: 'a stone tower',
            sampler: {temperature: 0.8, seed: 12345},
            model: 'Qwen3.6-27B',
            at: '2026-08-06T00:00:00.000Z'
        }
        const doc = {...build(), origin}
        expect(loadProject(saveProject(doc)).origin).toEqual(origin)
    })
})

describe('.vox bridge', () => {
    test('a document exports to .vox and imports back to the same voxels', async () => {
        const original = readVox(
            new Uint8Array(await Bun.file(`${import.meta.dir}/../../car.vox`).arrayBuffer())
        )
        const doc = documentFromModel(original, 'car')

        expect(doc.size).toEqual({sx: original.sx, sy: original.sy, sz: original.sz})
        expect(celAt(doc, 0, 0)?.count).toBe(original.voxels.size)

        const exported = readVox(frameToVox(doc, 0))
        expect(exported.voxels.size).toBe(original.voxels.size)
        for (const [key, color] of original.voxels) {
            expect(exported.voxels.get(key)).toBe(color)
        }
    })

    test('an imported model can be edited without touching the import', () => {
        const doc = documentFromModel(
            {sx: 8, sy: 8, sz: 8, voxels: new Map([[0, 4]]), palette: PALETTE},
            'tiny'
        )
        const edited = editCel(doc, 0, 0, v => v.set(1, 1, 1, 6))

        expect(celAt(doc, 0, 0)?.count).toBe(1)
        expect(celAt(edited, 0, 0)?.count).toBe(2)
    })
})
