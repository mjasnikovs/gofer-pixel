import {describe, expect, test} from 'bun:test'
import {evolve, makeRng, mutateSpec} from './evolve'
import {rasterise, type VoxSpec} from './ops'

const seed = (): VoxSpec => ({
    name: 'tower',
    size: [16, 16, 16],
    mirror_x: false,
    ops: [
        {op: 'box', from: [4, 4, 0], to: [11, 11, 9], color: '#808080'},
        {op: 'ball', at: [8, 8, 11], r: [3, 3, 2], color: '#aa4422'},
        {op: 'erase', from: [7, 7, 2], to: [8, 8, 4]}
    ]
})

describe('makeRng', () => {
    test('is deterministic and stays in 0–1', () => {
        const a = makeRng(7)
        const b = makeRng(7)
        for (let i = 0; i < 200; i += 1) {
            const value = a()
            expect(value).toBe(b())
            expect(value).toBeGreaterThanOrEqual(0)
            expect(value).toBeLessThan(1)
        }
    })

    test('different seeds diverge', () => {
        expect(makeRng(1)()).not.toBe(makeRng(2)())
    })
})

describe('mutateSpec', () => {
    test('never touches the input', () => {
        const original = seed()
        const before = JSON.stringify(original)
        const rng = makeRng(3)
        for (let i = 0; i < 50; i += 1) {
            mutateSpec(original, rng)
        }
        expect(JSON.stringify(original)).toBe(before)
    })

    test('the same seed gives the same mutation', () => {
        expect(JSON.stringify(mutateSpec(seed(), makeRng(11)))).toBe(
            JSON.stringify(mutateSpec(seed(), makeRng(11)))
        )
    })

    test('coordinates stay inside the canvas however many times it runs', () => {
        const rng = makeRng(5)
        let spec = seed()
        for (let i = 0; i < 400; i += 1) {
            spec = mutateSpec(spec, rng, {jitter: 6})
            for (const op of spec.ops) {
                const vectors = op.op === 'ball' ? [op.at] : [op.from, op.to]
                for (const vector of vectors) {
                    vector.forEach((value, axis) => {
                        expect(value).toBeGreaterThanOrEqual(0)
                        expect(value).toBeLessThan(spec.size[axis] ?? 0)
                    })
                }
            }
        }
    })

    test('colours stay valid hex, which the schema and the rasteriser both require', () => {
        const rng = makeRng(9)
        let spec = seed()
        for (let i = 0; i < 300; i += 1) {
            spec = mutateSpec(spec, rng)
            for (const op of spec.ops) {
                if (op.op !== 'erase') {
                    expect(op.color).toMatch(/^#[0-9a-f]{6}$/)
                }
            }
        }
    })

    test('the op list grows and shrinks but stays within bounds', () => {
        const rng = makeRng(4)
        let spec = seed()
        let sawGrowth = false
        let sawShrink = false
        for (let i = 0; i < 300; i += 1) {
            const before = spec.ops.length
            spec = mutateSpec(spec, rng, {structural: 0.9, maxOps: 6})
            sawGrowth ||= spec.ops.length > before
            sawShrink ||= spec.ops.length < before
            expect(spec.ops.length).toBeGreaterThanOrEqual(1)
            expect(spec.ops.length).toBeLessThanOrEqual(6)
        }
        expect(sawGrowth).toBe(true)
        expect(sawShrink).toBe(true)
    })

    test('a mutated spec still rasterises to something', () => {
        const rng = makeRng(21)
        let spec = seed()
        let empty = 0
        for (let i = 0; i < 100; i += 1) {
            spec = mutateSpec(spec, rng)
            if (rasterise(spec).voxels.size === 0) {
                empty += 1
            }
        }
        expect(empty).toBe(0)
    })
})

describe('evolve', () => {
    /** A scorer with a known optimum: the more voxels, the better. */
    const byVoxels = (specs: readonly VoxSpec[]): Promise<(number | null)[]> =>
        Promise.resolve(specs.map(spec => rasterise(spec).voxels.size))

    test('improves the score it is given', async () => {
        const result = await evolve([seed()], byVoxels, {
            generations: 6,
            population: 8,
            keep: 2,
            rng: makeRng(2),
            mutate: {jitter: 3, structural: 0.4}
        })
        expect(result.bestScore).toBeGreaterThan(rasterise(seed()).voxels.size)
        expect(result.history.length).toBe(7)
        expect(result.evaluations).toBeGreaterThan(8)
    })

    test('the best score never goes backwards across generations', async () => {
        const result = await evolve([seed()], byVoxels, {
            generations: 5,
            population: 6,
            rng: makeRng(8)
        })
        let running = -Infinity
        for (const value of result.history) {
            running = Math.max(running, value)
        }
        expect(result.bestScore).toBe(running)
    })

    test('a run is reproducible from its seed', async () => {
        const run = async () =>
            evolve([seed()], byVoxels, {generations: 4, population: 6, rng: makeRng(99)})
        const a = await run()
        const b = await run()
        expect(a.bestScore).toBe(b.bestScore)
        expect(JSON.stringify(a.best)).toBe(JSON.stringify(b.best))
    })

    test('a scorer that returns null for everything does not crash the loop', async () => {
        const result = await evolve([seed()], specs => Promise.resolve(specs.map(() => null)), {
            generations: 2,
            population: 4,
            rng: makeRng(1)
        })
        expect(result.bestScore).toBe(-Infinity)
        expect(result.history.length).toBe(3)
    })
})
