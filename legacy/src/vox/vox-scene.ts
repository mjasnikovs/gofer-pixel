import {packKey, unpackKey, type VoxModel} from './model'
import type {Rgba} from './palette'

/**
 * The `.vox` extension chunks: the `nTRN`/`nGRP`/`nSHP` scene graph and `LAYR`, so a multi-layer
 * document exports as multiple models with their layer names instead of one flattened brick.
 *
 * Written from the raw extension specification rather than a summary, which
 * `PRODUCTION_PLAN.md` §14 asked for explicitly. The parts that matter and are easy to get wrong:
 *
 * - `STRING` is `int32` length then that many bytes, **no trailing NUL**.
 * - `DICT` is `int32` pair count then key/value `STRING`s — so every value is text, including the
 *   numeric ones: `_t` is `"x y z"` and `_r` is the decimal form of the rotation byte.
 * - A file may hold many `SIZE`/`XYZI` pairs and **a model's id is its index in stored order**.
 *   There is still only one `RGBA`; the palette is per file, not per model.
 * - The graph must be Transform → Group → Transform → Shape. A shape hangs off its own transform;
 *   a group cannot own a shape directly.
 * - The rotation byte is a row-major matrix in a bit-field: bits 0–1 index the non-zero entry of
 *   the first row, bits 2–3 the second, and bits 4–6 are the three signs. Identity is therefore
 *   `0b0000_0100` = 4, which is why every file in the wild has `_r : 4`.
 */
export interface SceneModel {
    model: VoxModel
    /** Layer name, written into `LAYR`. */
    name?: string
    /** Whole-voxel offset of this model's centre from the world origin. */
    offset?: [number, number, number]
    hidden?: boolean
}

const TRANSPARENT: Rgba = {r: 0, g: 0, b: 0, a: 0}

/** The identity rotation, as the spec's bit-field packs it. */
export const IDENTITY_ROTATION = 4

const encoder = new TextEncoder()

const chunk = (
    tag: string,
    content: Uint8Array,
    children: Uint8Array = new Uint8Array(0)
): Uint8Array => {
    const out = new Uint8Array(12 + content.length + children.length)
    const view = new DataView(out.buffer)
    for (let i = 0; i < 4; i += 1) {
        out[i] = tag.charCodeAt(i)
    }
    view.setInt32(4, content.length, true)
    view.setInt32(8, children.length, true)
    out.set(content, 12)
    out.set(children, 12 + content.length)
    return out
}

const concat = (parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
    let at = 0
    for (const part of parts) {
        out.set(part, at)
        at += part.length
    }
    return out
}

const int32 = (value: number): Uint8Array => {
    const out = new Uint8Array(4)
    new DataView(out.buffer).setInt32(0, value, true)
    return out
}

const voxString = (text: string): Uint8Array => {
    const bytes = encoder.encode(text)
    return concat([int32(bytes.length), bytes])
}

const dict = (entries: readonly [string, string][]): Uint8Array =>
    concat([
        int32(entries.length),
        ...entries.flatMap(([key, value]) => [voxString(key), voxString(value)])
    ])

/**
 * One `nTRN` with a single frame — the only kind this writes. Multi-frame transforms are for
 * MagicaVoxel's own keyframe animation, which is a different thing from our frames and is not
 * something a round trip through here would preserve.
 */
const transformNode = (
    nodeId: number,
    childId: number,
    layerId: number,
    offset: [number, number, number],
    name?: string
): Uint8Array =>
    chunk(
        'nTRN',
        concat([
            int32(nodeId),
            dict(name === undefined ? [] : [['_name', name]]),
            int32(childId),
            int32(-1), // reserved, must be -1
            int32(layerId),
            int32(1), // one frame
            dict([
                ['_r', String(IDENTITY_ROTATION)],
                ['_t', offset.join(' ')]
            ])
        ])
    )

