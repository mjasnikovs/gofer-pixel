import {describe, expect, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {writeVox} from '../vox/vox-file'
import {hasVoxel} from '../vox/model'
import {rasterise, type VoxSpec} from './ops'

/**
 * The reference numbers come from running `voxgen.rasterise` on the same spec:
 *   .venv/bin/python -c "import json, voxgen; grid, palette = voxgen.rasterise(json.load(...))"
 * and hashing the `.vox` it writes. Same trick as `src/vox/parity.test.ts`: if the port ever
 * drifts from the Python — paint order, palette order, the ellipsoid's edge, the mirror — this
 * fails rather than a generated asset quietly differing between the two pipelines.
 */
const SPEC: VoxSpec = {
    name: 'parity',
    size: [13, 9, 7],
    mirror_x: true,
    ops: [
        {op: 'box', from: [1, 1, 0], to: [5, 4, 2], color: '#3366CC'},
        {op: 'ball', at: [3, 3, 4], r: [2, 3, 2], color: '#FF8800'},
        {op: 'erase', from: [2, 2, 1], to: [3, 3, 5]},
        {op: 'box', from: [0, 0, 6], to: [12, 8, 6], color: '#3366cc'},
        {op: 'ball', at: [11, 7, 1], r: [0, 0, 0], color: '#10FF20'}
    ]
}

describe('rasterise', () => {
    test('matches the Python voxel for voxel', () => {
        const model = rasterise(SPEC)
        expect(model.voxels.size).toBe(297)
        expect(new Set(model.voxels.values()).size).toBe(3)
    })

    test('builds the palette in first-seen order, one entry per distinct colour', () => {
        const {palette} = rasterise(SPEC)
        expect(palette.slice(0, 4)).toEqual([
            {r: 51, g: 102, b: 204, a: 255},
            {r: 255, g: 136, b: 0, a: 255},
            {r: 16, g: 255, b: 32, a: 255},
            {r: 0, g: 0, b: 0, a: 0}
        ])
        expect(palette.length).toBe(256)
    })

    test('writes a .vox byte-identical to the Python', () => {
        const bytes = writeVox(rasterise(SPEC))
        expect(bytes.length).toBe(2284)
        expect(createHash('sha256').update(bytes).digest('hex').slice(0, 16)).toBe(
            '5b1ca378d5a86cd0'
        )
    })

    test('erase carves and mirror reflects the finished model', () => {
        const model = rasterise(SPEC)
        expect(hasVoxel(model, 2, 2, 1)).toBe(false)
        // the single green voxel at x=11 has a reflection at 13-1-11 = 1
        expect(model.voxels.get((1 * 256 + 7) * 256 + 1)).toBe(3)
    })

    test('out-of-bounds parts of an op are dropped, not clamped', () => {
        const model = rasterise({
            name: 'edge',
            size: [4, 4, 4],
            mirror_x: false,
            ops: [{op: 'box', from: [-3, 0, 0], to: [1, 0, 0], color: '#ffffff'}]
        })
        expect(model.voxels.size).toBe(2)
        expect(hasVoxel(model, 0, 0, 0)).toBe(true)
        expect(hasVoxel(model, 1, 0, 0)).toBe(true)
    })
})
