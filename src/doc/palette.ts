import type {Rgba} from '../vox/palette'
import {addRamp, documentVolumes, type Document, type Ramp} from './document'
import {Volume} from './volume'

/**
 * Palette work, and it is not a side feature: a sprite stack reads as a solid blob unless
 * consecutive slices differ in value, so the palette is where legibility is won or lost.
 *
 * Everything that reorders or removes a colour reindexes the voxels in the same operation.
 * A palette edit that leaves the volumes pointing at the old indices is silent corruption, and
 * it is the obvious way to get this wrong.
 */

const srgbToLinear = (channel: number): number => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/**
 * CIE L\*, 0–100. Perceptual lightness, not the `0.299r + 0.587g + 0.114b` shortcut — the whole
 * point of the contrast checks below is that they match what an eye sees.
 */
export const lightness = ({r, g, b}: Rgba): number => {
    const y = 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
    return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y
}

/** Hue in degrees, saturation and value 0–1. */
export const toHsv = ({r, g, b}: Rgba): {h: number; s: number; v: number} => {
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const span = max - min
    let h = 0
    if (span !== 0) {
        if (max === r) {
            h = ((g - b) / span) % 6
        } else if (max === g) {
            h = (b - r) / span + 2
        } else {
            h = (r - g) / span + 4
        }
        h *= 60
    }
    return {h: h < 0 ? h + 360 : h, s: max === 0 ? 0 : span / max, v: max / 255}
}

export const fromHsv = (h: number, s: number, v: number, a = 255): Rgba => {
    const c = v * s
    const x = c * (1 - Math.abs(((((h % 360) + 360) / 60) % 2) - 1))
    const m = v - c
    const sector = Math.floor((((h % 360) + 360) % 360) / 60)
    const table: [number, number, number][] = [
        [c, x, 0],
        [x, c, 0],
        [0, c, x],
        [0, x, c],
        [x, 0, c],
        [c, 0, x]
    ]
    const [rr, gg, bb] = table[sector] ?? [0, 0, 0]
    return {
        r: Math.round((rr + m) * 255),
        g: Math.round((gg + m) * 255),
        b: Math.round((bb + m) * 255),
        a
    }
}

/** Perceptual distance in Lab-ish terms. Good enough to answer "are these two the same colour?". */
export const colorDistance = (a: Rgba, b: Rgba): number => {
    const dl = lightness(a) - lightness(b)
    const dr = (a.r - b.r) / 255
    const dg = (a.g - b.g) / 255
    const db = (a.b - b.b) / 255
    return Math.sqrt(dl * dl + 100 * (dr * dr + dg * dg + db * db))
}

export const gradient = (from: Rgba, to: Rgba, steps: number): Rgba[] =>
    Array.from({length: Math.max(steps, 2)}, (_unused, i) => {
        const t = i / (Math.max(steps, 2) - 1)
        return {
            r: Math.round(from.r + (to.r - from.r) * t),
            g: Math.round(from.g + (to.g - from.g) * t),
            b: Math.round(from.b + (to.b - from.b) * t),
            a: Math.round(from.a + (to.a - from.a) * t)
        }
    })

/** Interpolate the short way round the hue circle, which is what "gradient by hue" means. */
export const gradientByHue = (from: Rgba, to: Rgba, steps: number): Rgba[] => {
    const a = toHsv(from)
    const b = toHsv(to)
    let delta = b.h - a.h
    if (delta > 180) {
        delta -= 360
    }
    if (delta < -180) {
        delta += 360
    }
    const count = Math.max(steps, 2)
    return Array.from({length: count}, (_unused, i) => {
        const t = i / (count - 1)
        return fromHsv(
            a.h + delta * t,
            a.s + (b.s - a.s) * t,
            a.v + (b.v - a.v) * t,
            Math.round(from.a + (to.a - from.a) * t)
        )
    })
}

export type SortKey = 'luminance' | 'hue' | 'saturation'

/**
 * The permutation that sorts the palette, as new index → old index.
 *
 * Index 0 never moves: it is the empty voxel, and a palette whose first entry becomes a real
 * colour would fill every hole in every model.
 */
export const sortOrder = (palette: readonly Rgba[], by: SortKey): number[] => {
    const key = (color: Rgba | undefined): number => {
        if (!color) {
            return Infinity
        }
        if (by === 'luminance') {
            return lightness(color)
        }
        const {h, s} = toHsv(color)
        return by === 'hue' ? h : s
    }
    const rest = palette.map((_unused, i) => i).slice(1)
    rest.sort((a, b) => key(palette[a]) - key(palette[b]))
    return [0, ...rest]
}

