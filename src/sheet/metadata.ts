import type {NamedCamera} from '../doc/cameras'
import {basisFor} from '../render/camera'
import type {Volume} from '../render/volume'
import {cellAt, type Sheet} from './sheet'

/**
 * The JSON that goes next to the sheet — `FEATURESET.md` §37.
 *
 * What an engine needs and nothing else: where each sprite is, what it is called, where its pivot
 * sits, and how big the thing in it is. No frame durations, because there are no frames (§24 is
 * postponed); no engine-specific shape, because guessing which engine is exactly what §38's presets
 * exist to stop this file doing.
 */
export interface SpriteEntry {
    readonly name: string
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
    /**
     * Where the model's own origin lands inside the cell, in pixels from the cell's top-left.
     *
     * The origin, not the centre of the artwork: eight sprites of a walking character have eight
     * different silhouettes and one place their feet are, and a sheet whose pivots follow the
     * artwork makes the character jitter as it turns.
     */
    readonly pivotX: number
    readonly pivotY: number
    /** The artwork's own box inside the cell, for a collider that fits what is drawn. */
    readonly bounds: {x: number; y: number; width: number; height: number} | undefined
}

export interface SheetMetadata {
    readonly format: 'gofer-pixel/sheet'
    readonly version: 1
    readonly width: number
    readonly height: number
    readonly cell: number
    readonly padding: number
    readonly columns: number
    readonly rows: number
    readonly maps: readonly string[]
    readonly sprites: readonly SpriteEntry[]
}

/** The opaque box of one cell of the colour sheet, or `undefined` if the cell is empty. */
const artworkBounds = (
    sheet: Sheet,
    ox: number,
    oy: number
): {x: number; y: number; width: number; height: number} | undefined => {
    const colour = sheet.maps.color
    if (!colour) return undefined
    let left = sheet.cell
    let top = sheet.cell
    let right = -1
    let bottom = -1
    for (let row = 0; row < sheet.cell; row += 1) {
        for (let column = 0; column < sheet.cell; column += 1) {
            if (colour[((oy + row) * sheet.width + ox + column) * 4 + 3] !== 255) continue
            left = Math.min(left, column)
            top = Math.min(top, row)
            right = Math.max(right, column)
            bottom = Math.max(bottom, row)
        }
    }
    if (right < 0) return undefined
    return {x: left, y: top, width: right - left + 1, height: bottom - top + 1}
}

export const sheetMetadata = (
    volume: Volume,
    cameras: readonly NamedCamera[],
    sheet: Sheet,
    withBounds: boolean
): SheetMetadata => {
    return {
        format: 'gofer-pixel/sheet',
        version: 1,
        width: sheet.width,
        height: sheet.height,
        cell: sheet.cell,
        padding: sheet.padding,
        columns: sheet.columns,
        rows: sheet.rows,
        maps: Object.keys(sheet.maps),
        sprites: cameras.map((entry, index) => {
            // The one arithmetic that says where a cell is — shared with `cutCell`, so the offset
            // the JSON promises an engine is the offset the sprite was actually cut from.
            const {x, y} = cellAt(sheet, index)

            /*
             * The pivot is the model's own origin projected through this camera's basis. It is
             * computed rather than assumed to be the middle of the cell, because a pan moves the
             * model inside the frame and the engine has to know where the feet went.
             */
            const {right, up, center, scale} = basisFor(entry.camera, volume, sheet.cell)
            const dx = volume.sx / 2 - center[0]
            const dy = volume.sy / 2 - center[1]
            const dz = 0 - center[2]
            const along = right[0] * dx + right[1] * dy + right[2] * dz
            const over = up[0] * dx + up[1] * dy + up[2] * dz
            return {
                name: entry.name,
                x,
                y,
                width: sheet.cell,
                height: sheet.cell,
                pivotX: Math.round(along / scale + sheet.cell * 0.5 - 0.5),
                pivotY: Math.round(sheet.cell * 0.5 - 0.5 - over / scale),
                bounds: withBounds ? artworkBounds(sheet, x, y) : undefined
            }
        })
    }
}
