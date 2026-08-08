import {createVolume, setVoxel, voxelIndex, type Volume} from '../render/volume'

/**
 * The primitive language the model generates in, and its rasteriser.
 *
 * The model never draws pixels. That is settled dead and it is not a prompting problem — grammar
 * constraints fixed the formatting completely and it still produced 0 of 12 sprites that depicted
 * their subject (`legacy/docs/DESIGN_PROGRESS.md`, finding 1). What it *can* do is emit a short list
 * of solid primitives, which code turns into voxels. Everything downstream is then exact: the model
 * is on integer coordinates because nothing else was ever available to it.
 *
 * Carried over from `legacy/src/gen/ops.ts`, re-derived against the dense `Volume` rather than the
 * old sparse `Map`. The legacy version was pinned byte-for-byte against `legacy/py/voxgen.py`
 * because Python rasterised the same specs to score them. Nothing rasterises them twice any more —
 * see `src/gen/clip.ts` — so that parity requirement is gone with the second rasteriser.
 */
export type Vec3 = [number, number, number]

export interface BoxOp {
    op: 'box'
    from: Vec3
    to: Vec3
    color: string
}

export interface BallOp {
    op: 'ball'
    at: Vec3
    r: Vec3
    color: string
}

export interface EraseOp {
    op: 'erase'
    from: Vec3
    to: Vec3
}

export type VoxOp = BoxOp | BallOp | EraseOp

export interface VoxSpec {
    readonly name: string
    readonly size: Vec3
    readonly mirror_x: boolean
    readonly ops: readonly VoxOp[]
}

/**
 * The largest grid a generated model may claim.
 *
 * 32 is the number the system prompt asks for and the number the subjects that work were validated
 * at. It is enforced here as well as asked for, because the grid a spec declares is the grid the
 * document gets — a model that answered 512 would allocate 134 million cells before anything looked
 * at it.
 */
export const MAX_SIZE = 32

/** The JSON schema sent to llama-server, which turns it into a decoding grammar. */
export const VOX_SCHEMA = {
    type: 'object',
    properties: {
        name: {type: 'string'},
        size: {type: 'array', items: {type: 'integer'}, minItems: 3, maxItems: 3},
        mirror_x: {type: 'boolean'},
        ops: {
            type: 'array',
            minItems: 1,
            maxItems: 40,
            items: {
                anyOf: [
                    {
                        type: 'object',
                        properties: {
                            op: {const: 'box'},
                            from: {
                                type: 'array',
                                items: {type: 'integer'},
                                minItems: 3,
                                maxItems: 3
                            },
                            to: {type: 'array', items: {type: 'integer'}, minItems: 3, maxItems: 3},
                            color: {type: 'string', pattern: '^#[0-9a-fA-F]{6}$'}
                        },
                        required: ['op', 'from', 'to', 'color'],
                        additionalProperties: false
                    },
                    {
                        type: 'object',
                        properties: {
                            op: {const: 'ball'},
                            at: {type: 'array', items: {type: 'integer'}, minItems: 3, maxItems: 3},
                            r: {type: 'array', items: {type: 'integer'}, minItems: 3, maxItems: 3},
                            color: {type: 'string', pattern: '^#[0-9a-fA-F]{6}$'}
                        },
                        required: ['op', 'at', 'r', 'color'],
                        additionalProperties: false
                    },
                    {
                        type: 'object',
                        properties: {
                            op: {const: 'erase'},
                            from: {
                                type: 'array',
                                items: {type: 'integer'},
                                minItems: 3,
                                maxItems: 3
                            },
                            to: {type: 'array', items: {type: 'integer'}, minItems: 3, maxItems: 3}
                        },
                        required: ['op', 'from', 'to'],
                        additionalProperties: false
                    }
                ]
            }
        }
    },
    required: ['name', 'size', 'mirror_x', 'ops'],
    additionalProperties: false
} as const

const clampAxis = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 1
    return Math.min(MAX_SIZE, Math.max(1, Math.floor(value)))
}

const isTriple = (value: unknown): value is Vec3 =>
    Array.isArray(value) && value.length === 3 && value.every(entry => typeof entry === 'number')

const isHex = (value: unknown): value is string =>
    typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)