/**
 * Apply a permutation of palette entries to the whole document, cels included.
 *
 * `order[new] = old`, matching `sortOrder`. Colour indices in a `.vox` are 1-based, so entry `i`
 * of the palette array is drawn by voxel value `i + 1`; the remap below works in voxel values to
 * keep that off-by-one in exactly one place.
 */
export const applyPaletteOrder = (doc: Document, order: readonly number[]): Document => {
    const remap = new Uint8Array(256)
    order.forEach((oldIndex, newIndex) => {
        remap[oldIndex + 1] = newIndex + 1
    })

    return {
        ...doc,
        palette: order.map(oldIndex => doc.palette[oldIndex] ?? {r: 0, g: 0, b: 0, a: 0}),
        // ramps name palette entries too, and a ramp left pointing at the old numbering would
        // silently start shading with the wrong colours
        ramps: doc.ramps.map(ramp => ({
            ...ramp,
            indices: ramp.indices.map(index => remap[index] ?? index)
        })),
        layers: doc.layers.map(layer => ({
            ...layer,
            cels: layer.cels.map(cel => {
                if (!cel) {
                    return null
                }
                const next = new Volume()
                cel.forEach((x, y, z, color) => {
                    next.set(x, y, z, remap[color] ?? color)
                })
                return next
            })
        }))
    }
}

export const sortPalette = (doc: Document, by: SortKey): Document =>
    applyPaletteOrder(doc, sortOrder(doc.palette, by))

/**
 * Shading mode: given the colour under the cursor, return the one `steps` along whichever ramp
 * contains it — positive towards the light end. A colour on no ramp, or already at the end of
 * one, comes back unchanged, so holding the shade tool at the top of a ramp does nothing rather
 * than wrapping round to the darkest shadow.
 */
export const shadeStep = (ramps: readonly Ramp[], color: number, steps: number): number => {
    for (const ramp of ramps) {
        const at = ramp.indices.indexOf(color)
        if (at !== -1) {
            const target = Math.max(0, Math.min(ramp.indices.length - 1, at + steps))
            return ramp.indices[target] ?? color
        }
    }
    return color
}

/** Build a ramp by appending its colours to the palette. Returns the palette and the ramp. */
export const rampFromGradient = (
    palette: readonly Rgba[],
    name: string,
    from: Rgba,
    to: Rgba,
    steps: number,
    byHue = false
): {palette: Rgba[]; ramp: Ramp} => {
    const colors = byHue ? gradientByHue(from, to, steps) : gradient(from, to, steps)
    const next = [...palette]
    const indices = colors.map(color => {
        next.push(color)
        return next.length // voxel value is the 1-based index
    })
    return {palette: next, ramp: {name, indices}}
}

/**
 * Recolour the entries between two selected swatches so they run as a gradient.
 *
 * Colours change, indices do not, so no voxel is touched — this is the one palette operation that
 * is safe without a reindex, and it is why it is separate from `applyPaletteOrder`.
 * `a` and `b` are voxel values (1-based), as everywhere else in this file.
 */
export const gradientBetween = (doc: Document, a: number, b: number, byHue = false): Document => {
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const from = doc.palette[lo - 1]
    const to = doc.palette[hi - 1]
    if (!from || !to || hi - lo < 2) {
        return doc
    }
    const colors = (byHue ? gradientByHue : gradient)(from, to, hi - lo + 1)
    const palette = [...doc.palette]
    colors.forEach((color, i) => {
        palette[lo - 1 + i] = color
    })
    return {...doc, palette}
}

/**
 * Append a named ramp built by interpolating between two existing swatches.
 *
 * The ramp's colours are new palette entries rather than the range between the two — a ramp is a
 * first-class object here, and stealing the slots in between would silently recolour whatever
 * already used them.
 */
export const addGradientRamp = (
    doc: Document,
    name: string,
    a: number,
    b: number,
    steps: number,
    byHue = false
): Document => {
    const from = doc.palette[a - 1]
    const to = doc.palette[b - 1]
    if (!from || !to) {
        return doc
    }
    const built = rampFromGradient(doc.palette, name, from, to, steps, byHue)
    return addRamp({...doc, palette: built.palette}, built.ramp)
}

/** How many voxels use each palette entry, across every cel of every frame. */
export const colorUsage = (doc: Document): Map<number, number> => {
    const counts = new Map<number, number>()
    for (const volume of documentVolumes(doc)) {
        volume.forEach((_x, _y, _z, color) => {
            counts.set(color, (counts.get(color) ?? 0) + 1)
        })
    }
    return counts
}

