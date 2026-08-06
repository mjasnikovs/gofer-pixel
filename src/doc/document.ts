import {DEFAULT_PALETTE, packKey, unpackKey, type VoxModel} from '../vox/model'
import {writeVox} from '../vox/vox-file'
import {writeVoxScene, type SceneModel} from '../vox/vox-scene'
import {EMPTY, type Rgba} from '../vox/palette'
import type {GridSize} from '../vox/grid'
import {Volume, uniqueChunkBytes} from './volume'

/**
 * Aseprite's layer / frame / cel split. Layers organise space, frames organise time, and a cel is
 * the content at one intersection — a null cel is an empty one, which is not the same as a layer
 * being invisible.
 *
 * Everything here is immutable by convention: an operation returns a new `Document` that shares
 * every untouched layer, cel and chunk with the old one. That is what makes an undo entry a bare
 * object reference rather than a copy of the model.
 */
export interface LayerOffset {
    x: number
    y: number
    z: number
}

export interface Layer {
    readonly id: string
    readonly name: string
    readonly visible: boolean
    readonly locked: boolean
    /** 0–1. Applied at composite time, never baked into voxels. */
    readonly opacity: number
    readonly offset: LayerOffset
    readonly cels: readonly (Volume | null)[]
}

/** A named frame range — `walk`, `idle` — that becomes an animation clip on export. */
export interface Tag {
    readonly name: string
    readonly from: number
    readonly to: number
}

/**
 * A named shading ramp: palette indices ordered dark to light.
 *
 * First-class rather than "swatches that happen to sit next to each other" for two reasons. The
 * shading tool steps along one instead of picking colours, and the generator can be told to emit
 * ramp positions rather than free hex, which is what keeps generated assets on-palette.
 */
export interface Ramp {
    readonly name: string
    readonly indices: readonly number[]
}

/**
 * How a generated document came to exist: the prompt, the sampler and the server that answered.
 *
 * Kept on the document rather than in a side table because it has to survive save and load — an
 * asset whose seed was not recorded cannot be reproduced or nudged, only regenerated and hoped
 * over, which is `DESIGN_PROGRESS.md`'s open question 5.
 */
export interface DocumentOrigin {
    readonly prompt: string
    readonly sampler: {
        readonly temperature: number
        readonly seed: number
        readonly topP?: number
        readonly topK?: number
    }
    readonly model: string
    readonly at: string
}

export interface Document {
    readonly size: GridSize
    readonly palette: readonly Rgba[]
    readonly layers: readonly Layer[]
    readonly frames: number
    readonly tags: readonly Tag[]
    readonly ramps: readonly Ramp[]
    readonly name: string
    /** Absent for a document a person drew by hand. */
    readonly origin?: DocumentOrigin
}

let layerSerial = 0
const nextLayerId = (): string => {
    layerSerial += 1
    return `layer-${String(layerSerial)}`
}

export interface DocumentInit {
    size?: Partial<GridSize>
    palette?: readonly Rgba[]
    name?: string
}

export const createLayer = (name: string, frames: number): Layer => ({
    id: nextLayerId(),
    name,
    visible: true,
    locked: false,
    opacity: 1,
    offset: {x: 0, y: 0, z: 0},
    cels: Array.from({length: frames}, () => null)
})

export const createDocument = ({size, palette, name}: DocumentInit = {}): Document => ({
    size: {sx: size?.sx ?? 32, sy: size?.sy ?? 32, sz: size?.sz ?? 32},
    palette: palette ?? DEFAULT_PALETTE,
    layers: [createLayer('Layer 1', 1)],
    frames: 1,
    tags: [],
    ramps: [],
    name: name ?? 'untitled'
})

const withLayers = (doc: Document, layers: readonly Layer[]): Document => ({...doc, layers})

const replaceAt = <T>(items: readonly T[], index: number, value: T): T[] => {
    const copy = [...items]
    copy[index] = value
    return copy
}

export const layerAt = (doc: Document, index: number): Layer | undefined => doc.layers[index]

