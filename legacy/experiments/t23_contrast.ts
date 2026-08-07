/**
 * TEST 23: what should the palette contrast thresholds actually be?
 *
 * `PRODUCTION_PLAN.md` §7 says a stack reads as a solid blob unless consecutive slices differ in
 * value, and §14 admits both numbers behind that check were invented — "a few L\*" and "closer than
 * a threshold". This replaces them with numbers derived from a stated criterion.
 *
 * The criterion, stated so it can be argued with: **a seam between two slices is visible when the
 * rendered 8-bit step across it is at least 2 levels, and comfortable at 5.** Those are display
 * facts, not taste — 1 level is the smallest step sRGB can represent, and a 1-level edge on a flat
 * field is at or below what a typical screen and viewer resolve. Everything else here is measured.
 *
 * Measure the **albedo**, not the lit render. The first run of this made that mistake and the
 * answer came back nonsense: identical colours already showed a 52-level seam, because Lambert
 * shades the top face of one slice differently from the side of the next. That is a real and useful
 * effect — with lighting on, a slice boundary carries a normal cue whatever the colours do — but it
 * is not what the palette check is about, and it swamps the signal being looked for.
 *
 *   bun experiments/t23_contrast.ts
 */
import {light, renderAngle} from '../src/vox/render'
import {colorDistance, lightness} from '../src/doc/palette'
import {DEFAULT_PALETTE, packKey, type VoxModel} from '../src/vox/model'
import type {Rgba} from '../src/vox/palette'

/** A grey with a given L\*, found by search — the inverse of `lightness` has no closed form here. */
const greyAt = (target: number): Rgba => {
    let lo = 0
    let hi = 255
    for (let i = 0; i < 24; i += 1) {
        const mid = (lo + hi) / 2
        if (lightness({r: mid, g: mid, b: mid, a: 255}) < target) {
            lo = mid
        } else {
            hi = mid
        }
    }
    const value = Math.round((lo + hi) / 2)
    return {r: value, g: value, b: value, a: 255}
}

/** A two-slice column: the lower slice colour 1, the upper colour 2. */
const column = (lower: Rgba, upper: Rgba): VoxModel => {
    const voxels = new Map<number, number>()
    for (let z = 0; z < 2; z += 1) {
        for (let y = 0; y < 6; y += 1) {
            for (let x = 0; x < 6; x += 1) {
                voxels.set(packKey(x, y, z), z === 0 ? 1 : 2)
            }
        }
    }
    return {sx: 6, sy: 6, sz: 2, voxels, palette: [lower, upper, ...DEFAULT_PALETTE.slice(2)]}
}

/**
 * The largest vertical 8-bit step anywhere inside the rendered stack — which, for a flat column of
 * two colours, is the seam between the slices.
 */
const seamStep = (model: VoxModel, scale: number, lit: boolean): number => {
    const sheet = renderAngle(model, 30, {scale})
    const image = lit ? light(sheet) : sheet.albedo
    let worst = 0
    for (let y = 1; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
            const a = (y * image.width + x) * 4
            const b = ((y - 1) * image.width + x) * 4
            if ((image.data[a + 3] ?? 0) === 0 || (image.data[b + 3] ?? 0) === 0) {
                continue
            }
            const step = Math.max(
                Math.abs((image.data[a] ?? 0) - (image.data[b] ?? 0)),
                Math.abs((image.data[a + 1] ?? 0) - (image.data[b + 1] ?? 0)),
                Math.abs((image.data[a + 2] ?? 0) - (image.data[b + 2] ?? 0))
            )
            worst = Math.max(worst, step)
        }
    }
    return worst
}

console.log('=== how a palette ΔL* arrives in the render (mid grey, L* 50 base)')
console.log('deltaL  rendered step (albedo)  rendered step (lit)  colorDistance')
const base = greyAt(50)
let firstVisible: number | null = null
let firstComfortable: number | null = null
for (const deltaL of [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20]) {
    const upper = greyAt(50 + deltaL)
    const model = column(base, upper)
    const albedo = seamStep(model, 4, false)
    const lit = seamStep(model, 4, true)
    const distance = colorDistance(base, upper)
    console.log(
        `${deltaL.toFixed(1).padStart(5)}   ${String(albedo).padStart(20)}`
            + `   ${String(lit).padStart(18)}   ${distance.toFixed(2).padStart(12)}`
    )
    if (firstVisible === null && albedo >= 2) {
        firstVisible = deltaL
    }
    if (firstComfortable === null && albedo >= 5) {
        firstComfortable = deltaL
    }
}
console.log(`\nfirst ΔL* with a visible (≥2 level) seam:      ${String(firstVisible)}`)
console.log(`first ΔL* with a comfortable (≥5 level) seam: ${String(firstComfortable)}`)

console.log('\n=== does the base lightness change the answer?')
for (const at of [15, 30, 50, 70, 85]) {
    const found: number[] = []
    for (const deltaL of [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8]) {
        const step = seamStep(column(greyAt(at), greyAt(at + deltaL)), 4, false)
        if (step >= 2 && found.length === 0) {
            found.push(deltaL)
        }
        if (step >= 5 && found.length === 1) {
            found.push(deltaL)
        }
    }
    console.log(
        `  base L* ${String(at).padStart(2)}: visible at ΔL* ${String(found[0] ?? '>8')},`
            + ` comfortable at ΔL* ${String(found[1] ?? '>8')}`
    )
}

console.log('\n=== what colorDistance means, for the close-colours check')
console.log('two greys, colorDistance vs the largest channel gap and the rendered step')
for (const deltaL of [0.5, 1, 2, 3, 4, 5, 6, 8, 10]) {
    const a = greyAt(50)
    const b = greyAt(50 + deltaL)
    console.log(
        `  ΔL* ${deltaL.toFixed(1).padStart(4)}  distance ${colorDistance(a, b).toFixed(2).padStart(6)}`
            + `  channel gap ${String(Math.abs(a.r - b.r)).padStart(3)}`
            + `  rendered step ${String(seamStep(column(a, b), 4, false)).padStart(3)}`
    )
}

console.log('\n=== the lighting cue, measured separately: identical colours, lit render')
console.log(
    `  two slices of the same colour, albedo seam ${String(seamStep(column(base, base), 4, false))}`
        + ` levels, lit seam ${String(seamStep(column(base, base), 4, true))} levels`
)

console.log('\n=== hue-only pairs: same L*, different hue')
const hues: [string, Rgba][] = [
    ['red   ', {r: 178, g: 60, b: 60, a: 255}],
    ['green ', {r: 96, g: 140, b: 78, a: 255}],
    ['blue  ', {r: 74, g: 120, b: 190, a: 255}]
]
for (const [name, colour] of hues) {
    const grey = greyAt(lightness(colour))
    console.log(
        `  ${name} vs equal-L* grey: ΔL* ${(lightness(colour) - lightness(grey)).toFixed(2)}`
            + `  distance ${colorDistance(colour, grey).toFixed(2)}`
            + `  rendered step ${String(seamStep(column(grey, colour), 4, false))}`
    )
}
