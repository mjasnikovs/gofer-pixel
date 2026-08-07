import {describe, expect, test} from 'bun:test'
import {DEFAULT_PALETTE, packKey, type VoxModel} from '../vox/model'
import {angleAdvice, axisAlignedCoverage} from './angles'

/** A tall thin slab: changes silhouette a lot as it turns, so it needs many angles. */
const slab = (): VoxModel => {
    const voxels = new Map<number, number>()
    for (let z = 0; z < 12; z += 1) {
        for (let y = 0; y < 2; y += 1) {
            for (let x = 0; x < 14; x += 1) {
                voxels.set(packKey(x, y, z), 4)
            }
        }
    }
    return {sx: 16, sy: 16, sz: 12, voxels, palette: DEFAULT_PALETTE}
}

/** A cylinder: nearly the same from every heading, so it needs few. */
const cylinder = (): VoxModel => {
    const voxels = new Map<number, number>()
    for (let z = 0; z < 12; z += 1) {
        for (let y = 0; y < 16; y += 1) {
            for (let x = 0; x < 16; x += 1) {
                if (Math.hypot(x - 7.5, y - 7.5) < 6) {
                    voxels.set(packKey(x, y, z), 4)
                }
            }
        }
    }
    return {sx: 16, sy: 16, sz: 12, voxels, palette: DEFAULT_PALETTE}
}

describe('angleAdvice', () => {
    test('more angles never means more error', () => {
        const {options} = angleAdvice(slab(), {samples: 36})
        for (let i = 1; i < options.length; i += 1) {
            expect(options[i]?.error ?? 1).toBeLessThanOrEqual((options[i - 1]?.error ?? 0) + 1e-9)
        }
    })

    test('a shape that barely changes as it turns needs fewer angles than one that does', () => {
        const round = angleAdvice(cylinder(), {samples: 36})
        const flat = angleAdvice(slab(), {samples: 36})
        expect(round.suggested).toBeLessThan(flat.suggested)
        expect(round.stepChange).toBeLessThan(flat.stepChange)
    })

    test('a stricter target never suggests fewer angles', () => {
        const loose = angleAdvice(slab(), {samples: 36, maxError: 0.2}).suggested
        const strict = angleAdvice(slab(), {samples: 36, maxError: 0.02}).suggested
        expect(strict).toBeGreaterThanOrEqual(loose)
    })

    test('an unreachable target falls back to the largest count rather than failing', () => {
        const advice = angleAdvice(slab(), {samples: 24, maxError: 0, choices: [8, 16]})
        expect(advice.suggested).toBe(16)
    })

    test('the worst heading is at least as bad as the mean', () => {
        for (const option of angleAdvice(cylinder(), {samples: 24}).options) {
            expect(option.worst).toBeGreaterThanOrEqual(option.error)
        }
    })
})

describe('axisAlignedCoverage', () => {
    /**
     * Measured across the repo's models: axis-aligned frames show 3–14 % *less* coverage, because
     * at 0/90/180/270 the faces line up with the pixel grid. Pinned as a ratio below 1 so the day
     * it inverts somebody has to explain why.
     */
    test('axis-aligned frames are thinner than off-axis ones, not fatter', () => {
        const {ratio, onAxis, offAxis} = axisAlignedCoverage(slab())
        expect(onAxis).toBeGreaterThan(0)
        expect(offAxis).toBeGreaterThan(0)
        expect(ratio).toBeLessThan(1)
    })

    test('a round shape barely notices', () => {
        expect(axisAlignedCoverage(cylinder()).ratio).toBeGreaterThan(0.9)
    })
})
