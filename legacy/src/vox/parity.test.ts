import {describe, expect, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {readVox} from './vox-file'
import {composeSheet, composeStacked, sliceLayers} from './slice'
import {light, renderAngle, rotationSheet} from './render'
import type {RgbaImage} from '../image/rgba'
import type {VoxModel} from './model'

/**
 * The reference values come from running the Python original on the same files:
 *   .venv/bin/python -c "import voxslice, voxrender; ..."
 * They are pixel hashes, so any drift in rounding or paint order fails here rather than showing up
 * as a slightly-wrong sprite months later.
 *
 * The render hashes were regenerated deliberately when the centring offset was floored to fix the
 * axis-aligned striping defect (see `render.test.ts`). Both renderers changed together; these are
 * the post-fix Python values.
 */
const digest = ({data}: RgbaImage): string =>
    createHash('sha256').update(data).digest('hex').slice(0, 16)

const load = async (name: string): Promise<VoxModel> =>
    readVox(new Uint8Array(await Bun.file(`${import.meta.dir}/../../${name}`).arrayBuffer()))

describe('readVox', () => {
    test.each([
        ['car.vox', 16, 10, 7, 478, 83176],
        ['truck.vox', 26, 14, 12, 2876, 14560],
        ['fork1.vox', 24, 14, 18, 6048, 57456]
    ])('%s matches the Python parse', async (name, sx, sy, sz, count, colorSum) => {
        const model = await load(name)
        expect([model.sx, model.sy, model.sz]).toEqual([sx, sy, sz])
        expect(model.voxels.size).toBe(count)
        expect([...model.voxels.values()].reduce((a, b) => a + b, 0)).toBe(colorSum)
    })

    test('reads the embedded palette, not the default one', async () => {
        const model = await load('truck.vox')
        expect(model.palette[0]).toEqual({r: 51, g: 51, b: 51, a: 255})
    })

    test('rejects a file without the magic bytes', () => {
        expect(() => readVox(new Uint8Array(32))).toThrow('not a .vox file')
    })
})

describe('slice and render parity with the Python original', () => {
    test('sheet and stacked preview', async () => {
        const layers = sliceLayers(await load('car.vox'), 2)

        const sheet = composeSheet(layers)
        expect([sheet.width, sheet.height]).toEqual([232, 22])
        expect(digest(sheet)).toBe('a074af549831b0c6')

        const stacked = composeStacked(layers, 2)
        expect([stacked.width, stacked.height]).toEqual([32, 32])
        expect(digest(stacked)).toBe('6b722cee4533164e')
    })

    test('albedo, normal and lit render at 30 degrees', async () => {
        const frame = renderAngle(await load('car.vox'), 30, {scale: 3})

        expect([frame.albedo.width, frame.albedo.height]).toEqual([57, 75])
        expect(digest(frame.albedo)).toBe('f284cfb4577509fc')
        expect(digest(frame.normal)).toBe('58d57a1f275b0839')
        expect(digest(light(frame))).toBe('985ffe769c63ff41')
    })

    test('eight-step rotation sheet', async () => {
        const sheet = rotationSheet(await load('car.vox'), 8, {scale: 2})

        expect([sheet.albedo.width, sheet.albedo.height]).toEqual([313, 52])
        expect(digest(sheet.albedo)).toBe('72b045f63da3e534')
        expect(digest(sheet.normal)).toBe('b38b3b7a4bb4200c')
    })
})
