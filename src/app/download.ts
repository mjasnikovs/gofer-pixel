import {encodePng} from '../image/png'
import type {SheetMetadata} from '../sheet/metadata'
import {sheetPlane, type Sheet, type SheetMap} from '../sheet/sheet'

/**
 * Handing a rendered buffer to the operating system.
 *
 * Its own file rather than a corner of the export panel, because the panel is a component and this
 * is not — and because both the panel's button and the header's Export mean the same thing by
 * "export", so there is one implementation of it.
 */
const download = async (
    name: string,
    width: number,
    height: number,
    data: Uint8Array
): Promise<void> => {
    const png = await encodePng(width, height, data)
    const url = URL.createObjectURL(new Blob([png as BlobPart], {type: 'image/png'}))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    URL.revokeObjectURL(url)
}

/**
 * The palette as a `.hex` file — `FEATURESET.md` §7's export half. Its import half is a file input
 * in the panel, because reading a file is the browser's job and writing one is this file's.
 */
const writeText = (name: string, text: string, type: string): void => {
    const url = URL.createObjectURL(new Blob([text], {type}))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    URL.revokeObjectURL(url)
}

export const writePalette = (text: string): void => {
    writeText('palette.hex', text, 'text/plain')
}

/** `FEATURESET.md` §37's metadata JSON, next to the sheet it describes. */
export const writeMetadata = (metadata: SheetMetadata): void => {
    writeText('sprites.json', JSON.stringify(metadata, undefined, 4), 'application/json')
}

/**
 * One sprite, cut out of the baked sheet — `FEATURESET.md` §17.
 *
 * Cut rather than re-rendered, so the file the artist gets for one camera is byte-for-byte the
 * cell they were looking at in the sheet. Rendering it again would only be probably identical.
 */
export const writeSprite = async (sheet: Sheet, index: number, name: string): Promise<void> => {
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
    await download(
        `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`,
        sheet.cell,
        sheet.cell,
        cut
    )
}

const fileName = (map: SheetMap): string => (map === 'color' ? 'sprites.png' : `sprites-${map}.png`)

export const writeSheetMap = async (sheet: Sheet, map: SheetMap): Promise<void> => {
    const plane = sheetPlane(sheet, map)
    // A map the sheet was not baked with has no file. The panel only offers the ones it has.
    if (!plane) return
    await download(fileName(map), sheet.width, sheet.height, plane)
}

/**
 * The maps a preset asks for, on the click that baked them.
 *
 * All six come off one render and cost nothing extra to *have*; what they cost is six PNG encodes
 * and six files in the artist's downloads folder, and most engines want two of them. Which two —
 * or four — is exactly what a preset is for (`FEATURESET.md` §38), and the menu next to the button
 * writes any single one on its own.
 */
export const writeSheet = async (sheet: Sheet, maps: readonly SheetMap[]): Promise<void> => {
    // Encoded together rather than one after another. Each one is a `CompressionStream`, and a
    // second stream started only after the first has fully drained waits on the platform's task
    // queue rather than on any work — under happy-dom that wait was a second and a half, which the
    // UI test paid twice.
    await Promise.all(maps.map(map => writeSheetMap(sheet, map)))
}