export const celAt = (doc: Document, layerIndex: number, frame: number): Volume | null =>
    doc.layers[layerIndex]?.cels[frame] ?? null

/**
 * The only way voxels change.
 *
 * The cel is cloned once, `edit` mutates that clone freely, and the result replaces the cel in a
 * new document. A whole drag is one call, which is what "snapshot on commit, not on every mouse
 * move" means in practice. A locked layer is a silent no-op — callers check `locked` to grey a
 * tool out; this is the backstop.
 */
export const editCel = (
    doc: Document,
    layerIndex: number,
    frame: number,
    edit: (volume: Volume) => void
): Document => {
    const layer = doc.layers[layerIndex]
    if (!layer || layer.locked || frame < 0 || frame >= doc.frames) {
        return doc
    }
    const volume = (layer.cels[frame] ?? new Volume()).clone()
    edit(volume)
    return withLayers(
        doc,
        replaceAt(doc.layers, layerIndex, {...layer, cels: replaceAt(layer.cels, frame, volume)})
    )
}

export const updateLayer = (
    doc: Document,
    index: number,
    patch: Partial<Omit<Layer, 'id' | 'cels'>>
): Document => {
    const layer = doc.layers[index]
    return layer ? withLayers(doc, replaceAt(doc.layers, index, {...layer, ...patch})) : doc
}

export const addLayer = (doc: Document, name?: string): Document =>
    withLayers(doc, [
        ...doc.layers,
        createLayer(name ?? `Layer ${String(doc.layers.length + 1)}`, doc.frames)
    ])

/** Removing the last layer is refused — a document with no layer has nowhere to draw. */
export const removeLayer = (doc: Document, index: number): Document =>
    doc.layers.length > 1 && doc.layers[index] ?
        withLayers(
            doc,
            doc.layers.filter((_unused, i) => i !== index)
        )
    :   doc

export const moveLayer = (doc: Document, from: number, to: number): Document => {
    const layer = doc.layers[from]
    if (!layer || to < 0 || to >= doc.layers.length || from === to) {
        return doc
    }
    const rest = doc.layers.filter((_unused, i) => i !== from)
    return withLayers(doc, [...rest.slice(0, to), layer, ...rest.slice(to)])
}

/** Insert an empty frame at `at` (default: the end). Tags spanning the insertion point stretch. */
export const addFrame = (doc: Document, at?: number): Document => {
    const index = Math.min(Math.max(at ?? doc.frames, 0), doc.frames)
    return {
        ...doc,
        frames: doc.frames + 1,
        layers: doc.layers.map(layer => ({
            ...layer,
            cels: [...layer.cels.slice(0, index), null, ...layer.cels.slice(index)]
        })),
        tags: doc.tags.map(tag => ({
            ...tag,
            from: tag.from >= index ? tag.from + 1 : tag.from,
            to: tag.to >= index ? tag.to + 1 : tag.to
        }))
    }
}

/** Copy frame `at` into a new frame directly after it. The cels are shared, not copied. */
export const duplicateFrame = (doc: Document, at: number): Document => {
    if (at < 0 || at >= doc.frames) {
        return doc
    }
    const inserted = addFrame(doc, at + 1)
    return {
        ...inserted,
        layers: inserted.layers.map(layer => ({
            ...layer,
            cels: replaceAt(layer.cels, at + 1, layer.cels[at] ?? null)
        }))
    }
}

export const removeFrame = (doc: Document, at: number): Document => {
    if (doc.frames <= 1 || at < 0 || at >= doc.frames) {
        return doc
    }
    return {
        ...doc,
        frames: doc.frames - 1,
        layers: doc.layers.map(layer => ({
            ...layer,
            cels: layer.cels.filter((_unused, i) => i !== at)
        })),
        tags: doc.tags
            .map(tag => ({
                ...tag,
                from: tag.from > at ? tag.from - 1 : tag.from,
                to: tag.to >= at ? tag.to - 1 : tag.to
            }))
            .filter(tag => tag.to >= tag.from)
    }
}