const readOp = (value: unknown): VoxOp | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const {op, from, to, at, r, color} = value as Record<string, unknown>
    if (op === 'box' && isTriple(from) && isTriple(to) && isHex(color)) return {op, from, to, color}
    if (op === 'erase' && isTriple(from) && isTriple(to)) return {op, from, to}
    if (op === 'ball' && isTriple(at) && isTriple(r) && isHex(color)) return {op, at, r, color}
    return undefined
}

/**
 * A reply narrowed into a spec, or `undefined` for anything that is not one.
 *
 * The grammar makes a malformed reply unproducible *by a server that honours it*, and this build
 * does not get to assume that: a schema the server silently ignored, a proxy in front of it, or a
 * different model behind it all arrive here as ordinary JSON. Ops that will not read are dropped
 * rather than fatal — 39 good primitives and one typo is a model, and refusing it would throw away
 * eight seconds of generation over a coordinate.
 */
export const readSpec = (value: unknown): VoxSpec | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const {name, size, mirror_x: mirror, ops} = value as Record<string, unknown>
    if (!Array.isArray(size) || size.length !== 3 || !Array.isArray(ops)) return undefined
    const read = ops.map(readOp).filter((entry): entry is VoxOp => entry !== undefined)
    if (read.length === 0) return undefined
    return {
        name: typeof name === 'string' && name !== '' ? name : 'Generated',
        size: [clampAxis(size[0]), clampAxis(size[1]), clampAxis(size[2])],
        mirror_x: mirror === true,
        ops: read
    }
}

const channel = (hex: string, at: number): number => parseInt(hex.slice(at, at + 2), 16)

/**
 * The box the painting ops actually cover, in op coordinates. `undefined` when nothing paints.
 *
 * `erase` is excluded on purpose: it removes, so it must not be able to grow the grid. A model that
 * carves `[0,0,0]…[31,31,31]` to mean "start empty" would otherwise allocate the whole 32³ around a
 * model the size of a die.
 */
const paintedBounds = (ops: readonly VoxOp[]): {lo: Vec3; hi: Vec3} | undefined => {
    const lo: Vec3 = [Infinity, Infinity, Infinity]
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
    let any = false
    for (const op of ops) {
        if (op.op === 'erase') continue
        const corners: readonly Vec3[] =
            op.op === 'ball' ?
                [
                    [op.at[0] - op.r[0], op.at[1] - op.r[1], op.at[2] - op.r[2]],
                    [op.at[0] + op.r[0], op.at[1] + op.r[1], op.at[2] + op.r[2]]
                ]
            :   [op.from, op.to]
        any = true
        for (const [cx, cy, cz] of corners) {
            lo[0] = Math.min(lo[0], cx)
            lo[1] = Math.min(lo[1], cy)
            lo[2] = Math.min(lo[2], cz)
            hi[0] = Math.max(hi[0], cx)
            hi[1] = Math.max(hi[1], cy)
            hi[2] = Math.max(hi[2], cz)
        }
    }
    return any ? {lo, hi} : undefined
}

const extent = (low: number, high: number): number =>
    Math.max(1, Math.min(MAX_SIZE, Math.floor(high) - Math.ceil(low) + 1))

/**
 * The grid a spec gets, which is the box its ops paint rather than the `size` it declared.
 *
 * Measured against the live Qwen3.6-27B on 2026-08-08 over six "a cat" replies: **every one wrote
 * outside the size it had just declared** — `[20,16,14]` with ops reaching `y = 18`, `[16,20,16]`
 * with ops reaching `z = 23`. Writes off the grid are dropped, so what vanished was always the
 * detail: the ears, the tail, the far side of a head. The declared size is the one number in the
 * reply the model has no picture of, and there is no reason to trust it over the ops themselves.
 *
 * `size` is still read and still clamped — it travels with the spec into the saved record — it just
 * no longer decides how much of the model survives.
 *
 * With `mirror_x` the width is doubled about the model's own far edge rather than about the
 * declared centre, because a half whose declared plane was wrong is a half joined to itself in the
 * wrong place: a seam, or a body with a hollow down the middle.
 */