const groupNode = (nodeId: number, children: readonly number[]): Uint8Array =>
    chunk('nGRP', concat([int32(nodeId), dict([]), int32(children.length), ...children.map(int32)]))

const shapeNode = (nodeId: number, modelId: number): Uint8Array =>
    chunk(
        'nSHP',
        concat([
            int32(nodeId),
            dict([]),
            int32(1), // one model
            int32(modelId),
            dict([])
        ])
    )

const layerChunk = (layerId: number, name: string, hidden: boolean): Uint8Array =>
    chunk(
        'LAYR',
        concat([
            int32(layerId),
            dict([
                ['_name', name],
                ['_hidden', hidden ? '1' : '0']
            ]),
            int32(-1) // reserved, must be -1
        ])
    )

const sizeChunk = ({sx, sy, sz}: VoxModel): Uint8Array =>
    chunk('SIZE', concat([int32(sx), int32(sy), int32(sz)]))

const xyziChunk = ({voxels}: VoxModel): Uint8Array => {
    const body = new Uint8Array(4 + voxels.size * 4)
    new DataView(body.buffer).setInt32(0, voxels.size, true)
    let at = 4
    for (const [key, color] of voxels) {
        const [x, y, z] = unpackKey(key)
        body.set([x, y, z, color], at)
        at += 4
    }
    return chunk('XYZI', body)
}

const rgbaChunk = (palette: readonly Rgba[]): Uint8Array => {
    const body = new Uint8Array(256 * 4)
    for (let i = 0; i < 256; i += 1) {
        const {r, g, b, a} = palette[i] ?? TRANSPARENT
        body.set([r, g, b, a], i * 4)
    }
    return chunk('RGBA', body)
}

/**
 * Write several models as one `.vox` with a scene graph and one layer each.
 *
 * The palette is the first model's — the format has one `RGBA` per file, so exporting layers that
 * disagree about their palette is not a thing the format can express, and quietly merging them
 * would renumber voxels behind the caller's back.
 */
export const writeVoxScene = (models: readonly SceneModel[]): Uint8Array => {
    if (models.length === 0) {
        throw new Error('a scene needs at least one model')
    }

    // node ids: 0 is the root transform, 1 the group, then a transform/shape pair per model
    const rootId = 0
    const groupId = 1
    const childTransforms = models.map((_unused, i) => 2 + i * 2)

    const graph = concat([
        transformNode(rootId, groupId, -1, [0, 0, 0]),
        groupNode(groupId, childTransforms),
        ...models.flatMap((entry, i) => [
            transformNode(
                2 + i * 2,
                3 + i * 2,
                i,
                entry.offset ?? [0, 0, 0],
                entry.name ?? `layer ${String(i + 1)}`
            ),
            shapeNode(3 + i * 2, i)
        ])
    ])

    const layers = concat(
        models.map((entry, i) =>
            layerChunk(i, entry.name ?? `layer ${String(i + 1)}`, entry.hidden ?? false)
        )
    )

    const first = models[0]
    if (!first) {
        throw new Error('a scene needs at least one model')
    }

    const header = new Uint8Array(8)
    header.set([0x56, 0x4f, 0x58, 0x20]) // 'VOX '
    new DataView(header.buffer).setInt32(4, 150, true)

    const body = concat([
        ...models.flatMap(entry => [sizeChunk(entry.model), xyziChunk(entry.model)]),
        rgbaChunk(first.model.palette),
        graph,
        layers
    ])
    return concat([header, chunk('MAIN', new Uint8Array(0), body)])
}

export interface SceneLayer {
    id: number
    name: string
    hidden: boolean
}

export interface VoxScene {
    models: VoxModel[]
    layers: SceneLayer[]
    /** Model id → the layer id its transform names, where the file says so. */
    modelLayer: Map<number, number>
}

const tagAt = (view: DataView, offset: number): string =>
    String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
    )

const decoder = new TextDecoder()

