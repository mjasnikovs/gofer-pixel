import type {GenerationRecord} from '../gen/llama'
import type {NamedCamera} from './cameras'
import type {Objects} from './objects'
import {readReference, type Reference} from './reference'
import {NO_SYMMETRY, type Symmetry} from './symmetry'
import type {SheetMap} from '../sheet/sheet'
import type {Volume} from '../render/volume'
import {fromBase64, toBase64} from '../image/base64'

/**
 * The document as text — `FEATURESET.md` §32's autosave, crash recovery and snapshots all need one
 * thing first, which is a document that can be written down. It is also what a `.gpix` file on
 * disk holds, byte for byte: one format, so a snapshot and a saved file cannot drift apart.
 *
 * Run-length encoded, then base64. A voxel grid is mostly air: `car.vox`'s 16 × 10 × 7 goes from
 * 1 120 bytes to a few hundred, and a 128³ document that would be two megabytes raw is a handful of
 * kilobytes once its emptiness is counted rather than stored. That matters because one of the two
 * places this lands is `localStorage`, which gives about five megabytes for everything.
 *
 * JSON around it rather than a binary container, because a save file that can be opened in a text
 * editor is a save file whose bugs can be seen.
 */
export interface SavedDocument {
    readonly format: 'gofer-pixel/document'
    readonly version: SaveVersion
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
    /** Version 2. Reference art — `FEATURESET.md` §33. */
    readonly references: readonly Reference[]
    /** Version 2. Draw-time mirroring — `FEATURESET.md` §10. */
    readonly symmetry: Symmetry
    /** Version 2. What the sheet is packed and written as — `FEATURESET.md` §16, §37, §38. */
    readonly output: SavedOutput
    /**
     * Version 3. What generated this model, when one did — see `src/gen/llama.ts`.
     *
     * Absent on everything an artist drew or imported, which is most documents. A generated asset
     * whose prompt, seed and sampler were not written down cannot be reproduced or nudged, only
     * regenerated and hoped over — and the one place that record survives a reload is the file.
     */
    readonly origin?: GenerationRecord
}

/**
 * `1` is what shipped as the autosave-only format, and it is still read.
 *
 * Refusing an old one would throw away the crash recovery of every artist who upgrades mid-session,
 * which is the one moment `FEATURESET.md` §32 exists for. Older payloads load with the newer fields
 * at their defaults, because none of them can be inferred and a guess would be a lie about their
 * document. A v1 or v2 file has no `origin` and that is not a gap: it means nobody recorded one,
 * which is exactly what `undefined` says.
 */
export type SaveVersion = 1 | 2 | 3

export const SAVE_VERSION = 3

/**
 * The export settings, which belong to the model rather than to the session.
 *
 * An artist who packs 64 px cells with 2 px padding for one project and 32 px for the next is
 * describing the project, not a preference — so it travels in the file. `tool`, `brush`, `colour`,
 * the grid switches, the selection and the undo history deliberately do not: they describe the
 * half-hour you were having, and restoring them would be a document that opens mid-gesture.
 */
