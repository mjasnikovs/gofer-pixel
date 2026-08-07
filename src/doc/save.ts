import type {NamedCamera} from './cameras'
import type {Objects} from './objects'
import type {Volume} from '../render/volume'

/**
 * The document as text — `FEATURESET.md` §32's autosave, crash recovery and snapshots all need one
 * thing first, which is a document that can be written down.
 *
 * Run-length encoded, then base64. A voxel grid is mostly air: `car.vox`'s 16 × 10 × 7 goes from
 * 1 120 bytes to a few hundred, and a 128³ document that would be two megabytes raw is a handful of
 * kilobytes once its emptiness is counted rather than stored. That matters because the place this
 * lands is `localStorage`, which gives about five megabytes for everything.
 *
 * JSON around it rather than a binary container, because a save file that can be opened in a text
 * editor is a save file whose bugs can be seen.
 */
export interface SavedDocument {
    readonly format: 'gofer-pixel/document'
    readonly version: 1
    /** Milliseconds since the epoch, so a recovery can say how old it is. */
    readonly at: number
    readonly name: string
    readonly size: readonly [number, number, number]
    readonly data: string
    readonly owner: string
    readonly palette: string
    readonly emissive: string
    readonly objects: Objects
    readonly cameras: readonly NamedCamera[]
}

/** `value` then a 16-bit count, little-endian. Runs longer than that are split rather than lost. */
const rle = (bytes: Uint8Array): Uint8Array => {
    const out: number[] = []
    let index = 0
    while (index < bytes.length) {
        const value = bytes[index] ?? 0
        let run = 1
        while (index + run < bytes.length && bytes[index + run] === value && run < 0xffff) run += 1
        out.push(value, run & 0xff, run >> 8)
        index += run
    }
    return Uint8Array.from(out)
}

const unrle = (packed: Uint8Array, length: number): Uint8Array => {
    const out = new Uint8Array(length)
    let at = 0
    for (let i = 0; i + 2 < packed.length + 1 && at < length; i += 3) {
        const value = packed[i] ?? 0
        const run = (packed[i + 1] ?? 0) | ((packed[i + 2] ?? 0) << 8)
        for (let k = 0; k < run && at < length; k += 1) {
            out[at] = value
            at += 1
        }
    }
    return out
}

/** Chunked, because `String.fromCharCode(...bytes)` on a megabyte blows the argument stack. */
const toBase64 = (bytes: Uint8Array): string => {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return btoa(binary)
}

const fromBase64 = (text: string): Uint8Array => {
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
}

const packed = (bytes: Uint8Array): string => toBase64(rle(bytes))

export const saveDocument = (
    volume: Volume,
    objects: Objects,
    cameras: readonly NamedCamera[],
    name: string,
    at = Date.now()
): SavedDocument => ({
    format: 'gofer-pixel/document',
    version: 1,
    at,
    name,
    size: [volume.sx, volume.sy, volume.sz],
    data: packed(volume.data),
    owner: packed(volume.owner),
    // The palette and the emissive table are 1 KB between them and mostly not runs, but they go
    // through the same path so there is one encoder to be wrong.
    palette: packed(volume.palette),
    emissive: packed(volume.emissive),
    objects,
    cameras
})

/**
 * `undefined` for anything that is not one of ours.
 *
 * A save that half-loads is worse than one that does not load: the artist gets a document that
 * looks like theirs with something quietly missing. So every field is checked before any of it is
 * used, and a version this build does not know is refused rather than guessed at.
 */
export const loadDocument = (
    text: string
):
    | {volume: Volume; objects: Objects; cameras: readonly NamedCamera[]; name: string; at: number}
    | undefined => {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return undefined
    }
    // Read as `unknown` and narrowed field by field. Casting the parse straight to the saved shape
    // would tell the type checker that a file on disk is already the thing we hope it is, and every
    // check below would then be dead code it was entitled to remove.
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const saved: Record<string, unknown> = {...parsed}
    if (saved['format'] !== 'gofer-pixel/document' || saved['version'] !== 1) return undefined

    const size = saved['size']
    if (!Array.isArray(size) || size.length !== 3) return undefined
    const [sx, sy, sz] = size as unknown[]
    if (typeof sx !== 'number' || typeof sy !== 'number' || typeof sz !== 'number') return undefined
    if (!(sx > 0 && sy > 0 && sz > 0)) return undefined

    const {data, owner, palette, emissive, objects, cameras} = saved
    if (
        typeof data !== 'string'
        || typeof owner !== 'string'
        || typeof palette !== 'string'
        || typeof emissive !== 'string'
        || typeof objects !== 'object'
        || objects === null
        || !Array.isArray(cameras)
    ) {
        return undefined
    }

    return {
        volume: {
            sx,
            sy,
            sz,
            data: unrle(fromBase64(data), sx * sy * sz),
            owner: unrle(fromBase64(owner), sx * sy * sz),
            palette: unrle(fromBase64(palette), 256 * 4),
            emissive: unrle(fromBase64(emissive), 256)
        },
        objects: objects as Objects,
        cameras: cameras as readonly NamedCamera[],
        name: typeof saved['name'] === 'string' ? saved['name'] : 'Recovered',
        at: typeof saved['at'] === 'number' ? saved['at'] : 0
    }
}
