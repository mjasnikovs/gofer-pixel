import {encodePng} from '../image/png'
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