/**
 * A tag can only name frames that exist, and its ends are stored in order — the frame bar lets a
 * person drag either end past the other, and a reversed range would silently export an empty clip.
 */
const normalizeTag = (doc: Document, tag: Tag): Tag => {
    const last = doc.frames - 1
    const clamp = (value: number): number => Math.max(0, Math.min(last, Math.round(value)))
    const from = clamp(tag.from)
    const to = clamp(tag.to)
    return {name: tag.name, from: Math.min(from, to), to: Math.max(from, to)}
}

/** Names are the handle for a tag, so adding one that already exists replaces it rather than
 * leaving two clips called `walk` that export over each other. */
export const addTag = (doc: Document, tag: Tag): Document => ({
    ...doc,
    tags: [...doc.tags.filter(existing => existing.name !== tag.name), normalizeTag(doc, tag)]
})

/** Rename a tag or move its range. A rename onto a name already in use is refused, not merged. */
export const updateTag = (doc: Document, name: string, patch: Partial<Tag>): Document => {
    const index = doc.tags.findIndex(tag => tag.name === name)
    const existing = doc.tags[index]
    if (!existing) {
        return doc
    }
    const next = normalizeTag(doc, {...existing, ...patch})
    if (next.name !== name && doc.tags.some(tag => tag.name === next.name)) {
        return doc
    }
    return {...doc, tags: replaceAt(doc.tags, index, next)}
}

export const removeTag = (doc: Document, name: string): Document => ({
    ...doc,
    tags: doc.tags.filter(tag => tag.name !== name)
})

/** Every tag covering a frame, in document order. */
export const tagsAt = (doc: Document, frame: number): Tag[] =>
    doc.tags.filter(tag => frame >= tag.from && frame <= tag.to)

/** A name no existing tag uses: `tag`, then `tag 2`, `tag 3`… */
export const uniqueTagName = (doc: Document, base = 'tag'): string => {
    const taken = new Set(doc.tags.map(tag => tag.name))
    if (!taken.has(base)) {
        return base
    }
    let n = 2
    while (taken.has(`${base} ${String(n)}`)) {
        n += 1
    }
    return `${base} ${String(n)}`
}

export const setPalette = (doc: Document, palette: readonly Rgba[]): Document => ({...doc, palette})

export const addRamp = (doc: Document, ramp: Ramp): Document => ({
    ...doc,
    ramps: [...doc.ramps.filter(existing => existing.name !== ramp.name), ramp]
})

export const removeRamp = (doc: Document, name: string): Document => ({
    ...doc,
    ramps: doc.ramps.filter(ramp => ramp.name !== name)
})

/**
 * Composite the visible layers of one frame into a single volume, bottom layer first.
 *
 * Opacity does not apply here: a voxel is present or it is not. A partly transparent layer is a
 * preview-time effect, so the renderer gets told about it separately rather than having it
 * silently baked into geometry.
 */
export const flattenFrame = (doc: Document, frame: number): Volume => {
    const out = new Volume()
    for (const layer of doc.layers) {
        if (!layer.visible) {
            continue
        }
        const cel = layer.cels[frame]
        if (cel) {
            out.paste(cel, layer.offset.x, layer.offset.y, layer.offset.z)
        }
    }
    return out
}

/**
 * A frame as a `VoxModel`, so everything in `src/vox` — rotation sheets, normal maps, slice
 * strips — works on an edited document with no second renderer.
 */
export const frameToModel = (doc: Document, frame: number): VoxModel => {
    const voxels = new Map<number, number>()
    flattenFrame(doc, frame).forEach((x, y, z, color) => {
        if (color !== EMPTY && x < doc.size.sx && y < doc.size.sy && z < doc.size.sz) {
            voxels.set(packKey(x, y, z), color)
        }
    })
    return {sx: doc.size.sx, sy: doc.size.sy, sz: doc.size.sz, voxels, palette: doc.palette}
}

/** A frame as a `.vox` file, flattened to one model. */
export const frameToVox = (doc: Document, frame: number): Uint8Array =>
    writeVox(frameToModel(doc, frame))

