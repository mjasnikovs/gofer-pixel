import type {Files} from '../doc/files'
import {encodePng} from '../image/png'
import type {SheetMetadata} from '../sheet/metadata'
import {sheetPlane, type Sheet, type SheetMap} from '../sheet/sheet'

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

/** `FEATURESET.md` §37's metadata JSON, next to the sheet it describes. */
export const writeMetadata = async (files: Files, metadata: SheetMetadata): Promise<void> => {
    await files.write('sprites.json', JSON.stringify(metadata, undefined, 4), 'application/json')
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
    const plane = sheet.maps.color
    if (!plane) return
    const stride = sheet.cell + sheet.padding
    const ox = sheet.padding + (index % sheet.columns) * stride
    const oy = sheet.padding + Math.floor(index / sheet.columns) * stride
    const cut = new Uint8Array(sheet.cell * sheet.cell * 4)
    for (let row = 0; row < sheet.cell; row += 1) {
        const from = ((oy + row) * sheet.width + ox) * 4
        cut.set(plane.subarray(from, from + sheet.cell * 4), row * sheet.cell * 4)
    }
    await files.write(
        `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`,
        await encodePng(sheet.cell, sheet.cell, cut),
        'image/png'
    )
}

const fileName = (map: SheetMap): string => (map === 'color' ? 'sprites.png' : `sprites-${map}.png`)

export const writeSheetMap = async (files: Files, sheet: Sheet, map: SheetMap): Promise<void> => {
    const plane = sheetPlane(sheet, map)
    // A map the sheet was not baked with has no file. The panel only offers the ones it has.
    if (!plane) return
    await files.write(fileName(map), await encodePng(sheet.width, sheet.height, plane), 'image/png')
}

/**
 * The maps a preset asks for, on the click that baked them.
 *
 * All six come off one render and cost nothing extra to *have*; what they cost is six PNG encodes
 * and six files in the artist's downloads folder, and most engines want two of them. Which two —
 * or four — is exactly what a preset is for (`FEATURESET.md` §38), and the menu next to the button
 * writes any single one on its own.
 */
export const writeSheet = async (
    files: Files,
    sheet: Sheet,
    maps: readonly SheetMap[]
): Promise<void> => {
    // Encoded together rather than one after another. Each one is a `CompressionStream`, and a
    // second stream started only after the first has fully drained waits on the platform's task
    // queue rather than on any work — under happy-dom that wait was a second and a half, which the
    // UI test paid twice.
    await Promise.all(maps.map(map => writeSheetMap(files, sheet, map)))
}
