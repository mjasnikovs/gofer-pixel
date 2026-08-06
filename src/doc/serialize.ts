import type {GridSize} from '../vox/grid'
import type {Rgba} from '../vox/palette'
import {
    createLayer,
    type Document,
    type DocumentOrigin,
    type Layer,
    type Ramp,
    type Tag
} from './document'
import {Volume} from './volume'

/**
 * The project file: JSON, one object, no binary sidecars.
 *
 * A cel is run-length encoded over the canvas in x-fastest order and base64'd. Sprite volumes are
 * mostly empty and mostly flat colour, so runs beat both a dense dump and a coordinate list, and
 * unlike a coordinate list the size does not grow with how full the model is. It stays a text
 * format so a project diffs, greps and survives a merge conflict.
 *
 * `version` is checked on load. Bump it when the shape changes and add a migration; silently
 * accepting an unknown version is how a save file corrupts a day of work.
 */
export const PROJECT_VERSION = 2

export interface SerializedLayer {
    id: string
    name: string
    visible: boolean
    locked: boolean
    opacity: number
    offset: {x: number; y: number; z: number}
    /** One entry per frame; null is an empty cel. */
    cels: (string | null)[]
}

export interface SerializedDocument {
    version: number
    name: string
    size: GridSize
    /** `#rrggbbaa`, 256 of them at most. */
    palette: string[]
    frames: number
    tags: Tag[]
    ramps: Ramp[]
    layers: SerializedLayer[]
    /** Version 2 and later. Absent on a hand-drawn document and on every version 1 file. */
    origin?: DocumentOrigin
}

const hex2 = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, '0')

export const colorToHex = ({r, g, b, a}: Rgba): string =>
    `#${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a)}`

export const colorFromHex = (text: string): Rgba => {
    const body = text.replace('#', '')
    const pair = (i: number): number => parseInt(body.slice(i * 2, i * 2 + 2) || '0', 16)
    return {r: pair(0), g: pair(1), b: pair(2), a: body.length >= 8 ? pair(3) : 255}
}

/** `btoa`/`atob` exist in browsers, Bun and Node, and `Buffer` does not exist in the first. */
const toBase64 = (bytes: Uint8Array): string =>
    btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))

const fromBase64 = (text: string): Uint8Array =>
    Uint8Array.from(atob(text), character => character.charCodeAt(0))

/** Pairs of (run length 1–255, palette index). A longer run is split across pairs. */
const encodeRuns = (cells: Uint8Array): Uint8Array => {
    const out: number[] = []
    let i = 0
    while (i < cells.length) {
        const value = cells[i] ?? 0
        let run = 1
        while (i + run < cells.length && cells[i + run] === value) {
            run += 1
        }
        i += run
        while (run > 0) {
            const step = Math.min(run, 255)
            out.push(step, value)
            run -= step
        }
    }
    return new Uint8Array(out)
}

const decodeRuns = (bytes: Uint8Array, length: number): Uint8Array => {
    const cells = new Uint8Array(length)
    let at = 0
    for (let i = 0; i + 1 < bytes.length && at < length; i += 2) {
        const run = bytes[i] ?? 0
        cells.fill(bytes[i + 1] ?? 0, at, Math.min(at + run, length))
        at += run
    }
    return cells
}

export const encodeVolume = (volume: Volume, {sx, sy, sz}: GridSize): string => {
    const cells = new Uint8Array(sx * sy * sz)
    volume.forEach((x, y, z, color) => {
        if (x < sx && y < sy && z < sz) {
            cells[(z * sy + y) * sx + x] = color
        }
    })
    return toBase64(encodeRuns(cells))
}

export const decodeVolume = (text: string, {sx, sy, sz}: GridSize): Volume => {
    const cells = decodeRuns(fromBase64(text), sx * sy * sz)
    const volume = new Volume()
    for (let z = 0; z < sz; z += 1) {
        for (let y = 0; y < sy; y += 1) {
            for (let x = 0; x < sx; x += 1) {
                volume.set(x, y, z, cells[(z * sy + y) * sx + x] ?? 0)
            }
        }
    }
    return volume
}

export const serializeDocument = (doc: Document): SerializedDocument => ({
    version: PROJECT_VERSION,
    name: doc.name,
    size: doc.size,
    palette: doc.palette.map(colorToHex),
    frames: doc.frames,
    tags: doc.tags.map(tag => ({...tag})),
    ramps: doc.ramps.map(ramp => ({name: ramp.name, indices: [...ramp.indices]})),
    layers: doc.layers.map(layer => ({
        id: layer.id,
        name: layer.name,
        visible: layer.visible,
        locked: layer.locked,
        opacity: layer.opacity,
        offset: {...layer.offset},
        cels: layer.cels.map(cel => (cel ? encodeVolume(cel, doc.size) : null))
    })),
    ...(doc.origin ? {origin: doc.origin} : {})
})

/**
 * Bring an older file up to the current shape.
 *
 * Version 1 → 2 added `origin` (the prompt, seed and sampler behind a generated asset). A version
 * 1 file simply predates the generator, so the migration is to say so rather than to invent one.
 */
const migrate = (data: SerializedDocument): SerializedDocument =>
    data.version === 1 ? {...data, version: 2} : data

export const deserializeDocument = (stored: SerializedDocument): Document => {
    const data = migrate(stored)
    if (data.version !== PROJECT_VERSION) {
        throw new Error(
            `project version ${String(stored.version)} is not ${String(PROJECT_VERSION)} — no migration exists`
        )
    }
    const size = data.size
    const layers: Layer[] = data.layers.map(raw => ({
        ...createLayer(raw.name, data.frames),
        id: raw.id,
        visible: raw.visible,
        locked: raw.locked,
        opacity: raw.opacity,
        offset: {...raw.offset},
        cels: raw.cels.map(cel => (cel === null ? null : decodeVolume(cel, size)))
    }))

    return {
        size,
        palette: data.palette.map(colorFromHex),
        layers: layers.length > 0 ? layers : [createLayer('Layer 1', data.frames)],
        frames: data.frames,
        tags: data.tags.map(tag => ({...tag})),
        ramps: data.ramps.map(ramp => ({name: ramp.name, indices: [...ramp.indices]})),
        name: data.name,
        ...(data.origin ? {origin: data.origin} : {})
    }
}

export const saveProject = (doc: Document): string => JSON.stringify(serializeDocument(doc))

export const loadProject = (text: string): Document =>
    deserializeDocument(JSON.parse(text) as SerializedDocument)
