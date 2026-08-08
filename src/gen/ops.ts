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
 * Ops to voxels.
 *
 * Palette entries are appended in first-seen order and indices are 1-based, matching `.vox` and the
 * rest of this app. Out-of-bounds writes are dropped rather than clamped — clamping would smear a
 * mistyped coordinate along a wall, which looks like geometry instead of like an error.
 */
export const rasterise = (spec: VoxSpec): Volume => {
    const [sx, sy, sz] = spec.size
    const palette = new Uint8Array(256 * 4)
    const slots = new Map<string, number>()
    const volume = createVolume(sx, sy, sz, palette)

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
                        setVoxel(volume, x, y, z, value)
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
                        if (dx * dx + dy * dy + dz * dz <= 1) setVoxel(volume, x, y, z, value)
                    }
                }
            }
        }
    }

    if (spec.mirror_x) {
        // Over a copy, so the reflection is of the finished model rather than of itself — mirroring
        // in place would fold the half it had just written back over the other side.
        const before = Uint8Array.from(volume.data)
        for (let z = 0; z < sz; z += 1) {
            for (let y = 0; y < sy; y += 1) {
                for (let x = 0; x < sx; x += 1) {
                    const value = before[voxelIndex(volume, x, y, z)] ?? 0
                    if (value !== 0) setVoxel(volume, sx - 1 - x, y, z, value)
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
