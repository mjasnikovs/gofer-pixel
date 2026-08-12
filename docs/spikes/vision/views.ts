/*
 * Rendering a stimulus for the vision model: which cameras, at what size, composited how.
 *
 * The grey composite is `gen/veto.ts`'s, and for its reason: a sprite is mostly transparent, and
 * transparency reaches a vision tower as whatever the decoder felt like — usually black, which reads
 * as part of the model.
 *
 * The zoom is **not** `defaultZoom`. That frames the whole grid with air around it, so a 32³ document
 * holding a 20-voxel shape spends two thirds of its pixels on nothing — which is exactly the variable
 * a resolution sweep is trying to measure. Here the frame is the *filled* bounds' diagonal, which is
 * tight and still cannot clip at any yaw or pitch.
 */
import {DIMETRIC_PITCH, ISOMETRIC_PITCH} from '../../../src/doc/cameras'
import {encodePng} from '../../../src/image/png'
import {toBase64} from '../../../src/image/base64'
import {basisFor} from '../../../src/render/camera'
import {render} from '../../../src/render/raycast'
import {filledBounds, type Volume} from '../../../src/render/volume'

export interface View {
    readonly label: string
    readonly yaw: number
    readonly pitch: number
}

const turn = (eighth: number): number => (eighth * Math.PI) / 4

/**
 * The named view sets. `flat` pitches are straight-on elevations; the rest are the three-quarter
 * angle the app defaults to.
 *
 * Yaw 0 is Front and `+x` is screen-right there — see `doc/cameras.ts`'s `DIRECTION_NAMES` and
 * `basisFor`. Every label below is that convention and nothing else.
 */
export const VIEW_SETS: Readonly<Record<string, readonly View[]>> = {
    /** One three-quarter view: what `veto.ts` already sends. */
    one: [{label: 'three-quarter from the front-right', yaw: turn(1), pitch: DIMETRIC_PITCH}],
    /** Two elevations, the pair a shape-from-silhouette argument wants. */
    two: [
        {label: 'front', yaw: turn(0), pitch: 0},
        {label: 'right side', yaw: turn(2), pitch: 0}
    ],
    /** Four elevations round the model. */
    four: [
        {label: 'front', yaw: turn(0), pitch: 0},
        {label: 'right side', yaw: turn(2), pitch: 0},
        {label: 'back', yaw: turn(4), pitch: 0},
        {label: 'left side', yaw: turn(6), pitch: 0}
    ],
    /** Four three-quarter views, which is what the app's camera ring gives an artist. */
    fourIso: [
        {label: 'front-right', yaw: turn(1), pitch: DIMETRIC_PITCH},
        {label: 'back-right', yaw: turn(3), pitch: DIMETRIC_PITCH},
        {label: 'back-left', yaw: turn(5), pitch: DIMETRIC_PITCH},
        {label: 'front-left', yaw: turn(7), pitch: DIMETRIC_PITCH}
    ],
    /*
     * The hybrid, and it is the one the measurement asked for rather than a guess.
     *
     * `fourIso` reads pieces and floating best; `six` is the only set that gets the depth axis right,
     * and the only thing it has that the others do not is the view from above. Width against depth is
     * a two-dimensional comparison up there and a foreshortening problem everywhere else.
     */
    fiveIso: [
        {label: 'front-right', yaw: turn(1), pitch: DIMETRIC_PITCH},
        {label: 'back-right', yaw: turn(3), pitch: DIMETRIC_PITCH},
        {label: 'back-left', yaw: turn(5), pitch: DIMETRIC_PITCH},
        {label: 'front-left', yaw: turn(7), pitch: DIMETRIC_PITCH},
        {label: 'from directly above', yaw: turn(0), pitch: Math.PI / 2 - 0.001}
    ],
    /** Four elevations plus above and below. */
    six: [
        {label: 'front', yaw: turn(0), pitch: 0},
        {label: 'right side', yaw: turn(2), pitch: 0},
        {label: 'back', yaw: turn(4), pitch: 0},
        {label: 'left side', yaw: turn(6), pitch: 0},
        {label: 'from above', yaw: turn(0), pitch: Math.PI / 2 - 0.001},
        {label: 'from below', yaw: turn(0), pitch: -Math.PI / 2 + 0.001}
    ]
}

