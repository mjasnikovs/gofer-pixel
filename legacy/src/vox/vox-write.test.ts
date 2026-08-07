import {describe, expect, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {readVox, writeVox} from './vox-file'
import {DEFAULT_PALETTE, packKey} from './model'
import type {VoxModel} from './model'

const load = async (name: string): Promise<VoxModel> =>
    readVox(new Uint8Array(await Bun.file(`${import.meta.dir}/../../${name}`).arrayBuffer()))

const digest = (bytes: Uint8Array): string =>
    createHash('sha256').update(bytes).digest('hex').slice(0, 16)

describe('writeVox', () => {
    /**
     * Hashes of `voxgen.py:write_vox` fed the same parsed model:
     *   .venv/bin/python -c "import voxslice, voxgen; ..."
     * Byte-for-byte, not just readable-back, so the writer cannot drift into a private dialect.
     */
    test.each([
        ['car.vox', '019a738ac7c87e2b'],
        ['truck.vox', 'd38f0fe0a922923d'],
        ['fork1.vox', 'a13231519a15c578']
    ])('%s matches the Python writer byte for byte', async (name, hash) => {
        expect(digest(writeVox(await load(name)))).toBe(hash)
    })

    test.each(['car.vox', 'truck.vox', 'fork1.vox'])('%s survives a round trip', async name => {
        const original = await load(name)
        const reparsed = readVox(writeVox(original))

        expect([reparsed.sx, reparsed.sy, reparsed.sz]).toEqual([
            original.sx,
            original.sy,
            original.sz
        ])
        expect([...reparsed.voxels]).toEqual([...original.voxels])
        expect(reparsed.palette).toEqual(original.palette)
    })

    test('an empty model is still a valid file', () => {
        const empty: VoxModel = {sx: 8, sy: 8, sz: 8, voxels: new Map(), palette: DEFAULT_PALETTE}
        const reparsed = readVox(writeVox(empty))

        expect(reparsed.voxels.size).toBe(0)
        expect([reparsed.sx, reparsed.sy, reparsed.sz]).toEqual([8, 8, 8])
    })

    test('a short palette is padded out to the 256 entries the format demands', () => {
        const model: VoxModel = {
            sx: 2,
            sy: 2,
            sz: 2,
            voxels: new Map([[packKey(1, 1, 1), 1]]),
            palette: [{r: 10, g: 20, b: 30, a: 255}]
        }
        const bytes = writeVox(model)
        const reparsed = readVox(bytes)

        expect(reparsed.palette.length).toBe(256)
        expect(reparsed.palette[0]).toEqual({r: 10, g: 20, b: 30, a: 255})
        expect(reparsed.palette[1]).toEqual({r: 0, g: 0, b: 0, a: 0})
        expect(reparsed.voxels.get(packKey(1, 1, 1))).toBe(1)
    })
})
