import {blit, createImage, type RgbaImage} from '../image/rgba'
import {hasVoxel, layersByZ, unpackKey, type VoxModel} from './model'

/**
 * Round half to even, the way Python's `round` does — not JS's round-half-up.
 * At angle 0 a model with an even footprint puts voxel centres exactly on .5, so the two rules
 * disagree on entire columns of pixels rather than on the odd stray one.
 */
const roundHalfEven = (v: number): number => {
    const floor = Math.floor(v)
    const frac = v - floor
    if (frac > 0.5) {
        return floor + 1
    }
    if (frac < 0.5) {
        return floor
    }
    return floor % 2 === 0 ? floor : floor + 1
}

/**
 * Outward normal of a voxel, taken from which of its six faces are exposed.
 * Returns null for a fully enclosed voxel, which is never visible.
 */
const surfaceNormal = (
    model: VoxModel,
    x: number,
    y: number,
    z: number
): [number, number, number] | null => {
    const nx = (hasVoxel(model, x + 1, y, z) ? 0 : 1) - (hasVoxel(model, x - 1, y, z) ? 0 : 1)
    const ny = (hasVoxel(model, x, y + 1, z) ? 0 : 1) - (hasVoxel(model, x, y - 1, z) ? 0 : 1)
    const nz = (hasVoxel(model, x, y, z + 1) ? 0 : 1) - (hasVoxel(model, x, y, z - 1) ? 0 : 1)
    if (nx === 0 && ny === 0 && nz === 0) {
        return null
    }
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    return [nx / len, ny / len, nz / len]
}

/**
 * Every visible voxel's normal, computed once.
 *
 * `renderAngle` needs the normal of each voxel it draws, and the normal depends only on which
 * neighbours are occupied — not on the angle. Recomputing it per angle meant a 16-angle sheet did
 * six neighbour lookups per voxel sixteen times over, which `PRODUCTION_PLAN.md` §14 flagged as the
 * easy win before any GPU work. Preparing the field costs exactly what one angle used to, so a
 * single render is unchanged and a sheet gets it free.
 *
 * Enclosed voxels are absent rather than stored as null: they are never drawn, and leaving them out
 * keeps the map to the surface, which is the part that scales with area rather than volume.
 */
export type NormalField = Map<number, readonly [number, number, number]>

export const prepareNormals = (model: VoxModel): NormalField => {
    const field: NormalField = new Map()
    for (const key of model.voxels.keys()) {
        const [x, y, z] = unpackKey(key)
        const normal = surfaceNormal(model, x, y, z)
        if (normal) {
            field.set(key, normal)
        }
    }
    return field
}

export interface RenderOptions {
    /** Pixels per voxel. */
    scale?: number
    /**
     * Normals prepared with `prepareNormals`. Optional: a render without one prepares its own, so
     * this is purely about not doing it once per angle. It must belong to the same model — a stale
     * field would light the sprite by a shape it no longer has.
     */
    normals?: NormalField
    /**
     * How many pixels each slice sits above the one below. Defaults to `scale`, one voxel of
     * apparent height per layer. Keeping it at or below `scale` is what makes the stack hole-free:
     * consecutive slices are `scale` px tall, so they touch and no gap can open at any rotation.
     */
    lift?: number
}

export interface RenderedAngle {
    albedo: RgbaImage
    normal: RgbaImage
}

