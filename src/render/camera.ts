import type {Volume} from './volume'
import {volumeDiagonal} from './volume'

export type Vec3 = readonly [number, number, number]

/**
 * A camera is an orthographic transform and nothing else. `zoom` is how many voxels tall the view
 * is, so it means the same thing at every output resolution — a 32-voxel zoom fills a 64 px sprite
 * exactly as it fills a 512 px viewport.
 */
export interface Camera {
    readonly yaw: number
    readonly pitch: number
    readonly zoom: number
    /** Screen-space offset of the centre of view, in voxels along `right` and `up`. */
    readonly panX: number
    readonly panY: number
}

/**
 * The camera resolved against a volume and an output size — exactly the numbers both backends
 * consume, and on the GPU exactly the uniforms that get uploaded.
 */
export interface Basis {
    readonly forward: Vec3
    readonly right: Vec3
    readonly up: Vec3
    readonly center: Vec3
    /** Voxels per output pixel. */
    readonly scale: number
    /** How far back the ray origin sits from `center` — far enough to start outside the volume. */
    readonly dist: number
    /** `t` is written to the depth map as `t / depthRange`, clamped to 0…1. */
    readonly depthRange: number
}

/**
 * Snap, then narrow to float32.
 *
 * Both halves are part of the renderer's contract, not a test concession. `cos(π/2)` is `6.1e-17`
 * in float64 and a different tiny number in float32, so a camera the user calls "axis-aligned" is
 * not axis-aligned to either backend and `1 / dir` blows up differently on each — that is worth a
 * fifth of the model at 0/90/180/270°, silently. Snapping makes the zero exact; `Math.fround` makes
 * the CPU start from the same bits the GPU is handed as a uniform.
 *
 * See `docs/techstack.md` §2, and `raycast.test.ts` for the property that holds it in place.
 */
export const snap = (value: number): number => Math.fround(Math.abs(value) < 1e-6 ? 0 : value)

const snap3 = (x: number, y: number, z: number): Vec3 => [snap(x), snap(y), snap(z)]

/** How much of the volume a camera shows when it has not been zoomed: the whole of it, with air. */
export const defaultZoom = (volume: Volume): number => Math.ceil(volumeDiagonal(volume) * 1.1)

export const createCamera = (volume: Volume, yaw: number, pitch: number): Camera => ({
    yaw,
    pitch,
    zoom: defaultZoom(volume),
    panX: 0,
    panY: 0
})

export const basisFor = (camera: Camera, volume: Volume, height: number): Basis => {
    const {yaw, pitch, zoom, panX, panY} = camera
    const cy = Math.cos(yaw)
    const sy = Math.sin(yaw)
    const cp = Math.cos(pitch)
    const sp = Math.sin(pitch)

    const forward = snap3(-sy * cp, -cy * cp, -sp)
    const right = snap3(cy, -sy, 0)
    const up = snap3(-sy * sp, -cy * sp, cp)

    const [rx, ry, rz] = right
    const [ux, uy, uz] = up
    const center = snap3(
        volume.sx / 2 + rx * panX + ux * panY,
        volume.sy / 2 + ry * panX + uy * panY,
        volume.sz / 2 + rz * panX + uz * panY
    )

    // Far enough back that the origin is outside the volume from every angle, whatever the pan.
    // These three are uniforms too, so they are narrowed to float32 for the same reason the basis
    // is — they just have no zero to snap.
    const dist = Math.fround(volume.sx + volume.sy + volume.sz)
    return {
        forward,
        right,
        up,
        center,
        scale: Math.fround(zoom / height),
        dist,
        depthRange: Math.fround(dist * 2)
    }
}
