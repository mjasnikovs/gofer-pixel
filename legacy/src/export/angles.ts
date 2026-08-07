import {prepareNormals, renderAngle} from '../vox/render'
import type {VoxModel} from '../vox/model'
import type {RgbaImage} from '../image/rgba'

/**
 * How many baked angles this particular model needs.
 *
 * `PRODUCTION_PLAN.md` §8 defaulted to 16 on evidence about pre-rendered sprites. Measured on our
 * own renders (`experiments/t24_angles.ts`) that default is a middle guess rather than a threshold:
 * the error from quantising rotation falls smoothly as roughly 1/N with no knee to point at, and
 * **how much it costs depends on the model**. A near-symmetric blob changes 7 % of its silhouette
 * per step at 16 angles; a truck changes 35 %. One global default cannot be right for both.
 *
 * So the number is measured per model instead. The error reported is the one a player sees: the
 * game faces some heading, the nearest baked angle is shown, and this is the fraction of the true
 * sprite's pixels whose coverage is wrong.
 */
export interface AngleOption {
    angles: number
    /** Mean fraction of pixels with the wrong coverage, over the sampled headings. */
    error: number
    /** The worst heading, which is what a slow turn will park on. */
    worst: number
}

export interface AngleAdvice {
    options: AngleOption[]
    /** The smallest count that meets `maxError`, or the largest tried if none does. */
    suggested: number
    /** How much the silhouette changes between adjacent baked frames at the suggestion. */
    stepChange: number
}

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

export interface AngleAdviceOptions {
    /** Counts to consider. Powers of two, because every packer and shader expects them. */
    choices?: number[]
    /** The error to aim under. 0.08 — under a tenth of the sprite wrong — is the default. */
    maxError?: number
    /**
     * Pixels per voxel while measuring. Small on purpose: silhouette error is about shape, the
     * measurement renders a few hundred angles, and this is meant to be a button, not a bake.
     */
    scale?: number
    /** Headings to test. */
    samples?: number
}

export const angleAdvice = (
    model: VoxModel,
    {choices = [8, 16, 32, 64], maxError = 0.08, scale = 2, samples = 72}: AngleAdviceOptions = {}
): AngleAdvice => {
    const normals = prepareNormals(model)
    const truth = Array.from(
        {length: samples},
        (_unused, i) => renderAngle(model, (i * 360) / samples, {scale, normals}).albedo
    )

    const options = choices.map(angles => {
        const baked = Array.from(
            {length: angles},
            (_unused, i) => renderAngle(model, (i * 360) / angles, {scale, normals}).albedo
        )
        const errors = truth.map((frame, i) => {
            const heading = (i * 360) / samples
            const nearest = Math.round((heading * angles) / 360) % angles
            return silhouetteError(frame, baked[nearest] ?? frame)
        })
        return {
            angles,
            error: errors.reduce((a, b) => a + b, 0) / errors.length,
            worst: Math.max(...errors)
        }
    })

    const suggested =
        options.find(option => option.error <= maxError)?.angles
        ?? options[options.length - 1]?.angles
        ?? 16

    const baked = Array.from(
        {length: suggested},
        (_unused, i) => renderAngle(model, (i * 360) / suggested, {scale, normals}).albedo
    )
    const steps = baked.map((frame, i) =>
        silhouetteError(frame, baked[(i + 1) % suggested] ?? frame)
    )

    return {
        options,
        suggested,
        stepChange: steps.reduce((a, b) => a + b, 0) / steps.length
    }
}

/**
 * Whether the axis-aligned angles render differently enough to matter — measured, they do, and the
 * answer to §14's open question is **bake them anyway**.
 *
 * At 0/90/180/270 the model's faces line up with the pixel grid, so fewer columns are exposed and
 * the sprite is thinner: 3–14 % less coverage than the off-axis frames on the models here. That is
 * a real asymmetry, not the ~45 % striping defect fixed in M0. Offsetting the whole set by half a
 * step to dodge those angles was measured and made the error *worse* on three models of four,
 * because a thin silhouette you never baked is one you can never show.
 */
export const axisAlignedCoverage = (
    model: VoxModel,
    angles = 16,
    scale = 2
): {onAxis: number; offAxis: number; ratio: number} => {
    const normals = prepareNormals(model)
    const covers = Array.from({length: angles}, (_unused, i) => {
        const {albedo} = renderAngle(model, (i * 360) / angles, {scale, normals})
        let n = 0
        for (let at = 3; at < albedo.data.length; at += 4) {
            if ((albedo.data[at] ?? 0) !== 0) {
                n += 1
            }
        }
        return n
    })

    const step = angles / 4
    const onAxisValues = covers.filter((_unused, i) => i % step === 0)
    const offAxisValues = covers.filter((_unused, i) => i % step !== 0)
    const mean = (values: number[]): number =>
        values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
    const onAxis = mean(onAxisValues)
    const offAxis = mean(offAxisValues)
    return {onAxis, offAxis, ratio: offAxis === 0 ? 1 : onAxis / offAxis}
}
