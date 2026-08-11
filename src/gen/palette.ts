import {projectPalette} from '../doc/palette'
import {createVolume, type Volume} from '../render/volume'

/**
 * Holding a generated model to the project's own colours.
 *
 * The model invents hex. It is asked for "4-8 distinct colors with real value contrast" and it
 * answers with whatever six shades of brown it likes, and then `finish` multiplies each of those by
 * 1.16 and 0.72 and invents two more. So a candidate arrives carrying up to twenty-four colours
 * nobody chose, and dropping one into a project means the artist's palette grows a second, slightly
 * different brown every time they generate.
 *
 * The fix is not a prompt. Colour is the one part of the reply that the worked examples teach
 * hardest — every one of them is a program full of literal hex — so a rule in prose asking for a
 * fixed list is asking the model to ignore its own examples, which is the thing finding 7 says it
 * will not do. It is snapped in code instead, after the shading, so that the guarantee holds
 * whatever the model wrote.
 *
 * **The generated model adopts the project's palette wholesale, indices and all.** Not a compacted
 * copy of the colours it happened to land on: the artist's palette is the thing being enforced, so
 * the document that comes out the other side has to *be* that palette, with the model painted in it.
 * Anything else and enforcing the palette would still lose the half of it the candidate did not use.
 */
export interface Swatches {
    /** 256 RGBA entries, adopted whole. */
    readonly palette: Uint8Array
    /** The emission byte per entry, which travels with the colour — see the note in `snapTo`. */
    readonly emissive: Uint8Array
    /** The indices a generated voxel is allowed to land on. */
    readonly slots: readonly number[]
}

/**
 * The colours of an open document, as the set a candidate may paint from.
 *
 * `projectPalette` is the same derivation the swatch grid draws, at its full length rather than the
 * 56 that fit on screen: the colours the model uses, then the colours somebody chose, and never the
 * format's filler. So "the palette" means exactly what the artist is looking at in the left-hand
 * column, which is the only reading of the switch that is not a surprise.
 */
export const swatchesOf = (volume: Volume): Swatches => ({
    palette: Uint8Array.from(volume.palette),
    emissive: Uint8Array.from(volume.emissive),
    slots: projectPalette(volume, 255).map(swatch => swatch.index)
})

/** sRGB byte to linear, the same transfer function `theme/design-rules.ts` uses on hex. */
const linear = (value: number): number => {
    const scaled = value / 255
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

type Lab = readonly [number, number, number]

/**
 * Oklab, because the distances being compared are mostly *lightness* distances.
 *
 * What is snapped is a shade ramp — `finish` hands over a lit tone, a base and a crevice tone of the
 * same hue — and the nearest colour in plain RGB to a darkened brown is frequently a dark blue,
 * since RGB puts every dark colour in the same corner of the cube. Oklab is uniform enough that
 * "darker version of this" lands on the palette's own ramp when it has one, which is what makes
 * DB32 a good palette to be snapped to rather than a bad one.
 */
const oklab = (red: number, green: number, blue: number): Lab => {
    const r = linear(red)
    const g = linear(green)
    const b = linear(blue)
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    ]
}

const labAt = (palette: Uint8Array, index: number): Lab =>
    oklab(palette[index * 4] ?? 0, palette[index * 4 + 1] ?? 0, palette[index * 4 + 2] ?? 0)

const apart = (one: Lab, other: Lab): number =>
    (one[0] - other[0]) ** 2 + (one[1] - other[1]) ** 2 + (one[2] - other[2]) ** 2

/**
 * The same model, painted in the project's palette.
 *
 * Only the entries the model actually carries are matched, which is four to twenty-four of them
 * against thirty-odd swatches — a few hundred comparisons per candidate, not a pass over the grid's
 * colours. The grid itself is walked once to remap.
 *
 * Two entries that snap to the same swatch become one colour, and that is the honest outcome: a
 * palette with no ramp under a colour cannot express three tones of it, so the shading flattens
 * there rather than being faked with a fourth colour the palette does not have.
 *
 * Emission travels with the palette rather than with the model. A generated voxel has no glow of its
 * own — nothing in `src/gen/` ever sets one — so landing on a swatch the artist marked emissive
 * means the model glows where the palette says it glows, which is the whole point of adopting it.
 */
export const snapTo = (made: Volume, swatches: Swatches): Volume => {
    const {slots} = swatches
    // No palette to snap to is not an error and must not be a black model: the candidate stands.
    if (slots.length === 0) return made

    const targets = slots.map(index => ({index, lab: labAt(swatches.palette, index)}))
    const nearest = (lab: Lab): number => {
        let best = targets[0]?.index ?? 1
        let closest = Infinity
        for (const target of targets) {
            const distance = apart(lab, target.lab)
            if (distance < closest) {
                closest = distance
                best = target.index
            }
        }
        return best
    }

    // 0 stays 0. Every other entry is resolved on first sight, so an unused entry costs nothing.
    const map = new Uint8Array(256)
    const out = createVolume(made.sx, made.sy, made.sz, Uint8Array.from(swatches.palette))
    out.emissive.set(swatches.emissive)
    out.owner.set(made.owner)
    for (let i = 0; i < made.data.length; i += 1) {
        const value = made.data[i] ?? 0
        if (value === 0) continue
        if (map[value] === 0) map[value] = nearest(labAt(made.palette, value))
        out.data[i] = map[value] ?? 0
    }
    return out
}
