/*
 * The local-AI spike: does the legacy generation pipeline still work against the *new* renderer?
 *
 * Legacy scored candidates by rasterising them a second time in Python and rendering them with the
 * sprite stacker (`legacy/py/voxrank.py` → `voxrender.py`). That renderer is gone. This asks whether
 * CLIP can rank the pictures the CPU raycaster already makes, which would leave Python holding
 * nothing but CLIP.
 *
 *     bun docs/spikes/gen-clip.ts "a stone tower" 6
 *
 * Writes out/gen-clip/<i>-<angle>.png and a specs.json, then score them with:
 *
 *     .venv/bin/python docs/spikes/clip_rank.py "a stone tower" out/gen-clip
 */
import {basisFor, createCamera} from '../../src/render/camera'
import {ISOMETRIC_PITCH} from '../../src/doc/cameras'
import {encodePng} from '../../src/image/png'
import {render} from '../../src/render/raycast'
import {createVolume, setVoxel, type Volume} from '../../src/render/volume'

const SYSTEM = `You are a voxel modeller. You answer with JSON only, no prose, no markdown fence.

Schema:
{"name": str,
 "size": [sx, sy, sz],
 "mirror_x": bool,
 "ops": [ ... ]}

Axes: x = length/width, y = depth, z = up. Origin is the min corner.
Ops are applied in order; later ops paint over earlier ones.
  {"op":"box","from":[x,y,z],"to":[x,y,z],"color":"#rrggbb"}   inclusive bounds
  {"op":"ball","at":[x,y,z],"r":[rx,ry,rz],"color":"#rrggbb"}  axis-aligned ellipsoid
  {"op":"erase","from":[x,y,z],"to":[x,y,z]}                   carve empty space

Rules:
- Keep size within 32x32x32 and use at most 40 ops.
- If mirror_x is true, only model x < sx/2; the other half is generated.
- Build in readable layers: the object must look correct sliced horizontally,
  so avoid overhangs that would leave a slice floating and unreadable.
- Use 4-8 distinct colors with real value contrast, not near-identical shades.`

const SCHEMA = {
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
                            from: {type: 'array', items: {type: 'integer'}, minItems: 3, maxItems: 3},
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
                            from: {type: 'array', items: {type: 'integer'}, minItems: 3, maxItems: 3},
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
}

type Vec3 = [number, number, number]
interface Spec {
    name: string
    size: Vec3
    mirror_x: boolean
    ops: (
        | {op: 'box'; from: Vec3; to: Vec3; color: string}
        | {op: 'ball'; at: Vec3; r: Vec3; color: string}
        | {op: 'erase'; from: Vec3; to: Vec3}
    )[]
}

const rasterise = (spec: Spec): Volume => {
    const [sx, sy, sz] = spec.size
    const palette = new Uint8Array(256 * 4)
    const slots = new Map<string, number>()
    const volume = createVolume(sx, sy, sz, palette)
    const slot = (hex: string): number => {
        const key = hex.toLowerCase().replace(/^#/, '')
        const found = slots.get(key)
        if (found !== undefined) return found
        const index = slots.size + 1
        slots.set(key, index)
        palette.set(
            [
                parseInt(key.slice(0, 2), 16),
                parseInt(key.slice(2, 4), 16),
                parseInt(key.slice(4, 6), 16),
                255
            ],
            index * 4
        )
        return index
    }
    for (const op of spec.ops) {
        if (op.op === 'box' || op.op === 'erase') {
            const value = op.op === 'erase' ? 0 : slot(op.color)
            const [x0, y0, z0] = op.from
            const [x1, y1, z1] = op.to
            for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += 1)
                for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += 1)
                    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z += 1)
                        setVoxel(volume, x, y, z, value)
        } else {
            const value = slot(op.color)
            const [cx, cy, cz] = op.at
            const [rx, ry, rz] = op.r
            for (let x = cx - rx; x <= cx + rx; x += 1)
                for (let y = cy - ry; y <= cy + ry; y += 1)
                    for (let z = cz - rz; z <= cz + rz; z += 1) {
                        const dx = (x - cx) / Math.max(rx, 0.5)
                        const dy = (y - cy) / Math.max(ry, 0.5)
                        const dz = (z - cz) / Math.max(rz, 0.5)
                        if (dx * dx + dy * dy + dz * dz <= 1) setVoxel(volume, x, y, z, value)
                    }
        }
    }
    if (spec.mirror_x) {
        const before = Uint8Array.from(volume.data)
        for (let z = 0; z < sz; z += 1)
            for (let y = 0; y < sy; y += 1)
                for (let x = 0; x < sx; x += 1) {
                    const value = before[(z * sy + y) * sx + x] ?? 0
                    if (value !== 0) setVoxel(volume, sx - 1 - x, y, z, value)
                }
    }
    return volume
}

const generate = async (prompt: string): Promise<Spec> => {
    const response = await fetch('http://localhost:8080/v1/chat/completions', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            messages: [
                {role: 'system', content: SYSTEM},
                {role: 'user', content: prompt}
            ],
            max_tokens: 4096,
            temperature: 0.9,
            seed: Math.floor(Math.random() * 2 ** 31),
            response_format: {
                type: 'json_schema',
                json_schema: {name: 'vox_model', strict: true, schema: SCHEMA}
            }
        })
    })
    if (!response.ok) throw new Error(`${String(response.status)} ${await response.text()}`)
    const body = (await response.json()) as {choices?: {message?: {content?: string}}[]}
    return JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as Spec
}

/** Composited onto CLIP's neutral grey, which is what `voxrank._to_pil` did. */
const onGrey = (rgba: Uint8Array): Uint8Array => {
    const out = new Uint8Array(rgba.length)
    for (let i = 0; i < rgba.length; i += 4) {
        const a = (rgba[i + 3] ?? 0) / 255
        out[i] = Math.round((rgba[i] ?? 0) * a + 128 * (1 - a))
        out[i + 1] = Math.round((rgba[i + 1] ?? 0) * a + 128 * (1 - a))
        out[i + 2] = Math.round((rgba[i + 2] ?? 0) * a + 128 * (1 - a))
        out[i + 3] = 255
    }
    return out
}

const prompt = process.argv[2] ?? 'a stone tower'
const count = Number(process.argv[3] ?? '6')
const dir = 'out/gen-clip'

const specs: Spec[] = []
for (let i = 0; i < count; i += 1) {
    const t0 = performance.now()
    try {
        const spec = await generate(prompt)
        specs.push(spec)
        const volume = rasterise(spec)
        const filled = volume.data.reduce((n, value) => n + (value === 0 ? 0 : 1), 0)
        for (const [k, yaw] of [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4].entries()) {
            const camera = createCamera(volume, yaw, ISOMETRIC_PITCH)
            const basis = basisFor(camera, volume, 64)
            const target = render(volume, basis, 64, 64)
            await Bun.write(
                `${dir}/${String(i)}-${String(k)}.png`,
                await encodePng(64, 64, onGrey(target.color))
            )
        }
        console.log(
            `${String(i)} ${spec.name} — ${String(filled)} voxels, ${String(spec.ops.length)} ops,`,
            `${((performance.now() - t0) / 1000).toFixed(1)}s`
        )
    } catch (error) {
        console.log(`${String(i)} failed: ${String(error)}`)
    }
}
await Bun.write(`${dir}/specs.json`, JSON.stringify({prompt, specs}, null, 1))
console.log(`wrote ${String(specs.length)} candidates to ${dir}`)