export interface SavedOutput {
    readonly cell: number
    readonly padding: number
    readonly bounds: boolean
    readonly preset: string
    readonly presets: readonly {name: string; maps: readonly SheetMap[]}[]
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

const packed = (bytes: Uint8Array): string => toBase64(rle(bytes))

/** Everything a `.gpix` holds, as the app already has it. One argument, so a new field cannot be
 * silently dropped by a caller that was written before it existed. */
export interface Document {
    readonly volume: Volume
    readonly objects: Objects
    readonly cameras: readonly NamedCamera[]
    readonly references: readonly Reference[]
    readonly symmetry: Symmetry
    readonly output: SavedOutput
    /** What generated this model, or `undefined` for one that was drawn or imported. */
    readonly origin: GenerationRecord | undefined
}

export const saveDocument = (document: Document, name: string, at = Date.now()): SavedDocument => {
    const {volume} = document
    return {
        format: 'gofer-pixel/document',
        version: SAVE_VERSION,
        at,
        name,
        size: [volume.sx, volume.sy, volume.sz],
        data: packed(volume.data),
        owner: packed(volume.owner),
        // The palette and the emissive table are 1 KB between them and mostly not runs, but they go
        // through the same path so there is one encoder to be wrong.
        palette: packed(volume.palette),
        emissive: packed(volume.emissive),
        objects: document.objects,
        cameras: document.cameras,
        references: document.references,
        symmetry: document.symmetry,
        output: document.output,
        // Omitted rather than written as `null`, so a hand-drawn document says nothing about
        // generation instead of saying it was not generated.
        ...(document.origin === undefined ? {} : {origin: document.origin})
    }
}

/**
 * `undefined` for anything that is not one of ours.
 *
 * A save that half-loads is worse than one that does not load: the artist gets a document that
 * looks like theirs with something quietly missing. So every field is checked before any of it is
 * used, and a version this build does not know is refused rather than guessed at.
 */
export interface LoadedDocument extends Document {
    readonly name: string
    readonly at: number
    /** Which version the file was written at. The header says nothing; a test does. */
    readonly version: SaveVersion
}

/**
 * What a version-1 file, and anything a version-2 file left out, becomes.
 *
 * `DEFAULT_OUTPUT` repeats the numbers `initialState` starts a document on, and repeating them is
 * deliberate: the format must be able to say what a missing field means without asking the app,
 * because the app is allowed to change its mind about a default and old files are not.
 */
export const DEFAULT_OUTPUT: SavedOutput = {
    cell: 64,
    padding: 0,
    bounds: false,
    preset: '',
    presets: []
}

const readOutput = (value: unknown): SavedOutput | undefined => {
    if (value === undefined) return DEFAULT_OUTPUT
    if (typeof value !== 'object' || value === null) return undefined
    const {cell, padding, bounds, preset, presets} = value as Record<string, unknown>
    if (typeof cell !== 'number' || !(cell > 0)) return undefined
    if (typeof padding !== 'number' || !(padding >= 0)) return undefined
    if (typeof preset !== 'string' || !Array.isArray(presets)) return undefined
    return {
        cell,
        padding,
        bounds: bounds === true,
        preset,
        presets: presets as SavedOutput['presets']
    }
}

/**
 * A generation record, or `undefined` for anything that is not a whole one.
 *
 * Whole, not partial: a record missing its seed is not a record, because the only thing it is for is
 * reproducing the model, and half a sampler cannot. Dropped rather than fatal — the voxels are the
 * document and a lost provenance line costs nobody their work.
 */
const readOrigin = (value: unknown): GenerationRecord | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const {prompt, sampler, model, at, plan, examples} = value as Record<string, unknown>
    if (typeof prompt !== 'string' || typeof model !== 'string' || typeof at !== 'string') {
        return undefined
    }
    if (typeof sampler !== 'object' || sampler === null) return undefined
    const {temperature, seed} = sampler as Record<string, unknown>
    if (typeof temperature !== 'number' || typeof seed !== 'number') return undefined
    /*
     * The examples are not part of "whole": a file written before the bank existed has none.
     *
     * A version-3 file carries `plan`, one word, from when the bank was five fixed body plans. It
     * is read as a one-element list because that is exactly what it recorded — one example, shown
     * once — so an old provenance line survives the format change instead of becoming a gap.
     */
    const shown =
        Array.isArray(examples) ?
            examples.filter((entry): entry is string => typeof entry === 'string')
        : typeof plan === 'string' ? [plan]
        : []
    return {
        prompt,
        sampler: {temperature, seed},
        model,
        at,
        ...(shown.length === 0 ? {} : {examples: shown})
    }
}

const readSymmetry = (value: unknown): Symmetry => {
    if (typeof value !== 'object' || value === null) return NO_SYMMETRY
    const {x, y, z, radial} = value as Record<string, unknown>
    return {x: x === true, y: y === true, z: z === true, radial: radial === true}
}

export const loadDocument = (text: string): LoadedDocument | undefined => {
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
    if (saved['format'] !== 'gofer-pixel/document') return undefined
    const version = saved['version']
    if (version !== 1 && version !== 2 && version !== 3) return undefined

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

    const output = readOutput(saved['output'])
    if (!output) return undefined

    /*
     * A reference that will not read is dropped, not fatal. It is art to trace over rather than the
     * model, so losing one costs a re-drop; refusing the whole file over it would cost the voxels.
     * That is the opposite call from the grid above, and the difference is what is at stake.
     */
    const references =
        saved['references'] === undefined ? []
        : Array.isArray(saved['references']) ?
            saved['references']
                .map(readReference)
                .filter((entry): entry is Reference => entry !== undefined)
        :   []

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
        references,
        symmetry: readSymmetry(saved['symmetry']),
        output,
        origin: readOrigin(saved['origin']),
        name: typeof saved['name'] === 'string' ? saved['name'] : 'Recovered',
        at: typeof saved['at'] === 'number' ? saved['at'] : 0,
        version
    }
}