/**
 * One `VoxModel` per layer of a frame, keeping the layers apart.
 *
 * An invisible layer is still exported — as a hidden one — because a layer you have turned off is
 * still part of the document, and dropping it on export is the kind of helpfulness that loses
 * work.
 */
export const frameToVoxScene = (doc: Document, frame: number): SceneModel[] =>
    doc.layers.map(layer => {
        const voxels = new Map<number, number>()
        layer.cels[frame]?.forEach((x, y, z, color) => {
            if (color !== EMPTY && x < doc.size.sx && y < doc.size.sy && z < doc.size.sz) {
                voxels.set(packKey(x, y, z), color)
            }
        })
        return {
            model: {
                sx: doc.size.sx,
                sy: doc.size.sy,
                sz: doc.size.sz,
                voxels,
                palette: doc.palette
            },
            name: layer.name,
            offset: [layer.offset.x, layer.offset.y, layer.offset.z] as [number, number, number],
            hidden: !layer.visible
        }
    })

/** A frame as a multi-model `.vox`, one model per layer, with the layer names and visibility. */
export const frameToLayeredVox = (doc: Document, frame: number): Uint8Array =>
    writeVoxScene(frameToVoxScene(doc, frame))

/**
 * A parsed `.vox` as a fresh single-layer document — how a generated or imported model enters
 * the editor. The palette comes with it, since a `.vox` always carries one.
 */
export const documentFromModel = (
    model: VoxModel,
    name = 'imported',
    origin?: DocumentOrigin
): Document => {
    const doc: Document = {
        ...createDocument({
            size: {sx: model.sx, sy: model.sy, sz: model.sz},
            palette: model.palette,
            name
        }),
        ...(origin ? {origin} : {})
    }
    return editCel(doc, 0, 0, volume => {
        for (const [key, color] of model.voxels) {
            const [x, y, z] = unpackKey(key)
            volume.set(x, y, z, color)
        }
    })
}

/**
 * A multi-model `.vox` back into a document with one layer per model — the other half of
 * `frameToLayeredVox`, so a layered export is a round trip rather than a one-way door.
 *
 * The layer names and visibility come from the file's `LAYR` chunks where the transforms name
 * them, falling back to positional names for a file written by something that did not.
 */
export const documentFromScene = (
    models: readonly VoxModel[],
    layers: readonly {id: number; name: string; hidden: boolean}[],
    modelLayer: ReadonlyMap<number, number>,
    name = 'imported'
): Document => {
    const first = models[0]
    if (!first) {
        throw new Error('a scene needs at least one model')
    }
    const size = {
        sx: Math.max(...models.map(model => model.sx)),
        sy: Math.max(...models.map(model => model.sy)),
        sz: Math.max(...models.map(model => model.sz))
    }
    const byId = new Map(layers.map(layer => [layer.id, layer]))

    let doc: Document = {
        ...createDocument({size, palette: first.palette, name}),
        layers: models.map((_unused, i) => {
            const info = byId.get(modelLayer.get(i) ?? i)
            return {
                ...createLayer(info?.name ?? `Layer ${String(i + 1)}`, 1),
                visible: !(info?.hidden ?? false)
            }
        })
    }

    models.forEach((model, index) => {
        doc = editCel(doc, index, 0, volume => {
            for (const [key, color] of model.voxels) {
                const [x, y, z] = unpackKey(key)
                volume.set(x, y, z, color)
            }
        })
    })
    return doc
}

/** Every distinct volume the document references, for memory accounting. */
export const documentVolumes = (doc: Document): Volume[] => {
    const seen = new Set<Volume>()
    for (const layer of doc.layers) {
        for (const cel of layer.cels) {
            if (cel) {
                seen.add(cel)
            }
        }
    }
    return [...seen]
}

/** Voxel bytes held by a set of documents, counting a chunk shared between snapshots once. */
export const documentBytes = (docs: Iterable<Document>): number =>
    uniqueChunkBytes([...docs].flatMap(documentVolumes))