/** Sprite-stack render at `angle` degrees. Painter's order: bottom slice first, higher wins. */
export const renderAngle = (
    model: VoxModel,
    angle: number,
    {scale = 1, lift, normals}: RenderOptions = {}
): RenderedAngle => {
    const {sx, sy, sz, palette} = model
    const field = normals ?? prepareNormals(model)
    const step = lift ?? scale
    const a = (angle * Math.PI) / 180
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    const cx = (sx - 1) / 2
    const cy = (sy - 1) / 2

    // a rotated footprint needs room for the diagonal
    const diag = Math.ceil(Math.hypot(sx, sy))
    const width = diag * scale
    const height = diag * scale + (sz - 1) * step
    const albedo = createImage(width, height)
    const normal = createImage(width, height)
    const albedoData = albedo.data
    const normalData = normal.data
    // Floor the centring offset. A fractional offset is fatal at axis-aligned angles: the rotation
    // terms cancel, so rx === vx + ox exactly, and a .5 offset puts every voxel centre on a tie that
    // round-half-to-even resolves in pairs — columns x and x+1 land on the same output column and
    // half the model disappears. Measured on car.vox at 0°: 82 visible pixels before, 158 after.
    const ox = Math.floor((diag - sx) / 2)
    const oy = Math.floor((diag - sy) / 2)

    // bottom layer first, so higher slices paint over lower ones
    for (const entries of layersByZ(model)) {
        for (const [key, color] of entries) {
            const n = field.get(key)
            if (!n) {
                continue
            }
            const [vx, vy, vz] = unpackKey(key)
            const rgba = palette[color - 1]
            if (!rgba || rgba.a === 0) {
                continue
            }
            const {r, g, b, a: alpha} = rgba
            // rotate about the model's centre, in the ground plane
            const rx = (vx - cx) * ca - (vy - cy) * sa + cx + ox
            const ry = (vx - cx) * sa + (vy - cy) * ca + cy + oy
            // rotate the normal to match, then encode; y flips with the screen
            const wnx = n[0] * ca - n[1] * sa
            const wny = n[0] * sa + n[1] * ca
            const nr = Math.trunc((wnx * 0.5 + 0.5) * 255)
            const ng = Math.trunc((-wny * 0.5 + 0.5) * 255)
            const nb = Math.trunc((n[2] * 0.5 + 0.5) * 255)

            const px = roundHalfEven(rx) * scale
            const py = roundHalfEven(diag - 1 - ry) * scale + (sz - 1 - vz) * step
            for (let jy = 0; jy < scale; jy += 1) {
                const yy = py + jy
                if (px < 0 || px >= width || yy < 0 || yy >= height) {
                    continue
                }
                const row = (yy * width + px) * 4
                for (let jx = 0; jx < scale; jx += 1) {
                    // four direct writes rather than `data.set([...])`: the array literal was a
                    // fresh allocation per pixel per image, and at scale 4 that is 32 of them per
                    // voxel per angle. Same bytes, same order — the parity hashes prove it.
                    const at = row + jx * 4
                    albedoData[at] = r
                    albedoData[at + 1] = g
                    albedoData[at + 2] = b
                    albedoData[at + 3] = alpha
                    normalData[at] = nr
                    normalData[at + 1] = ng
                    normalData[at + 2] = nb
                    normalData[at + 3] = 255
                }
            }
        }
    }

    return {albedo, normal}
}

/** One row of `steps` renders spanning a full turn. */
export const rotationSheet = (
    model: VoxModel,
    steps = 8,
    options: RenderOptions = {},
    pad = 1
): RenderedAngle => {
    // one normal field for the whole turn — the point of `prepareNormals`
    const normals = options.normals ?? prepareNormals(model)
    const frames = Array.from({length: steps}, (_unused, i) =>
        renderAngle(model, (i * 360) / steps, {...options, normals})
    )
    const first = frames[0]
    if (!first) {
        throw new Error('a rotation sheet needs at least one step')
    }

    const {width: fw, height: fh} = first.albedo
    const albedo = createImage(steps * (fw + pad) + pad, fh + pad * 2)
    const normal = createImage(albedo.width, albedo.height)

    frames.forEach((frame, i) => {
        const ox = pad + i * (fw + pad)
        blit(albedo, frame.albedo, ox, pad)
        blit(normal, frame.normal, ox, pad)
    })

    return {albedo, normal}
}

export interface LightOptions {
    x?: number
    y?: number
    z?: number
    ambient?: number
}

/** Lambert-shade an albedo buffer with its normal map. The sanity check for the normal map. */
export const light = (
    {albedo, normal}: RenderedAngle,
    {x = -0.5, y = -0.5, z = 0.9, ambient = 0.55}: LightOptions = {}
): RgbaImage => {
    const len = Math.sqrt(x * x + y * y + z * z)
    const lx = x / len
    const ly = y / len
    const lz = z / len
    const out = createImage(albedo.width, albedo.height)

    const src = albedo.data
    const enc = normal.data
    for (let i = 0; i < src.length; i += 4) {
        const alpha = src[i + 3] ?? 0
        if (alpha === 0) {
            continue
        }
        const nx = (enc[i] ?? 0) / 127.5 - 1
        const ny = (enc[i + 1] ?? 0) / 127.5 - 1
        const nz = (enc[i + 2] ?? 0) / 127.5 - 1
        const d = Math.max(0, nx * lx + ny * ly + nz * lz) * (1 - ambient) + ambient
        out.data[i] = Math.min(255, Math.trunc((src[i] ?? 0) * d))
        out.data[i + 1] = Math.min(255, Math.trunc((src[i + 1] ?? 0) * d))
        out.data[i + 2] = Math.min(255, Math.trunc((src[i + 2] ?? 0) * d))
        out.data[i + 3] = alpha
    }
    return out
}
