import {packKey, unpackKey, type VoxModel} from '../vox/model'
import {colorFromHex} from '../doc/serialize'
import type {Rgba} from '../vox/palette'

/**
 * The primitive language the model generates in, and its rasteriser.
 *
 * This is a port of `voxgen.py:rasterise`, deliberately kept byte-compatible with it: the same
 * spec produces the same voxels, the same palette in the same order, and therefore the same
 * `.vox` file. `src/gen/ops.parity.test.ts` pins that against the Python.
 *
 * The model never draws pixels — that is settled dead in `DESIGN_PROGRESS.md`. It emits a short
 * list of solid primitives and code turns them into voxels, which is why every slice is registered
 * by construction.
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
    name: string
    size: Vec3
    mirror_x: boolean
    ops: VoxOp[]
}

const TRANSPARENT: Rgba = {r: 0, g: 0, b: 0, a: 0}

/** The JSON schema sent to llama-server, which turns it into a grammar. Mirrors `VOX_SCHEMA`. */
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

/**
 * Ops to voxels.
 *
 * Palette entries are appended in first-seen order and indices are 1-based, matching `.vox`.
 * Out-of-bounds writes are dropped rather than clamped — clamping would smear a mistyped
 * coordinate along a wall, which looks like geometry instead of like an error.
 */
export const rasterise = (spec: VoxSpec): VoxModel => {
    const [sx, sy, sz] = spec.size
    const voxels = new Map<number, number>()
    const palette: Rgba[] = []
    const index = new Map<string, number>()

    const idx = (hex: string): number => {
        const key = hex.toLowerCase().replace(/^#/, '')
        const found = index.get(key)
        if (found !== undefined) {
            return found
        }
        palette.push(colorFromHex(key))
        index.set(key, palette.length)
        return palette.length
    }

    const put = (x: number, y: number, z: number, color: number | null): void => {
        if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) {
            return
        }
        const key = packKey(x, y, z)
        if (color === null) {
            voxels.delete(key)
        } else {
            voxels.set(key, color)
        }
    }

    for (const op of spec.ops) {
        if (op.op === 'box' || op.op === 'erase') {
            const [x0, y0, z0] = op.from
            const [x1, y1, z1] = op.to
            const color = op.op === 'erase' ? null : idx(op.color)
            for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += 1) {
                for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += 1) {
                    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z += 1) {
                        put(x, y, z, color)
                    }
                }
            }
        } else {
            const [cx, cy, cz] = op.at
            const [rx, ry, rz] = op.r
            const color = idx(op.color)
            for (let x = cx - rx; x <= cx + rx; x += 1) {
                for (let y = cy - ry; y <= cy + ry; y += 1) {
                    for (let z = cz - rz; z <= cz + rz; z += 1) {
                        const dx = (x - cx) / Math.max(rx, 0.5)
                        const dy = (y - cy) / Math.max(ry, 0.5)
                        const dz = (z - cz) / Math.max(rz, 0.5)
                        if (dx * dx + dy * dy + dz * dz <= 1) {
                            put(x, y, z, color)
                        }
                    }
                }
            }
        }
    }

    if (spec.mirror_x) {
        // over a snapshot, so the reflection is of the finished model rather than of itself
        for (const [key, color] of [...voxels]) {
            const [x, y, z] = unpackKey(key)
            put(sx - 1 - x, y, z, color)
        }
    }

    while (palette.length < 256) {
        palette.push(TRANSPARENT)
    }
    return {sx, sy, sz, voxels, palette}
}