/** Swap one palette index for another everywhere in the document. Voxel values, 1-based. */
export const replaceColorEverywhere = (doc: Document, from: number, to: number): Document => {
    if (from === to) {
        return doc
    }
    return {
        ...doc,
        layers: doc.layers.map(layer => ({
            ...layer,
            cels: layer.cels.map(cel => {
                if (!cel) {
                    return null
                }
                const next = new Volume()
                cel.forEach((x, y, z, color) => {
                    next.set(x, y, z, color === from ? to : color)
                })
                return next
            })
        }))
    }
}

/**
 * Point every voxel using a duplicate colour at the first entry with that colour.
 *
 * The palette keeps its length — shortening it would renumber everything downstream for no gain,
 * and an unused slot is free.
 */
export const mergeDuplicates = (doc: Document, tolerance = 0): Document => {
    const canonical = new Map<number, number>()
    for (let i = 0; i < doc.palette.length; i += 1) {
        const color = doc.palette[i]
        if (!color) {
            continue
        }
        for (let j = 0; j < i; j += 1) {
            const earlier = doc.palette[j]
            if (earlier && colorDistance(color, earlier) <= tolerance) {
                canonical.set(i + 1, j + 1)
                break
            }
        }
    }

    let out = doc
    for (const [from, to] of canonical) {
        out = replaceColorEverywhere(out, from, to)
    }
    return out
}

/**
 * Two cheap checks that catch real problems, per `PRODUCTION_PLAN.md` §7.
 *
 * **The defaults are calibrated** (`experiments/t23_contrast.ts`, 2026-08-07), against a stated
 * criterion rather than taste: a seam is visible when the rendered 8-bit step across it is ≥2
 * levels and comfortable at ≥5. Measured against the renderer's own output, a palette ΔL\* of 1.0
 * reaches 2 levels and 2.0 reaches 5, near enough independently of base lightness — so the
 * thresholds below are 2 L\* and a colour distance of 1, not the 3 and 4 that were guessed.
 *
 * Two things the measurement exposed, both worth knowing before trusting a report:
 *
 * - `flatSlicePairs` compares **mean lightness only**. Two slices at the same L\* in different
 *   hues render 51–77 levels apart and are perfectly legible, and this will still call them flat.
 * - In a **lit** render a slice boundary shows a 52-level step even when the two slices are the
 *   same colour, because Lambert shades a top face differently from a side. The blob these checks
 *   are looking for is an unlit, flat-read problem.
 */
export interface PaletteCollision {
    a: number
    b: number
    distance: number
}

export const closeColors = (palette: readonly Rgba[], threshold = 1): PaletteCollision[] => {
    const out: PaletteCollision[] = []
    for (let i = 0; i < palette.length; i += 1) {
        const a = palette[i]
        if (!a || a.a === 0) {
            continue
        }
        for (let j = i + 1; j < palette.length; j += 1) {
            const b = palette[j]
            if (!b || b.a === 0) {
                continue
            }
            const distance = colorDistance(a, b)
            if (distance <= threshold) {
                out.push({a: i + 1, b: j + 1, distance})
            }
        }
    }
    return out
}

export interface FlatSlicePair {
    lower: number
    upper: number
    deltaL: number
}

/**
 * Adjacent slices whose mean lightness is too close to read as separate layers in the stack.
 * Empty slices are skipped rather than compared against, so a gap does not report as flat.
 */
export const flatSlicePairs = (doc: Document, frame: number, minDeltaL = 2): FlatSlicePair[] => {
    const means: (number | null)[] = Array.from({length: doc.size.sz}, () => null)
    const totals = new Float64Array(doc.size.sz)
    const counts = new Uint32Array(doc.size.sz)

    for (const layer of doc.layers) {
        if (!layer.visible) {
            continue
        }
        layer.cels[frame]?.forEach((_x, _y, z, color) => {
            const at = z + layer.offset.z
            const rgba = doc.palette[color - 1]
            if (at >= 0 && at < doc.size.sz && rgba && rgba.a !== 0) {
                totals[at] = (totals[at] ?? 0) + lightness(rgba)
                counts[at] = (counts[at] ?? 0) + 1
            }
        })
    }
    for (let z = 0; z < doc.size.sz; z += 1) {
        const n = counts[z] ?? 0
        means[z] = n === 0 ? null : (totals[z] ?? 0) / n
    }

    const out: FlatSlicePair[] = []
    let previous: {z: number; mean: number} | null = null
    for (let z = 0; z < doc.size.sz; z += 1) {
        const mean = means[z]
        if (mean === null || mean === undefined) {
            continue
        }
        if (previous && Math.abs(mean - previous.mean) < minDeltaL) {
            out.push({lower: previous.z, upper: z, deltaL: Math.abs(mean - previous.mean)})
        }
        previous = {z, mean}
    }
    return out
}
