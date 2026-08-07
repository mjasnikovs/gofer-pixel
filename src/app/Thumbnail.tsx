import {useMemo} from 'react'
import type {Basis, Camera} from '../render/camera'
import {basisFor} from '../render/camera'
import {render, type RenderTarget} from '../render/raycast'
import {
    MODE_AO,
    MODE_COLOR,
    MODE_DEPTH_VIEW,
    MODE_EMISSION,
    MODE_NORMAL
} from '../render/raycast.glsl'
import {volumeDiagonal, type Volume} from '../render/volume'
import {PixelCanvas, type Pixels} from './PixelCanvas'

/**
 * The depth buffer as something you can look at, stretched across the volume's own diagonal.
 *
 * The exported depth map runs over `depthRange`, which is twice the sum of the volume's sides, and
 * the model occupies a sliver of it — shown raw it is one flat grey. The shader's `MODE_DEPTH_VIEW`
 * does the same stretch for the viewport, and the numbers here are its numbers, so the panel and
 * the viewport show the same picture. Neither is what gets exported; the exporter writes the raw
 * 16-bit buffer.
 */
const depthPixels = (target: RenderTarget, basis: Basis, volume: Volume): Uint8Array => {
    const {depth, id} = target
    const spread = volumeDiagonal(volume)
    const near = basis.dist - spread * 0.5
    const out = new Uint8Array(depth.length * 4)
    for (let i = 0; i < depth.length; i += 1) {
        if (id[i] === 0) continue
        const t = ((depth[i] ?? 0) / 65535) * basis.depthRange
        const grey = Math.round(255 * (1 - Math.min(1, Math.max(0, (t - near) / spread))))
        out.set([grey, grey, grey, 255], i * 4)
    }
    return out
}

/** One byte per pixel to RGBA grey, transparent where the ray missed. */
const greyPixels = (values: Uint8Array, id: Uint8Array): Uint8Array => {
    const pixels = new Uint8Array(values.length * 4)
    for (let i = 0; i < values.length; i += 1) {
        if ((id[i] ?? 0) === 0) continue
        const shade = values[i] ?? 0
        pixels[i * 4] = shade
        pixels[i * 4 + 1] = shade
        pixels[i * 4 + 2] = shade
        pixels[i * 4 + 3] = 255
    }
    return pixels
}

/**
 * A sprite is a pure function of a volume, a camera, a size and a map, so it is cached as one.
 *
 * `useMemo` alone is not enough here: the window draws the same eight cameras twice, at two sizes,
 * and every camera again in the export grid, so a single state change can ask for the same pixels
 * from three components that each hold their own memo. The cache is keyed by the camera's *values*
 * rather than its identity, because `eightDirections` builds fresh objects every time it runs.
 *
 * Held in a `WeakMap` on the volume, so a document that is closed takes its sprites with it.
 */
const sprites = new WeakMap<Volume, Map<string, Pixels>>()

const spriteFor = (volume: Volume, camera: Camera, size: number, map: number): Pixels => {
    let cache = sprites.get(volume)
    if (!cache) {
        cache = new Map()
        sprites.set(volume, cache)
    }
    const {yaw, pitch, zoom, panX, panY} = camera
    const key = [yaw, pitch, zoom, panX, panY, size, map].join(',')
    const hit = cache.get(key)
    if (hit) return hit

    const basis = basisFor(camera, volume, size)
    const target = render(volume, basis, size, size)
    const pixels =
        map === MODE_NORMAL ? target.normal
        : map === MODE_DEPTH_VIEW ? depthPixels(target, basis, volume)
        : map === MODE_AO ? greyPixels(target.ao, target.id)
        : map === MODE_EMISSION ? target.emission
        : target.color
    // Cached as the closure, not the buffer, so the prop keeps its identity for as long as the
    // pixels do — see `Pixels`.
    const sprite: Pixels = () => pixels
    cache.set(key, sprite)
    return sprite
}

/**
 * One camera, rendered on the CPU — the same code that writes the exported sheet.
 *
 * Every preview in the window comes through here: the camera grid, the views strip, the render
 * panel and the export grid. That is the point. What the artist picks from is what they get, rather
 * than a preview drawn by a second renderer that agrees with the first only most of the time.
 */
export const Thumbnail = ({
    volume,
    camera,
    size = 72,
    map,
    className = 'thumbnail'
}: {
    volume: Volume
    camera: Camera
    size?: number
    /** One of the shader's view modes. Defaults to colour. */
    map?: number
    className?: string
}) => {
    const pixels = useMemo(
        () => spriteFor(volume, camera, size, map ?? MODE_COLOR),
        [volume, camera, size, map]
    )

    return (
        <PixelCanvas
            width={size}
            height={size}
            data={pixels}
            className={className}
        />
    )
}
