import {describe, expect, test} from 'bun:test'
import {DEFAULT_PALETTE, packKey, type VoxModel} from './model'
import {readVox} from './vox-file'
import {IDENTITY_ROTATION, readVoxScene, writeVoxScene} from './vox-scene'

const model = (color: number, at: [number, number, number]): VoxModel => ({
    sx: 8,
    sy: 8,
    sz: 8,
    voxels: new Map([[packKey(at[0], at[1], at[2]), color]]),
    palette: DEFAULT_PALETTE
})

const tags = (bytes: Uint8Array): string[] => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const out: string[] = []
    let pos = 8 + 12
    while (pos + 12 <= bytes.length) {
        out.push(
            String.fromCharCode(
                view.getUint8(pos),
                view.getUint8(pos + 1),
                view.getUint8(pos + 2),
                view.getUint8(pos + 3)
            )
        )
        pos = pos + 12 + view.getInt32(pos + 4, true) + view.getInt32(pos + 8, true)
    }
    return out
}

describe('writeVoxScene', () => {
    const scene = () =>
        writeVoxScene([
            {model: model(3, [1, 1, 1]), name: 'body'},
            {model: model(5, [2, 2, 2]), name: 'wheels', offset: [0, 0, 2]},
            {model: model(7, [3, 3, 3]), name: 'hidden bits', hidden: true}
        ])

    test('writes one SIZE/XYZI pair per model and exactly one palette', () => {
        const written = tags(scene())
        expect(written.filter(tag => tag === 'SIZE').length).toBe(3)
        expect(written.filter(tag => tag === 'XYZI').length).toBe(3)
        expect(written.filter(tag => tag === 'RGBA').length).toBe(1)
    })

    test('writes the graph the spec requires: transform, group, then a transform per shape', () => {
        const written = tags(scene())
        expect(written.filter(tag => tag === 'nTRN').length).toBe(4) // root plus one per model
        expect(written.filter(tag => tag === 'nGRP').length).toBe(1)
        expect(written.filter(tag => tag === 'nSHP').length).toBe(3)
        expect(written.filter(tag => tag === 'LAYR').length).toBe(3)
        // the graph comes after the geometry, as MagicaVoxel writes it
        expect(written.indexOf('nTRN')).toBeGreaterThan(written.lastIndexOf('XYZI'))
    })

    test('refuses an empty scene rather than writing a file with no model', () => {
        expect(() => writeVoxScene([])).toThrow('at least one model')
    })

    test('the identity rotation is the spec bit-field value, not zero', () => {
        expect(IDENTITY_ROTATION).toBe(4)
        expect(new TextDecoder().decode(scene())).toContain('_r')
    })
})

describe('readVoxScene', () => {
    test('round-trips models, layer names and visibility', () => {
        const scene = readVoxScene(
            writeVoxScene([
                {model: model(3, [1, 1, 1]), name: 'body'},
                {model: model(5, [2, 2, 2]), name: 'wheels'},
                {model: model(7, [3, 3, 3]), name: 'hidden bits', hidden: true}
            ])
        )

        expect(scene.models.length).toBe(3)
        expect(scene.layers.map(layer => layer.name)).toEqual(['body', 'wheels', 'hidden bits'])
        expect(scene.layers.map(layer => layer.hidden)).toEqual([false, false, true])
        expect(scene.models[0]?.voxels.get(packKey(1, 1, 1))).toBe(3)
        expect(scene.models[2]?.voxels.get(packKey(3, 3, 3))).toBe(7)
    })

    test('each model knows which layer it belongs to', () => {
        const scene = readVoxScene(
            writeVoxScene([
                {model: model(3, [1, 1, 1]), name: 'a'},
                {model: model(5, [2, 2, 2]), name: 'b'}
            ])
        )
        expect(scene.modelLayer.get(0)).toBe(0)
        expect(scene.modelLayer.get(1)).toBe(1)
    })

    test('the palette survives, once, for the whole file', () => {
        const scene = readVoxScene(
            writeVoxScene([{model: model(3, [1, 1, 1])}, {model: model(5, [2, 2, 2])}])
        )
        expect(scene.models[0]?.palette[2]).toEqual(DEFAULT_PALETTE[2] ?? {r: 0, g: 0, b: 0, a: 0})
        expect(scene.models[1]?.palette).toEqual(scene.models[0]?.palette ?? [])
    })

    test('a single-model file written the old way still reads as a scene of one', async () => {
        const bytes = new Uint8Array(
            await Bun.file(`${import.meta.dir}/../../car.vox`).arrayBuffer()
        )
        const scene = readVoxScene(bytes)
        expect(scene.models.length).toBe(1)
        expect(scene.models[0]?.voxels.size).toBe(478)
    })
})

describe('the two readers agree', () => {
    test('readVox flattens what readVoxScene keeps apart', () => {
        const bytes = writeVoxScene([
            {model: model(3, [1, 1, 1]), name: 'a'},
            {model: model(5, [2, 2, 2]), name: 'b'}
        ])
        const flat = readVox(bytes)
        const scene = readVoxScene(bytes)

        expect(scene.models.length).toBe(2)
        // the flat reader merges both models into one volume, which is what "just give me the
        // model" means and is why the two exist
        expect(flat.voxels.size).toBe(2)
        expect(flat.voxels.get(packKey(1, 1, 1))).toBe(3)
        expect(flat.voxels.get(packKey(2, 2, 2))).toBe(5)
    })
})