export const gridFor = (spec: VoxSpec): {readonly size: Vec3; readonly origin: Vec3} => {
    // Both are in *op* space, so `size` reads [width, height, depth]. `rasterise` swaps.
    const bounds = paintedBounds(spec.ops)
    if (!bounds) return {size: [1, 1, 1], origin: [0, 0, 0]}
    const {lo, hi} = bounds
    const half = extent(lo[0], hi[0])
    return {
        size: [
            spec.mirror_x ? Math.min(MAX_SIZE, half * 2) : half,
            extent(lo[1], hi[1]),
            extent(lo[2], hi[2])
        ],
        origin: [Math.ceil(lo[0]), Math.ceil(lo[1]), Math.ceil(lo[2])]
    }
}

/**
 * Ops to voxels.
 *
 * **Op coordinates are y-up; a `Volume` is z-up.** The swap happens here, and it is not a taste
 * call. The prompt used to say "z = up" and the model ignored it every time — measured on
 * 2026-08-08, four legs came back at the four corners of the x–z plane with the head at high `y`,
 * which is y-up whatever the system prompt asked for. Asking a 27B model to work against the
 * convention its training data is written in bought lying-down cats; asking for y-up and swapping
 * one line here buys cats that stand.
 *
 * Palette entries are appended in first-seen order and indices are 1-based, matching `.vox` and the
 * rest of this app. Writes outside the fitted grid are dropped rather than clamped — clamping would
 * smear a mistyped coordinate along a wall, which looks like geometry instead of like an error.
 */
export const rasterise = (spec: VoxSpec): Volume => {
    const {size, origin} = gridFor(spec)
    const [width, height, depth] = size
    const [ox, oy, oz] = origin
    const palette = new Uint8Array(256 * 4)
    const slots = new Map<string, number>()
    // The swap: the grid is as deep as the ops are in z, and as tall as they are in y.
    const volume = createVolume(width, depth, height, palette)

    /** One op-space cell, in y-up op coordinates, into the z-up grid. */
    const put = (x: number, y: number, z: number, value: number): void => {
        setVoxel(volume, x - ox, z - oz, y - oy, value)
    }

    const slot = (css: string): number => {
        const key = css.toLowerCase().replace(/^#/, '')
        const found = slots.get(key)
        if (found !== undefined) return found
        // 255 entries, 1-based. Past that the colour is dropped onto the last one rather than
        // wrapping to 0, which would erase the voxel it was meant to paint.
        const index = Math.min(255, slots.size + 1)
        slots.set(key, index)
        palette.set([channel(key, 0), channel(key, 2), channel(key, 4), 255], index * 4)
        return index
    }

    for (const op of spec.ops) {
        if (op.op === 'box' || op.op === 'erase') {
            const value = op.op === 'erase' ? 0 : slot(op.color)
            const [x0, y0, z0] = op.from
            const [x1, y1, z1] = op.to
            for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += 1) {
                for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += 1) {
                    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z += 1) {
                        put(x, y, z, value)
                    }
                }
            }
        } else {
            const value = slot(op.color)
            const [cx, cy, cz] = op.at
            const [rx, ry, rz] = op.r
            for (let x = cx - rx; x <= cx + rx; x += 1) {
                for (let y = cy - ry; y <= cy + ry; y += 1) {
                    for (let z = cz - rz; z <= cz + rz; z += 1) {
                        const dx = (x - cx) / Math.max(rx, 0.5)
                        const dy = (y - cy) / Math.max(ry, 0.5)
                        const dz = (z - cz) / Math.max(rz, 0.5)
                        if (dx * dx + dy * dy + dz * dz <= 1) put(x, y, z, value)
                    }
                }
            }
        }
    }

    if (spec.mirror_x) {
        // Over a copy, so the reflection is of the finished model rather than of itself — mirroring
        // in place would fold the half it had just written back over the other side.
        const before = Uint8Array.from(volume.data)
        for (let z = 0; z < volume.sz; z += 1) {
            for (let y = 0; y < volume.sy; y += 1) {
                for (let x = 0; x < volume.sx; x += 1) {
                    const value = before[voxelIndex(volume, x, y, z)] ?? 0
                    if (value !== 0) setVoxel(volume, volume.sx - 1 - x, y, z, value)
                }
            }
        }
    }

    return volume
}

export const countFilled = ({data}: Volume): number => {
    let count = 0
    for (const value of data) if (value !== 0) count += 1
    return count
}
