import {createImage, type RgbaImage} from '../image/rgba'
import type {Rgba} from '../vox/palette'
import {light, type RenderedAngle} from '../vox/render'

/**
 * Preview render effects as a pass pipeline over RGBA, per `PRODUCTION_PLAN.md` §8.
 *
 * All of it is CPU work at sprite sizes, which is the point: these run in a Worker, in Bun and in
 * CI identically, and `light()` — the Lambert pass over the exact normal map — was already one of
 * them. A pass takes an image and gives back a new one; nothing mutates its input, so a pipeline
 * is just a fold.
 */
export type Pass = (image: RgbaImage, sheet?: RenderedAngle) => RgbaImage

const clone = ({width, height, data}: RgbaImage): RgbaImage => ({
    width,
    height,
    data: new Uint8Array(data)
})

const alphaAt = ({width, height, data}: RgbaImage, x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : (data[(y * width + x) * 4 + 3] ?? 0)

/**
 * A one-pixel border around the opaque area.
 *
 * Outside by default, which grows the silhouette by a pixel — an outline drawn *inside* eats the
 * artwork at sprite sizes, and at 16×16 that is a tenth of the model.
 */
export const outline = (
    color: Rgba,
    {inside = false, diagonal = false}: {inside?: boolean; diagonal?: boolean} = {}
): Pass => {
    const offsets: [number, number][] =
        diagonal ?
            [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1],
                [1, 1],
                [1, -1],
                [-1, 1],
                [-1, -1]
            ]
        :   [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1]
            ]

    return image => {
        const out = clone(image)
        for (let y = 0; y < image.height; y += 1) {
            for (let x = 0; x < image.width; x += 1) {
                const here = alphaAt(image, x, y)
                const wanted = inside ? here !== 0 : here === 0
                if (!wanted) {
                    continue
                }
                const touching = offsets.some(([dx, dy]) =>
                    inside ?
                        alphaAt(image, x + dx, y + dy) === 0
                    :   alphaAt(image, x + dx, y + dy) !== 0
                )
                if (touching) {
                    out.data.set([color.r, color.g, color.b, color.a], (y * image.width + x) * 4)
                }
            }
        }
        return out
    }
}

const BAYER_4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5]
]

/**
 * Ordered dithering: modulate brightness on a 4×4 Bayer matrix.
 *
 * Brightness rather than a two-colour threshold, because the palette is the artist's and a pass
 * that invents colours would put off-palette pixels in the render. `strength` 0 is a no-op, 1 is
 * the full ±50 % swing.
 */
export const dither =
    (strength = 0.25): Pass =>
    image => {
        const out = clone(image)
        for (let y = 0; y < image.height; y += 1) {
            for (let x = 0; x < image.width; x += 1) {
                const at = (y * image.width + x) * 4
                if ((image.data[at + 3] ?? 0) === 0) {
                    continue
                }
                const threshold = ((BAYER_4[y % 4] ?? [])[x % 4] ?? 0) / 15 - 0.5
                const factor = 1 + threshold * strength
                for (let channel = 0; channel < 3; channel += 1) {
                    out.data[at + channel] = Math.max(
                        0,
                        Math.min(255, Math.round((image.data[at + channel] ?? 0) * factor))
                    )
                }
            }
        }
        return out
    }

/**
 * Palette cycling: rotate a set of colours through each other, the oldest animation trick there
 * is. Matching is exact RGB — these are flat palette colours, not photographs.
 */
export const paletteCycle = (ramp: readonly Rgba[], steps = 1): Pass => {
    const key = ({r, g, b}: Rgba): number => (r << 16) | (g << 8) | b
    const lookup = new Map<number, Rgba>()
    ramp.forEach((color, i) => {
        const target = ramp[(((i + steps) % ramp.length) + ramp.length) % ramp.length]
        if (target) {
            lookup.set(key(color), target)
        }
    })

    return image => {
        const out = clone(image)
        for (let at = 0; at < image.data.length; at += 4) {
            if ((image.data[at + 3] ?? 0) === 0) {
                continue
            }
            const replacement = lookup.get(
                ((image.data[at] ?? 0) << 16)
                    | ((image.data[at + 1] ?? 0) << 8)
                    | (image.data[at + 2] ?? 0)
            )
            if (replacement) {
                out.data.set([replacement.r, replacement.g, replacement.b], at)
            }
        }
        return out
    }
}

/**
 * Occlusion from the normal map: darken a pixel in proportion to how much its neighbours' normals
 * turn away from it, which is what a concave corner looks like.
 *
 * This is a screen-space approximation and is named for what it does rather than called ambient
 * occlusion, which would imply the volume integral it is not. It needs the normal sheet, so it is
 * the one pass that uses the second argument.
 */
export const normalOcclusion = (strength = 0.45): Pass => {
    return (image, sheet) => {
        const normal = sheet?.normal
        if (!normal) {
            return clone(image)
        }
        const out = clone(image)
        const read = (x: number, y: number): [number, number, number] | null => {
            if (x < 0 || y < 0 || x >= normal.width || y >= normal.height) {
                return null
            }
            const at = (y * normal.width + x) * 4
            if ((image.data[at + 3] ?? 0) === 0) {
                return null
            }
            return [
                (normal.data[at] ?? 0) / 127.5 - 1,
                (normal.data[at + 1] ?? 0) / 127.5 - 1,
                (normal.data[at + 2] ?? 0) / 127.5 - 1
            ]
        }

        for (let y = 0; y < image.height; y += 1) {
            for (let x = 0; x < image.width; x += 1) {
                const at = (y * image.width + x) * 4
                const here = read(x, y)
                if (!here) {
                    continue
                }
                let divergence = 0
                let samples = 0
                for (const [dx, dy] of [
                    [1, 0],
                    [-1, 0],
                    [0, 1],
                    [0, -1]
                ]) {
                    const other = read(x + (dx ?? 0), y + (dy ?? 0))
                    if (!other) {
                        continue
                    }
                    const dot = here[0] * other[0] + here[1] * other[1] + here[2] * other[2]
                    divergence += Math.max(0, 1 - dot) / 2
                    samples += 1
                }
                if (samples === 0) {
                    continue
                }
                const factor = 1 - (divergence / samples) * strength
                for (let channel = 0; channel < 3; channel += 1) {
                    out.data[at + channel] = Math.max(
                        0,
                        Math.min(255, Math.round((image.data[at + channel] ?? 0) * factor))
                    )
                }
            }
        }
        return out
    }
}

/** The Lambert pass, as a pipeline stage. Reuses the renderer's own lighting, not a copy of it. */
export const lambert =
    (options?: Parameters<typeof light>[1]): Pass =>
    (image, sheet) =>
        sheet ? light({albedo: image, normal: sheet.normal}, options) : clone(image)

/** Run a pipeline. An empty pipeline still copies, so a caller can never alias the input. */
export const applyPasses = (
    image: RgbaImage,
    passes: readonly Pass[],
    sheet?: RenderedAngle
): RgbaImage => passes.reduce((current, pass) => pass(current, sheet), clone(image))

/** A blank image of the same shape, for tests and for a pass that needs a scratch buffer. */
export const emptyLike = ({width, height}: RgbaImage): RgbaImage => createImage(width, height)
