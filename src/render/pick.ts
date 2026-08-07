import type {Basis} from './camera'
import {
    FACE_STEP,
    FACE_X_NEG,
    FACE_X_POS,
    FACE_Y_NEG,
    FACE_Y_POS,
    FACE_Z_NEG,
    FACE_Z_POS
} from './faces'
import {BIG, MAX_STEPS} from './raycast'
import type {Volume} from './volume'

/**
 * One ray, from one pixel, answering "what is under the cursor".
 *
 * The same DDA as `raycast.ts` walking the same grid with the same sentinel and the same entry
 * epsilon — deliberately a second copy rather than a refactor of the renderer's inner loop, which
 * hoists every invariant out of a per-pixel loop and would get slower for the privilege. What holds
 * the two together is a test that picks every pixel of a render and demands the same voxel and the
 * same face the renderer drew there. That is a stronger claim than sharing a function, because it
 * is checked against the thing that actually ships the sprite.
 */
export interface Hit {
    /** The voxel the ray struck. */
    readonly x: number
    readonly y: number
    readonly z: number
    /** Its palette index, `0` only for a ground hit. */
    readonly value: number
    readonly face: number
    /** The empty cell in front of that face — where a new voxel goes. */
    readonly place: readonly [number, number, number]
    /** Distance along the ray, in voxels, so the nearer of two hits can be chosen. */
    readonly t: number
}

const step = (face: number, x: number, y: number, z: number): readonly [number, number, number] => {
    const [dx, dy, dz] = FACE_STEP[face] ?? [0, 0, 0]
    return [x + dx, y + dy, z + dz]
}

/**
 * `column` and `row` are in image coordinates — row 0 is the top, which is where a pointer event's
 * `y` starts and which is the row the renderer writes first.
 */
export const pickRay = (
    volume: Volume,
    basis: Basis,
    column: number,
    row: number,
    width: number,
    height: number
): Hit | undefined => {
    const {sx, sy, sz, data} = volume
    const [fx, fy, fz] = basis.forward
    const [rx, ry, rz] = basis.right
    const [ux, uy, uz] = basis.up
    const [cx0, cy0, cz0] = basis.center
    const {scale, dist} = basis

    const a = (column - width * 0.5 + 0.5) * scale
    const b = (height - 1 - row - height * 0.5 + 0.5) * scale
    const ox = cx0 + rx * a + ux * b - fx * dist
    const oy = cy0 + ry * a + uy * b - fy * dist
    const oz = cz0 + rz * a + uz * b - fz * dist

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
    if (tmax < Math.max(tmin, 0)) return undefined

    const stepX = fx > 0 ? 1 : -1
    const stepY = fy > 0 ? 1 : -1
    const stepZ = fz > 0 ? 1 : -1
    const deltaX = fx === 0 ? BIG : Math.abs(1 / fx)
    const deltaY = fy === 0 ? BIG : Math.abs(1 / fy)
    const deltaZ = fz === 0 ? BIG : Math.abs(1 / fz)
    const faceX = fx > 0 ? FACE_X_NEG : FACE_X_POS
    const faceY = fy > 0 ? FACE_Y_NEG : FACE_Y_POS
    const faceZ = fz > 0 ? FACE_Z_NEG : FACE_Z_POS

    let face = faceX
    let entry = lox
    if (loy > entry) {
        entry = loy
        face = faceY
    }
    if (loz > entry) {
        face = faceZ
    }

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

    for (let i = 0; i < MAX_STEPS; i += 1) {
        if (vx < 0 || vy < 0 || vz < 0 || vx >= sx || vy >= sy || vz >= sz) return undefined
        const value = data[(vz * sy + vy) * sx + vx] ?? 0
        if (value !== 0) {
            return {
                x: vx,
                y: vy,
                z: vz,
                value,
                face,
                place: step(face, vx, vy, vz),
                t: enter + walked
            }
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
    return undefined
}

/**
 * Where the ray crosses the floor of the grid, for a cursor that missed the model.
 *
 * Without it an empty document is unusable: every draw needs a face to hang off, and a document
 * with no voxels has no faces. `z = 0` is the floor because `.vox` means up by z, and it is the
 * plane `GroundGrid` already draws — so the first voxel lands where the artist can see the cursor.
 */
export const pickGround = (
    volume: Volume,
    basis: Basis,
    column: number,
    row: number,
    width: number,
    height: number
): Hit | undefined => {
    const [fx, fy, fz] = basis.forward
    // Only from above. A ray travelling up sees the underside of the floor, and a voxel dropped on
    // the far side of a plane the artist is looking at edge-on is a voxel they did not ask for.
    if (fz >= 0) return undefined
    const [rx, ry, rz] = basis.right
    const [ux, uy, uz] = basis.up
    const [cx0, cy0, cz0] = basis.center
    const {scale, dist} = basis

    const a = (column - width * 0.5 + 0.5) * scale
    const b = (height - 1 - row - height * 0.5 + 0.5) * scale
    const ox = cx0 + rx * a + ux * b - fx * dist
    const oy = cy0 + ry * a + uy * b - fy * dist
    const oz = cz0 + rz * a + uz * b - fz * dist

    const t = (0 - oz) / fz
    if (t < 0) return undefined
    const x = Math.floor(ox + fx * t)
    const y = Math.floor(oy + fy * t)
    if (x < 0 || y < 0 || x >= volume.sx || y >= volume.sy) return undefined
    // The floor is a surface, not a voxel: the cell to write is the one sitting on it.
    return {x, y, z: -1, value: 0, face: FACE_Z_POS, place: [x, y, 0], t}
}

/** What the cursor is over: the model if it is there, the floor if it is not. */
export const pick = (
    volume: Volume,
    basis: Basis,
    column: number,
    row: number,
    width: number,
    height: number
): Hit | undefined =>
    pickRay(volume, basis, column, row, width, height)
    ?? pickGround(volume, basis, column, row, width, height)
