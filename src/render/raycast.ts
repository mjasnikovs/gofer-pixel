import {aoAt, faceCorners} from './ao'
import type {Basis} from './camera'
import {
    FACE_LIGHT,
    FACE_NORMAL,
    FACE_X_NEG,
    FACE_X_POS,
    FACE_Y_NEG,
    FACE_Y_POS,
    FACE_Z_NEG,
    FACE_Z_POS
} from './faces'
import type {Volume} from './volume'

/**
 * A zero direction component uses this instead of `Infinity` — in the slab test, in `tDelta` and
 * in the initial `tMax`. `Infinity` arithmetic is where JS and GLSL part company (`0 * Infinity`,
 * `Infinity - Infinity`), and an axis-aligned camera hits all three on two of its three axes.
 * A finite sentinel this large is unreachable for any real ray and behaves like a plain number on
 * both sides. Part of the renderer's contract; see `docs/techstack.md` §2.
 */
export const BIG = 1e18

/** Loop guard only — the real terminator is walking out of the volume. Shared with the shader. */
export const MAX_STEPS = 1024

/**
 * One render, four aligned maps.
 *
 * They come off the same ray, so they are aligned by construction rather than by a later
 * resampling step: the hit that produced a colour is the hit that produced its normal and depth.
 *
 * Row 0 is the top of the image, which is what a PNG wants. The GPU's framebuffer runs the other
 * way; the parity test is where that is reconciled.
 */
export interface RenderTarget {
    readonly width: number
    readonly height: number
    /** RGBA8, lit. Alpha is 255 on a hit and 0 on a miss. */
    readonly color: Uint8Array
    /** RGBA8 encoded face normal, `-1 → 0`, `0 → 128`, `+1 → 255`. Alpha as above. */
    readonly normal: Uint8Array
    /** `t / depthRange` in 16-bit fixed point. 0 on a miss. */
    readonly depth: Uint16Array
    /** The palette index struck. 0 on a miss, which is what makes it the hit mask too. */
    readonly id: Uint8Array
    /** Ambient occlusion, `255` fully open and `0` fully closed. `0` on a miss. */
    readonly ao: Uint8Array
    /** RGBA8 of the palette colour scaled by its emissive strength. Black and clear on a miss. */
    readonly emission: Uint8Array
}

export const createTarget = (width: number, height: number): RenderTarget => ({
    width,
    height,
    color: new Uint8Array(width * height * 4),
    normal: new Uint8Array(width * height * 4),
    depth: new Uint16Array(width * height),
    id: new Uint8Array(width * height),
    ao: new Uint8Array(width * height),
    emission: new Uint8Array(width * height * 4)
})

/**
 * The raycaster: one ray per output pixel, orthographic, integer grid, nearest everything.
 *
 * This is the exporter. Every sprite the app writes comes from here, which is why a golden-pixel
 * test of the shipped output is an ordinary unit test with no browser in it. The shader in
 * `raycast.glsl.ts` is the same algorithm again for the viewport, and the two are held to agreeing
 * exactly by a browser test.
 */
