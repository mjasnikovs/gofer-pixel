/**
 * TEST 24: how many baked angles does a sprite stack actually need?
 *
 * `PRODUCTION_PLAN.md` §8 defaults to 16 on a forum consensus and Starcraft's 22.5° increments —
 * evidence about *pre-rendered sprites*, which is not this problem, because a sprite stack changes
 * silhouette with angle in ways a pre-rendered sprite does not. §14 says to re-derive it from our
 * own renders and never has. This does that, and settles the sub-question §14 raises: whether the
 * bake should skip the axis-aligned angles or offset the whole set by half a step.
 *
 * The measure is the error a player sees. A game facing θ shows the nearest baked angle, so the
 * error is the difference between the true render at θ and the one actually displayed. Measured as
 * **silhouette mismatch**: the fraction of the true sprite's pixels whose coverage is wrong. Colour
 * differences inside a correct silhouette are far less visible than a shape that is the wrong
 * shape, and coverage is what a stack gets wrong when it turns.
 *
 *   bun experiments/t24_angles.ts
 */
import {prepareNormals, renderAngle} from '../src/vox/render'
import {readVox} from '../src/vox/vox-file'
import {DEFAULT_PALETTE, packKey, type VoxModel} from '../src/vox/model'
import type {RgbaImage} from '../src/image/rgba'

const SCALE = 4

const coverage = ({data}: RgbaImage): number => {
    let n = 0
    for (let i = 3; i < data.length; i += 4) {
        if ((data[i] ?? 0) !== 0) {
            n += 1
        }
    }
    return n
}

/** Fraction of the true sprite's pixels whose coverage the shown sprite gets wrong. */
const silhouetteError = (truth: RgbaImage, shown: RgbaImage): number => {
    let wrong = 0
    let covered = 0
    for (let i = 3; i < truth.data.length; i += 4) {
        const a = (truth.data[i] ?? 0) !== 0
        const b = (shown.data[i] ?? 0) !== 0
        if (a) {
            covered += 1
        }
        if (a !== b) {
            wrong += 1
        }
    }
    return covered === 0 ? 0 : wrong / covered
}

const synthetic = (n: number): VoxModel => {
    const voxels = new Map<number, number>()
    let seed = 99
    const rand = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
    }
    // a lumpy solid rather than noise: noise has no silhouette to lose
    for (let z = 0; z < n; z += 1) {
        for (let y = 0; y < n; y += 1) {
            for (let x = 0; x < n; x += 1) {
                const dx = x / n - 0.5
                const dy = y / n - 0.5
                const dz = z / n - 0.5
                const r = Math.hypot(dx, dy) * (1.2 + 0.6 * Math.sin(z * 0.7))
                if (r < 0.32 - dz * 0.1) {
                    voxels.set(packKey(x, y, z), 1 + Math.floor(rand() * 6))
                }
            }
        }
    }
    return {sx: n, sy: n, sz: n, voxels, palette: DEFAULT_PALETTE}
}

const load = async (name: string): Promise<VoxModel> =>
    readVox(new Uint8Array(await Bun.file(name).arrayBuffer()))

const models: [string, VoxModel][] = [
    ['car.vox', await load('car.vox')],
    ['truck.vox', await load('truck.vox')],
    ['fork1.vox', await load('fork1.vox')],
    ['synthetic 32³', synthetic(32)]
]

const percentile = (values: number[], p: number): number => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
}

console.log('=== error from showing the nearest baked angle, over 360 headings')
console.log('model            angles   mean silhouette error   95th percentile   worst')
const counts = [8, 16, 32, 64]
for (const [name, model] of models) {
    const normals = prepareNormals(model)
    // the truth: every whole degree
    const truth = Array.from({length: 360}, (_unused, deg) =>
        renderAngle(model, deg, {scale: SCALE, normals})
    )
    for (const n of counts) {
        const baked = Array.from({length: n}, (_unused, i) =>
            renderAngle(model, (i * 360) / n, {scale: SCALE, normals})
        )
        const errors = truth.map((frame, deg) => {
            const nearest = Math.round((deg * n) / 360) % n
            return silhouetteError(frame.albedo, baked[nearest]?.albedo ?? frame.albedo)
        })
        const mean = errors.reduce((a, b) => a + b, 0) / errors.length
        console.log(
            `${name.padEnd(16)} ${String(n).padStart(6)}   ${(mean * 100).toFixed(1).padStart(20)}%`
                + `   ${(percentile(errors, 0.95) * 100).toFixed(1).padStart(14)}%`
                + `   ${(Math.max(...errors) * 100).toFixed(1).padStart(5)}%`
        )
    }
}

console.log('\n=== how much the sprite changes per baked step (16 angles)')
console.log('model            mean step change   worst step')
for (const [name, model] of models) {
    const normals = prepareNormals(model)
    const baked = Array.from({length: 16}, (_unused, i) =>
        renderAngle(model, (i * 360) / 16, {scale: SCALE, normals})
    )
    const steps = baked.map((frame, i) =>
        silhouetteError(frame.albedo, baked[(i + 1) % 16]?.albedo ?? frame.albedo)
    )
    console.log(
        `${name.padEnd(16)} ${(((steps.reduce((a, b) => a + b, 0) / steps.length) * 100).toFixed(1) + '%').padStart(16)}`
            + `   ${((Math.max(...steps) * 100).toFixed(1) + '%').padStart(10)}`
    )
}

console.log('\n=== are the axis-aligned angles outliers? (coverage, 16-angle bake)')
console.log('model            axis-aligned   off-axis   ratio')
for (const [name, model] of models) {
    const normals = prepareNormals(model)
    const covers = Array.from({length: 16}, (_unused, i) =>
        coverage(renderAngle(model, (i * 360) / 16, {scale: SCALE, normals}).albedo)
    )
    const onAxis = [0, 4, 8, 12].map(i => covers[i] ?? 0)
    const offAxis = covers.filter((_unused, i) => i % 4 !== 0)
    const meanOn = onAxis.reduce((a, b) => a + b, 0) / onAxis.length
    const meanOff = offAxis.reduce((a, b) => a + b, 0) / offAxis.length
    console.log(
        `${name.padEnd(16)} ${String(Math.round(meanOn)).padStart(12)}`
            + `${String(Math.round(meanOff)).padStart(11)}`
            + `${(meanOn / meanOff).toFixed(3).padStart(8)}`
    )
}

console.log('\n=== does offsetting the whole set by half a step help?')
console.log('model            aligned set   offset set   change')
for (const [name, model] of models) {
    const normals = prepareNormals(model)
    const truth = Array.from({length: 360}, (_unused, deg) =>
        renderAngle(model, deg, {scale: SCALE, normals})
    )
    const measure = (offset: number): number => {
        const n = 16
        const baked = Array.from({length: n}, (_unused, i) =>
            renderAngle(model, (i * 360) / n + offset, {scale: SCALE, normals})
        )
        const errors = truth.map((frame, deg) => {
            const nearest = Math.round(((deg - offset) * n) / 360 + n) % n
            return silhouetteError(frame.albedo, baked[nearest]?.albedo ?? frame.albedo)
        })
        return errors.reduce((a, b) => a + b, 0) / errors.length
    }
    const aligned = measure(0)
    const offset = measure(360 / 32)
    console.log(
        `${name.padEnd(16)} ${((aligned * 100).toFixed(2) + '%').padStart(11)}`
            + `${((offset * 100).toFixed(2) + '%').padStart(13)}`
            + `${(((offset - aligned) / aligned) * 100).toFixed(1).padStart(8)}%`
    )
}