const onGrey = (rgba: Uint8Array): Uint8Array => {
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

/** The filled shape's own diagonal, with a tenth of headroom. Cannot clip at any angle. */
export const frameZoom = (volume: Volume): number => {
    const bounds = filledBounds(volume)
    if (!bounds) return Math.max(1, volume.sz)
    const [x0, y0, z0] = bounds.min
    const [x1, y1, z1] = bounds.max
    return Math.ceil(Math.hypot(x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1) * 1.1)
}

/** One view, as raw RGBA on grey — the shared step behind a PNG and a composite. */
export const pixelsFor = (volume: Volume, view: View, size: number): Uint8Array => {
    const bounds = filledBounds(volume)
    const centre: [number, number, number] =
        bounds ?
            [
                (bounds.min[0] + bounds.max[0] + 1) / 2,
                (bounds.min[1] + bounds.max[1] + 1) / 2,
                (bounds.min[2] + bounds.max[2] + 1) / 2
            ]
        :   [volume.sx / 2, volume.sy / 2, volume.sz / 2]
    /*
     * `basisFor` centres on the grid, not on the model, so a shape sitting on the floor of a 64³ cube
     * would render near the bottom edge. The pan puts the *filled* centre in the middle of the frame,
     * in the camera's own screen axes, which is what makes two sizes of the same shape comparable.
     */
    const camera = {yaw: view.yaw, pitch: view.pitch, zoom: frameZoom(volume), panX: 0, panY: 0}
    const basis = basisFor(camera, volume, size)
    const [rx, ry, rz] = basis.right
    const [ux, uy, uz] = basis.up
    const dx = centre[0] - volume.sx / 2
    const dy = centre[1] - volume.sy / 2
    const dz = centre[2] - volume.sz / 2
    const panned = {
        ...camera,
        panX: dx * rx + dy * ry + dz * rz,
        panY: dx * ux + dy * uy + dz * uz
    }
    return onGrey(render(volume, basisFor(panned, volume, size), size, size).color)
}

export const pngFor = async (volume: Volume, view: View, size: number): Promise<Uint8Array> =>
    encodePng(size, size, pixelsFor(volume, view, size))

export const base64For = async (volume: Volume, view: View, size: number): Promise<string> =>
    toBase64(await pngFor(volume, view, size))

/**
 * Several views side by side in one image, on the same grey.
 *
 * The alternative to sending them as separate images, and the thing 3DCodeBench's "smaller models
 * saturate or degrade beyond 1–2 views" caution is actually about. A strip is one image to the
 * tower; four images are four.
 */
export const stripFor = async (
    volume: Volume,
    views: readonly View[],
    size: number
): Promise<Uint8Array> => {
    const columns = views.length <= 2 ? views.length : Math.ceil(views.length / 2)
    const rows = Math.ceil(views.length / columns)
    const width = columns * size
    const height = rows * size
    const out = new Uint8Array(width * height * 4)
    for (let i = 0; i < out.length; i += 4) {
        out[i] = 128
        out[i + 1] = 128
        out[i + 2] = 128
        out[i + 3] = 255
    }
    views.forEach((view, i) => {
        const tile = pixelsFor(volume, view, size)
        const ox = (i % columns) * size
        const oy = Math.floor(i / columns) * size
        for (let y = 0; y < size; y += 1) {
            const from = y * size * 4
            const to = ((oy + y) * width + ox) * 4
            out.set(tile.subarray(from, from + size * 4), to)
        }
    })
    return encodePng(width, height, out)
}

export {DIMETRIC_PITCH, ISOMETRIC_PITCH}
