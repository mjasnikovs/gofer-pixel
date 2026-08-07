import {FACE_STEP, FACE_UV} from './faces'
import type {Volume} from './volume'

/**
 * Ambient occlusion, from geometry alone — `FEATURESET.md` §18.
 *
 * Four numbers per face, one per corner, each counting how much of that corner is walled in by the
 * three neighbours that touch it. Between them the value is interpolated, so a face is a smooth
 * gradient rather than one flat tone: at a sprite's usual four-or-more pixels per voxel, flat
 * per-face occlusion reads as a checkerboard, and the corner-and-interpolate scheme is the one
 * voxel renderers have used since Minecraft precisely because it does not.
 *
 * A corner with neighbours on both sides is fully closed whatever the diagonal does — that is the
 * `side1 && side2` case, and without it an inside corner shows a bright pinhole where the diagonal
 * happens to be open.
 *
 * The four levels are `0 … 3`, and a level is written out as `level * 85`, which lands exactly on
 * `255` and needs no rounding on either backend.
 *
 * This runs once per opaque pixel of every sprite, thumbnail and sheet the app draws, so it
 * allocates nothing: the nine neighbour reads are flat index arithmetic on the grid rather than
 * nine coordinate triples. The obvious version with a `[...cell]` per lookup made a window of
 * twenty-four CPU thumbnails three times slower on its own.
 */
export const AO_STEP = 85

/** The four corners of the last face asked about, reused so a render allocates no arrays at all. */
const corners = new Int8Array(4)

const level = (side1: number, side2: number, diagonal: number): number =>
    side1 !== 0 && side2 !== 0 ? 0 : 3 - (side1 + side2 + diagonal)

/**
 * The occlusion at the four corners of the face, in the order `(0,0) (1,0) (0,1) (1,1)` over the
 * face's own two axes. Read from the layer *in front* of the face — the air the light comes from.
 *
 * The returned array is reused between calls; read it before calling again.
 */
export const faceCorners = (
    volume: Volume,
    x: number,
    y: number,
    z: number,
    face: number
): Int8Array => {
    const {sx, sy, sz, data} = volume
    const step = FACE_STEP[face] ?? [0, 0, 0]
    const [u, v] = FACE_UV[face] ?? [0, 1]
    const fx = x + step[0]
    const fy = y + step[1]
    const fz = z + step[2]

    // The two in-plane axes as strides, so a neighbour is one addition rather than a new triple.
    const ux = u === 0 ? 1 : 0
    const uy = u === 1 ? 1 : 0
    const uz = u === 2 ? 1 : 0
    const vx = v === 0 ? 1 : 0
    const vy = v === 1 ? 1 : 0
    const vz = v === 2 ? 1 : 0

    // The nine neighbours, read straight into a bit per cell. Written out rather than looped or
    // closed over: this is the innermost thing in the exporter, and a closure allocated per hit
    // pixel cost the whole renderer sixty per cent.
    let bits = 0
    for (let i = 0; i < 9; i += 1) {
        const du = (i % 3) - 1
        const dv = Math.floor(i / 3) - 1
        const cx = fx + ux * du + vx * dv
        const cy = fy + uy * du + vy * dv
        const cz = fz + uz * du + vz * dv
        if (cx < 0 || cy < 0 || cz < 0 || cx >= sx || cy >= sy || cz >= sz) continue
        if ((data[(cz * sy + cy) * sx + cx] ?? 0) !== 0) bits |= 1 << i
    }

    // Bit `i` is offset `(i % 3 - 1, floor(i / 3) - 1)`: 0 is (−1,−1), 4 is the centre, 8 is (1,1).
    const left = (bits >> 3) & 1
    const right = (bits >> 5) & 1
    const down = (bits >> 1) & 1
    const up = (bits >> 7) & 1
    corners[0] = level(left, down, bits & 1)
    corners[1] = level(right, down, (bits >> 2) & 1)
    corners[2] = level(left, up, (bits >> 6) & 1)
    corners[3] = level(right, up, (bits >> 8) & 1)
    return corners
}

/**
 * The occlusion byte at a point on the face, `fu` and `fv` being where the ray struck it inside the
 * cell, each in `0 … 1`. Bilinear between the four corners.
 */
export const aoAt = (four: Int8Array, fu: number, fv: number): number => {
    const c00 = four[0] ?? 3
    const c10 = four[1] ?? 3
    const c01 = four[2] ?? 3
    const c11 = four[3] ?? 3
    const bottom = c00 + (c10 - c00) * fu
    const top = c01 + (c11 - c01) * fu
    return Math.round((bottom + (top - bottom) * fv) * AO_STEP)
}
