import {describe, expect, test} from 'bun:test'
import {DEFAULT_PALETTE, packKey, type VoxModel} from '../vox/model'
import {
    bboxFill,
    connectivity,
    overallScore,
    paletteCompliance,
    scoreModel,
    sliceUsage,
    symmetryX
} from './score'

const model = (voxels: [number, number, number, number][], sx = 8, sy = 8, sz = 8): VoxModel => ({
    sx,
    sy,
    sz,
    voxels: new Map(voxels.map(([x, y, z, c]) => [packKey(x, y, z), c])),
    palette: DEFAULT_PALETTE
})

describe('connectivity', () => {
    test('one solid run scores 1', () => {
        expect(
            connectivity(
                model([
                    [0, 0, 0, 1],
                    [1, 0, 0, 1],
                    [2, 0, 0, 1]
                ])
            )
        ).toBe(1)
    })

    test('a stray voxel costs exactly its share', () => {
        expect(
            connectivity(
                model([
                    [0, 0, 0, 1],
                    [1, 0, 0, 1],
                    [7, 7, 7, 1]
                ])
            )
        ).toBeCloseTo(2 / 3)
    })

    test('touching only at a corner is not connected', () => {
        expect(
            connectivity(
                model([
                    [0, 0, 0, 1],
                    [1, 1, 1, 1]
                ])
            )
        ).toBe(0.5)
    })

    test('an empty model scores 0 rather than dividing by zero', () => {
        expect(connectivity(model([]))).toBe(0)
    })
})

describe('the other checks', () => {
    test('slice usage counts the slices that hold something', () => {
        expect(
            sliceUsage(
                model(
                    [
                        [0, 0, 0, 1],
                        [0, 0, 3, 1]
                    ],
                    8,
                    8,
                    4
                )
            )
        ).toBe(0.5)
    })

    test('bbox fill is 1 for a solid brick and low for a shell', () => {
        const brick: [number, number, number, number][] = []
        for (let x = 0; x < 3; x += 1) {
            for (let y = 0; y < 3; y += 1) {
                brick.push([x, y, 0, 1])
            }
        }
        expect(bboxFill(model(brick))).toBe(1)
        expect(
            bboxFill(
                model([
                    [0, 0, 0, 1],
                    [7, 7, 7, 1]
                ])
            )
        ).toBeCloseTo(2 / 512)
    })

    test('symmetry is measured about the canvas width, so an off-centre pair scores 0', () => {
        expect(
            symmetryX(
                model([
                    [0, 0, 0, 1],
                    [7, 0, 0, 1]
                ])
            )
        ).toBe(1)
        expect(
            symmetryX(
                model([
                    [0, 0, 0, 1],
                    [1, 0, 0, 1]
                ])
            )
        ).toBe(0)
        expect(
            symmetryX(
                model(
                    [
                        [3, 0, 0, 1],
                        [4, 0, 0, 1]
                    ],
                    8
                )
            )
        ).toBe(1)
    })

    test('palette compliance is 1 when nothing is locked and drops when it is', () => {
        const m = model([
            [0, 0, 0, 1],
            [1, 0, 0, 9]
        ])
        expect(paletteCompliance(m)).toBe(1)
        expect(paletteCompliance(m, new Set([1]))).toBe(0.5)
        expect(paletteCompliance(m, new Set([1, 9]))).toBe(1)
    })
})

describe('scoreModel', () => {
    test('reports the parts and the counts together', () => {
        const scores = scoreModel(
            model([
                [0, 0, 0, 1],
                [1, 0, 0, 2]
            ])
        )
        expect(scores.voxels).toBe(2)
        expect(scores.colorsUsed).toBe(2)
        expect(scores.connectivity).toBe(1)
    })

    test('a scattered model sorts below a coherent one', () => {
        const coherent = model([
            [0, 0, 0, 1],
            [0, 0, 1, 1],
            [0, 0, 2, 1],
            [1, 0, 0, 1]
        ])
        const debris = model([
            [0, 0, 0, 1],
            [4, 4, 0, 1],
            [7, 1, 0, 1],
            [2, 6, 0, 1]
        ])
        expect(overallScore(scoreModel(coherent))).toBeGreaterThan(overallScore(scoreModel(debris)))
    })

    test('an empty model scores zero on everything that matters', () => {
        const scores = scoreModel(model([]))
        expect(overallScore(scores)).toBe(0)
    })
})