const readString = (view: DataView, at: number): {text: string; next: number} => {
    const length = view.getInt32(at, true)
    const bytes = new Uint8Array(view.buffer, view.byteOffset + at + 4, length)
    return {text: decoder.decode(bytes), next: at + 4 + length}
}

const readDict = (view: DataView, at: number): {entries: Map<string, string>; next: number} => {
    const count = view.getInt32(at, true)
    let cursor = at + 4
    const entries = new Map<string, string>()
    for (let i = 0; i < count; i += 1) {
        const key = readString(view, cursor)
        const value = readString(view, key.next)
        entries.set(key.text, value.text)
        cursor = value.next
    }
    return {entries, next: cursor}
}

/**
 * Read a `.vox` as a scene: every model, every layer, and which layer each model belongs to.
 *
 * `readVox` in `vox-file.ts` stays as it is — it merges every model into one volume, which is what
 * a caller that just wants "the model" means. This is for the caller that wants the layers back.
 */
export const readVoxScene = (bytes: Uint8Array): VoxScene => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (tagAt(view, 0) !== 'VOX ') {
        throw new Error('not a .vox file')
    }

    const sizes: [number, number, number][] = []
    const voxelSets: Map<number, number>[] = []
    const layers: SceneLayer[] = []
    const modelLayer = new Map<number, number>()
    // shape node id → model id, so a transform's layer can be attributed once both are seen
    const shapeModel = new Map<number, number>()
    const transforms: {child: number; layer: number}[] = []
    let palette: Rgba[] | null = null

    let pos = 8 + 12
    while (pos + 12 <= bytes.length) {
        const id = tagAt(view, pos)
        const contentBytes = view.getInt32(pos + 4, true)
        const childBytes = view.getInt32(pos + 8, true)
        const body = pos + 12

        if (id === 'SIZE') {
            sizes.push([
                view.getInt32(body, true),
                view.getInt32(body + 4, true),
                view.getInt32(body + 8, true)
            ])
        } else if (id === 'XYZI') {
            const count = view.getInt32(body, true)
            const voxels = new Map<number, number>()
            for (let i = 0; i < count; i += 1) {
                const at = body + 4 + i * 4
                voxels.set(
                    packKey(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2)),
                    view.getUint8(at + 3)
                )
            }
            voxelSets.push(voxels)
        } else if (id === 'RGBA') {
            palette = Array.from({length: 256}, (_unused, i) => ({
                r: view.getUint8(body + i * 4),
                g: view.getUint8(body + i * 4 + 1),
                b: view.getUint8(body + i * 4 + 2),
                a: view.getUint8(body + i * 4 + 3)
            }))
        } else if (id === 'LAYR') {
            const layerId = view.getInt32(body, true)
            const {entries} = readDict(view, body + 4)
            layers.push({
                id: layerId,
                name: entries.get('_name') ?? `layer ${String(layerId + 1)}`,
                hidden: entries.get('_hidden') === '1'
            })
        } else if (id === 'nTRN') {
            const after = readDict(view, body + 4)
            const child = view.getInt32(after.next, true)
            const layer = view.getInt32(after.next + 8, true)
            transforms.push({child, layer})
        } else if (id === 'nSHP') {
            const after = readDict(view, body + 4)
            const models = view.getInt32(after.next, true)
            if (models > 0) {
                shapeModel.set(view.getInt32(body, true), view.getInt32(after.next + 4, true))
            }
        }

        pos = body + contentBytes + childBytes
    }

    for (const {child, layer} of transforms) {
        const model = shapeModel.get(child)
        if (model !== undefined && layer >= 0) {
            modelLayer.set(model, layer)
        }
    }

    const models = sizes.map((size, i) => ({
        sx: size[0],
        sy: size[1],
        sz: size[2],
        voxels: voxelSets[i] ?? new Map<number, number>(),
        palette: palette ?? []
    }))

    return {models, layers, modelLayer}
}
