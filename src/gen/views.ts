import {ISOMETRIC_PITCH} from '../doc/cameras'
import {encodePng} from '../image/png'
import {basisFor, createCamera} from '../render/camera'
import {render} from '../render/raycast'
import type {Volume} from '../render/volume'
import {toBase64} from '../image/base64'

/**
 * The pictures a candidate is judged on.
 *
 * Four yaws a quarter-turn apart at the isometric pitch, because a single unlucky view sinks a good
 * asset — a tower seen from directly in front is a rectangle whatever is carved into its sides.
 *
 * They are the *renderer's own* pictures. Legacy scored candidates by shipping the op list to Python
 * and rasterising and rendering it a second time there, which meant two rasterisers and two
 * renderers that had to agree byte for byte or the score was of something the artist never saw.
 * The CPU raycaster is the oracle for everything else this app exports, and it is the oracle here.
 */
export const VIEW_YAWS = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4] as const

/**
 * 64 px, which is `DEFAULT_OUTPUT.cell` and the size these were validated at.
 *
 * CLIP resizes whatever it is given to 224 × 224, so a larger render buys nothing but time — and
 * time here is 4 renders × N candidates in the page while the artist waits.
 */
export const VIEW_SIZE = 64

/**
 * Composited onto CLIP's neutral grey.
 *
 * A sprite is mostly transparent, and transparency reaches CLIP as whatever the decoder felt like —
 * usually black, which reads as part of the model and darkens every score. Grey is what the legacy
 * scorer used and what the ranking was validated on.
 */
export const onGrey = (rgba: Uint8Array): Uint8Array => {
    const out = new Uint8Array(rgba.length)
    for (let i = 0; i < rgba.length; i += 4) {
        const alpha = (rgba[i + 3] ?? 0) / 255
        out[i] = Math.round((rgba[i] ?? 0) * alpha + 128 * (1 - alpha))
        out[i + 1] = Math.round((rgba[i + 1] ?? 0) * alpha + 128 * (1 - alpha))
        out[i + 2] = Math.round((rgba[i + 2] ?? 0) * alpha + 128 * (1 - alpha))
        out[i + 3] = 255
    }
    return out
}

/** One candidate's four views, as base64 PNGs — what the scoring service is handed. */
export const rankingViews = async (
    volume: Volume,
    size: number = VIEW_SIZE
): Promise<readonly string[]> => {
    const views: string[] = []
    for (const yaw of VIEW_YAWS) {
        const basis = basisFor(createCamera(volume, yaw, ISOMETRIC_PITCH), volume, size)
        const target = render(volume, basis, size, size)
        views.push(toBase64(await encodePng(size, size, onGrey(target.color))))
    }
    return views
}
