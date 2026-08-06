import {readVox} from '../vox/vox-file'
import {readVoxScene, type VoxScene} from '../vox/vox-scene'
import type {VoxModel} from '../vox/model'
import type {Rgba} from '../vox/palette'
import {decodePng} from '../image/png'
import {decodePalette, fromStrip} from '../doc/palette-formats'

/**
 * Deciding what a dropped file *is*, kept out of the React layer so it can be tested without a
 * browser. A `.vox` is sniffed by its magic bytes rather than its extension — generated models
 * arrive with all sorts of names, and a file called `.vox` that is not one should fail here with
 * a sentence a person can read, not inside the parser.
 */
export type ImportedFile =
    | {kind: 'vox'; name: string; model: VoxModel; scene?: VoxScene}
    | {kind: 'project'; name: string; text: string}

const VOX_MAGIC = [0x56, 0x4f, 0x58, 0x20] // 'VOX '

export const isVoxBytes = (bytes: Uint8Array): boolean =>
    bytes.length >= 4 && VOX_MAGIC.every((byte, i) => bytes[i] === byte)

/** `out/truck/best.vox` → `best`. The document name, not the path. */
export const baseName = (path: string): string => {
    const file = path.split(/[\\/]/).pop() ?? path
    const dot = file.lastIndexOf('.')
    return dot > 0 ? file.slice(0, dot) : file
}

const decoder = new TextDecoder()

/**
 * Bytes from disk to something the editor can open.
 *
 * Order matters: the magic-byte test runs first so a project file named `.vox` is still reported
 * as the wrong kind of file rather than being parsed as one.
 */
export const readImport = (name: string, bytes: Uint8Array): ImportedFile => {
    if (isVoxBytes(bytes)) {
        const scene = readVoxScene(bytes)
        // a file with one model is just a model; more than one means somebody exported layers,
        // and throwing them away on the way back in would make the layered export a one-way trip
        return {
            kind: 'vox',
            name: baseName(name),
            model: readVox(bytes),
            ...(scene.models.length > 1 ? {scene} : {})
        }
    }
    const text = decoder.decode(bytes).trim()
    if (text.startsWith('{')) {
        return {kind: 'project', name: baseName(name), text}
    }
    throw new Error(`${name}: not a .vox model or a .json project`)
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

/**
 * A palette from any of the four formats a pixel artist has on disk. A PNG is read as a strip —
 * one entry per colour run along its middle row — which is how Lospec hands palettes out.
 */
export const readPalette = async (name: string, bytes: Uint8Array): Promise<Rgba[]> => {
    if (PNG_MAGIC.every((byte, i) => bytes[i] === byte)) {
        return fromStrip(await decodePng(bytes))
    }
    const palette = decodePalette(decoder.decode(bytes))
    if (palette.length === 0) {
        throw new Error(`${name}: no colours found`)
    }
    return palette
}