export const render = (
    volume: Volume,
    basis: Basis,
    width: number,
    height: number,
    into?: RenderTarget
): RenderTarget => {
    const target = into ?? createTarget(width, height)
    const {sx, sy, sz, data, palette, emissive} = volume
    const {color, normal, depth, id, ao, emission} = target
    // A miss writes nothing, so a reused target has to start empty or the last sprite shows
    // through this one's transparent pixels.
    color.fill(0)
    normal.fill(0)
    depth.fill(0)
    id.fill(0)
    ao.fill(0)
    emission.fill(0)
    const [fx, fy, fz] = basis.forward
    const [rx, ry, rz] = basis.right
    const [ux, uy, uz] = basis.up
    const [cx0, cy0, cz0] = basis.center
    const {scale, dist, depthRange} = basis

    const stepX = fx > 0 ? 1 : -1
    const stepY = fy > 0 ? 1 : -1
    const stepZ = fz > 0 ? 1 : -1
    const deltaX = fx === 0 ? BIG : Math.abs(1 / fx)
    const deltaY = fy === 0 ? BIG : Math.abs(1 / fy)
    const deltaZ = fz === 0 ? BIG : Math.abs(1 / fz)
    // The face a ray sees when it steps along an axis is the one facing back down that axis.
    const faceX = fx > 0 ? FACE_X_NEG : FACE_X_POS
    const faceY = fy > 0 ? FACE_Y_NEG : FACE_Y_POS
    const faceZ = fz > 0 ? FACE_Z_NEG : FACE_Z_POS

    for (let row = 0; row < height; row += 1) {
        // Row 0 is the top of the image but the ray's `up` axis points the other way.
        const py = height - 1 - row
        const b = (py - height * 0.5 + 0.5) * scale
        for (let px = 0; px < width; px += 1) {
            const a = (px - width * 0.5 + 0.5) * scale
            const ox = cx0 + rx * a + ux * b - fx * dist
            const oy = cy0 + ry * a + uy * b - fy * dist
            const oz = cz0 + rz * a + uz * b - fz * dist

            // Slab test into the volume's box.
            const ax = fx === 0 ? -BIG : (0 - ox) / fx
            const bx = fx === 0 ? BIG : (sx - ox) / fx
            const ay = fy === 0 ? -BIG : (0 - oy) / fy
            const by = fy === 0 ? BIG : (sy - oy) / fy
            const az = fz === 0 ? -BIG : (0 - oz) / fz
            const bz = fz === 0 ? BIG : (sz - oz) / fz
            const lox = Math.min(ax, bx)
            const loy = Math.min(ay, by)
            const loz = Math.min(az, bz)
            const tmin = Math.max(lox, loy, loz)
            const tmax = Math.min(Math.max(ax, bx), Math.max(ay, by), Math.max(az, bz))
            if (tmax < Math.max(tmin, 0)) continue

            // The face of the box the ray came in through, so a voxel sitting flush against that
            // face is shaded rather than left on face 0.
            let face = faceX
            let entry = lox
            if (loy > entry) {
                entry = loy
                face = faceY
            }
            if (loz > entry) {
                face = faceZ
            }

            // The DDA runs on distance from the entry point rather than from the ray origin: the
            // numbers stay small, which is the conditioning the two backends were measured to
            // agree under. Depth adds the entry distance back on at the end.
            const enter = Math.max(tmin, 0) + 1e-4
            let walked = 0
            const qx = ox + fx * enter
            const qy = oy + fy * enter
            const qz = oz + fz * enter
            let vx = Math.floor(qx)
            let vy = Math.floor(qy)
            let vz = Math.floor(qz)
            let maxX = fx === 0 ? BIG : (fx > 0 ? vx + 1 - qx : qx - vx) * deltaX
            let maxY = fy === 0 ? BIG : (fy > 0 ? vy + 1 - qy : qy - vy) * deltaY
            let maxZ = fz === 0 ? BIG : (fz > 0 ? vz + 1 - qz : qz - vz) * deltaZ

            for (let step = 0; step < MAX_STEPS; step += 1) {
                if (vx < 0 || vy < 0 || vz < 0 || vx >= sx || vy >= sy || vz >= sz) break
                const value = data[(vz * sy + vy) * sx + vx] ?? 0
                if (value !== 0) {
                    const light = FACE_LIGHT[face] ?? 0
                    const at = (row * width + px) * 4
                    const swatch = value * 4
                    color[at] = Math.floor(((palette[swatch] ?? 0) * light) / 256)
                    color[at + 1] = Math.floor(((palette[swatch + 1] ?? 0) * light) / 256)
                    color[at + 2] = Math.floor(((palette[swatch + 2] ?? 0) * light) / 256)
                    color[at + 3] = 255
                    const n = face * 3
                    normal[at] = FACE_NORMAL[n] ?? 128
                    normal[at + 1] = FACE_NORMAL[n + 1] ?? 128
                    normal[at + 2] = FACE_NORMAL[n + 2] ?? 128
                    normal[at + 3] = 255
                    const t = enter + walked
                    depth[row * width + px] = Math.floor(
                        Math.min(Math.max(t / depthRange, 0), 1) * 65535
                    )
                    id[row * width + px] = value

                    /*
                     * Where inside the cell the ray struck, along the face's own two axes. The
                     * occlusion is interpolated to that point, which is what keeps a face from
                     * reading as one flat tone at four pixels to the voxel.
                     *
                     * Written out per face rather than indexed through `FACE_UV`, because the
                     * obvious `const hit = [hx - vx, …]` allocates an array for every opaque pixel
                     * of every sprite in the window. That one line took the seven-window UI test
                     * from 0.2 s to 7 s — the inside of this loop is the hottest code in the app
                     * and it must not allocate.
                     */
                    const hx = ox + fx * t - vx
                    const hy = oy + fy * t - vy
                    const hz = oz + fz * t - vz
                    const fu = face <= 2 ? hy : hx
                    const fv = face <= 4 ? hz : hy
                    ao[row * width + px] = aoAt(
                        faceCorners(volume, vx, vy, vz, face),
                        fu < 0 ? 0
                        : fu > 1 ? 1
                        : fu,
                        fv < 0 ? 0
                        : fv > 1 ? 1
                        : fv
                    )

                    const glow = emissive[value] ?? 0
                    if (glow !== 0) {
                        emission[at] = Math.floor(((palette[swatch] ?? 0) * glow) / 255)
                        emission[at + 1] = Math.floor(((palette[swatch + 1] ?? 0) * glow) / 255)
                        emission[at + 2] = Math.floor(((palette[swatch + 2] ?? 0) * glow) / 255)
                    }
                    emission[at + 3] = 255
                    break
                }
                if (maxX < maxY && maxX < maxZ) {
                    vx += stepX
                    walked = maxX
                    maxX += deltaX
                    face = faceX
                } else if (maxY < maxZ) {
                    vy += stepY
                    walked = maxY
                    maxY += deltaY
                    face = faceY
                } else {
                    vz += stepZ
                    walked = maxZ
                    maxZ += deltaZ
                    face = faceZ
                }
            }
        }
    }
    return target
}
