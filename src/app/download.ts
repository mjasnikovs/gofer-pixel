import type {Files} from '../doc/files'
import {encodePng} from '../image/png'
import {zip} from '../image/zip'
import type {SheetMetadata} from '../sheet/metadata'
import {cutCell, sheetPlane, type Sheet, type SheetMap} from '../sheet/sheet'

/**
 * What an export is *called* and what bytes go in it — and nothing about how it reaches the disk.
 *
 * Every function here used to end at its own `document.createElement('a')`, three lines from the
 * identical anchor inside `doc/files.ts`. So the app had two disk seams: one with two adapters and a
 * `memoryFiles` under it, and one with none — and the one with none was the whole of what the artist
 * actually ships. Its tests replaced `URL.createObjectURL`, `URL.revokeObjectURL` and
 * `HTMLAnchorElement.prototype.click` for every case in the file, and still could not read a byte of
 * what was written, because happy-dom's `blob:` handle is opaque.
 *
 * The port is `Files.write` now. What is left in this file is the naming and the cutting, which is
 * the part with decisions in it.
 */

/**
 * The palette as a `.hex` file — `FEATURESET.md` §7's export half. Its import half goes through
 * `Files.open`, because reading a file needs a picker and this does not.
 */
export const writePalette = async (files: Files, text: string): Promise<void> => {
    await files.write('palette.hex', text, 'text/plain')
}

/** `FEATURESET.md` §37's metadata JSON, as text. One spelling, whether it goes loose or in a pack. */
export const metadataText = (metadata: SheetMetadata): string =>
    JSON.stringify(metadata, undefined, 4)

/** `FEATURESET.md` §37's metadata JSON, next to the sheet it describes. */
export const writeMetadata = async (files: Files, metadata: SheetMetadata): Promise<void> => {
    await files.write('sprites.json', metadataText(metadata), 'application/json')
}

/**
 * One sprite, cut out of the baked sheet — `FEATURESET.md` §17.
 *
 * Cut rather than re-rendered, so the file the artist gets for one camera is byte-for-byte the
 * cell they were looking at in the sheet. Rendering it again would only be probably identical.
 */
export const writeSprite = async (
    files: Files,
    sheet: Sheet,
    index: number,
    name: string
): Promise<void> => {
    const cut = cutCell(sheet, 'color', index)
    if (!cut) return
    await files.write(
        `${slug(name)}.png`,
        await encodePng(sheet.cellW, sheet.cellH, cut),
        'image/png'
    )
}

/** A camera's name, or a document's, as something a file system and a zip entry both accept. */
export const slug = (name: string): string =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'sprites'

const fileName = (map: SheetMap): string => (map === 'color' ? 'sprites.png' : `sprites-${map}.png`)

/**
 * The maps, encoded, named, and in the order they were asked for.
 *
 * Encoded together rather than one after another. Each one is a `CompressionStream`, and a second
 * stream started only after the first has fully drained waits on the platform's task queue rather
 * than on any work — under happy-dom that wait was a second and a half, which the UI test paid
 * twice. A map the sheet was not baked with is skipped, not written empty.
 */
const mapFiles = async (
    sheet: Sheet,
    maps: readonly SheetMap[]
): Promise<{name: string; bytes: Uint8Array}[]> => {
    const built = await Promise.all(
        maps.map(async map => {
            const plane = sheetPlane(sheet, map)
            if (!plane) return undefined
            return {
                name: fileName(map),
                bytes: await encodePng(sheet.width, sheet.height, plane)
            }
        })
    )
    return built.filter(entry => entry !== undefined)
}

export const writeSheetMap = async (files: Files, sheet: Sheet, map: SheetMap): Promise<void> => {
    const [file] = await mapFiles(sheet, [map])
    if (file) await files.write(file.name, file.bytes, 'image/png')
}

/**
 * The maps the artist ticked, as loose PNGs — the old Export button, now a menu item.
 *
 * All eight come off one render and cost nothing extra to *have*; what they cost is eight PNG
 * encodes and eight files in the artist's downloads folder, and most engines want two of them.
 * Which two — or four — is exactly what a preset is for (`FEATURESET.md` §38).
 */
export const writeSheet = async (
    files: Files,
    sheet: Sheet,
    maps: readonly SheetMap[]
): Promise<void> => {
    const built = await mapFiles(sheet, maps)
    await Promise.all(built.map(file => files.write(file.name, file.bytes, 'image/png')))
}

/**
 * Everything the export ships, as one `.zip` — `FEATURESET.md` §37's "one-click".
 *
 * One file rather than nine is the whole of the argument. An eight-direction character with colour,
 * normal and emission is three sheets plus the JSON that says where the frames are, and four
 * downloads that must not be separated is a thing the artist has to keep together by hand.
 *
 * Stored, not compressed — see `image/zip.ts`. The PNGs are already deflated, so the pack costs one
 * pass to concatenate and nothing else, and the file is the same size the loose downloads were.
 *
 * Flat: `sprites.png`, `sprites-normal.png`, `sprites.json`, all at the root. Folders would be a
 * guess about which engine is reading, and guessing that is exactly what presets exist to stop this
 * code doing.
 */
export const writePack = async (
    files: Files,
    sheet: Sheet,
    maps: readonly SheetMap[],
    metadata: SheetMetadata,
    name: string
): Promise<void> => {
    const encoder = new TextEncoder()
    const built = await mapFiles(sheet, maps)
    const archive = zip([
        ...built,
        {name: 'sprites.json', bytes: encoder.encode(metadataText(metadata))}
    ])
    await files.write(`${slug(name)}.zip`, archive, 'application/zip')
}
