import {encodePng} from '../image/png'
import type {Sheet} from '../sheet/sheet'

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

export const writeColorSheet = async (sheet: Sheet): Promise<void> => {
    await download('sprites.png', sheet.width, sheet.height, sheet.color)
}

export const writeNormalSheet = async (sheet: Sheet): Promise<void> => {
    await download('sprites-normal.png', sheet.width, sheet.height, sheet.normal)
}

/** Both sheets, on the click that baked them — the artist asked for an export, not for a preview. */
export const writeSheet = async (sheet: Sheet): Promise<void> => {
    await writeColorSheet(sheet)
    await writeNormalSheet(sheet)
}
