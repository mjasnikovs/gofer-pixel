import {describe, expect, test} from 'bun:test'
import {readVox} from './vox-file'
import {renderAngle} from './render'
import type {RgbaImage} from '../image/rgba'
import type {VoxModel} from './model'

const load = async (name: string): Promise<VoxModel> =>
    readVox(new Uint8Array(await Bun.file(`${import.meta.dir}/../../${name}`).arrayBuffer()))

interface Coverage {
    columns: number
    rows: number
    pixels: number
}

const coverage = ({width, height, data}: RgbaImage): Coverage => {
    const columns = new Set<number>()
    const rows = new Set<number>()
    let pixels = 0
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if ((data[(y * width + x) * 4 + 3] ?? 0) !== 0) {
                columns.add(x)
                rows.add(y)
                pixels += 1
            }
        }
    }
    return {columns: columns.size, rows: rows.size, pixels}
}

/** Distinct occupied x and y values in the volume — the most columns a render could possibly use. */
const extent = ({voxels}: VoxModel): {x: number; y: number} => {
    const xs = new Set<number>()
    const ys = new Set<number>()
    for (const key of voxels.keys()) {
        xs.add(Math.floor(key / 65536))
        ys.add(Math.floor(key / 256) % 256)
    }
    return {x: xs.size, y: ys.size}
}

/**
 * The axis-aligned striping defect: with a fractional centring offset the rotation terms cancel at
 * 0/90/180/270 and every voxel centre lands on a .5 tie, so round-half-to-even merged adjacent
 * columns and dropped ~45 % of the visible model at exactly the four angles a top-down game uses
 * most. It was size-dependent — only models with an odd `diag - sx` were affected, which is why
 * car.vox (16×10) striped and truck.vox (26×14) did not.
 *
 * These assert the property, not a pixel count, so they survive future renderer changes.
 */
describe('axis-aligned angles keep full resolution', () => {
    test.each(['car.vox', 'truck.vox', 'fork1.vox'])(
        '%s uses every occupied column',
        async name => {
            const model = await load(name)
            const {x, y} = extent(model)

            for (const angle of [0, 180]) {
                expect(coverage(renderAngle(model, angle).albedo).columns).toBe(x)
            }
            for (const angle of [90, 270]) {
                expect(coverage(renderAngle(model, angle).albedo).columns).toBe(y)
            }
        }
    )

    test('car.vox at 0° is as dense as its diagonal renders', async () => {
        const model = await load('car.vox')
        const diagonal = coverage(renderAngle(model, 30).albedo).pixels

        // pre-fix this was 82 against 148 — a 45 % loss
        expect(coverage(renderAngle(model, 0).albedo).pixels).toBeGreaterThan(diagonal * 0.9)
    })
})

describe('renderAngle geometry', () => {
    test.each([
        [1, 1],
        [3, 3],
        [3, 2]
    ])('lift %i at scale %i leaves no empty row inside the sprite', async (scale, lift) => {
        const model = await load('car.vox')
        const {albedo} = renderAngle(model, 45, {scale, lift})
        const {width, height, data} = albedo

        const occupied: number[] = []
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                if ((data[(y * width + x) * 4 + 3] ?? 0) !== 0) {
                    occupied.push(y)
                    break
                }
            }
        }
        const first = occupied[0] ?? 0
        const last = occupied[occupied.length - 1] ?? 0

        // lift <= scale means consecutive slices touch, so the painted band is unbroken
        expect(occupied.length).toBe(last - first + 1)
    })

    test('the frame is sized for the rotated footprint', async () => {
        const model = await load('car.vox')
        const {albedo} = renderAngle(model, 0, {scale: 2})
        const diag = Math.ceil(Math.hypot(model.sx, model.sy))

        expect(albedo.width).toBe(diag * 2)
        expect(albedo.height).toBe(diag * 2 + (model.sz - 1) * 2)
    })
})
