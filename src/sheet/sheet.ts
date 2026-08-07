import type {NamedCamera} from '../doc/cameras'
import {basisFor} from '../render/camera'
import {createTarget, render} from '../render/raycast'
import type {Volume} from '../render/volume'

/**
 * A packed sprite sheet and the normal map that goes with it.
 *
 * Two sheets, one geometry: cell `n` is the same sprite in both, because both came off the same
 * ray. Nothing resamples, nothing is rendered twice, and the maps cannot drift out of alignment
 * without the renderer itself being wrong.
 *
 * This runs on the CPU in TypeScript, which is the point: the sheet the artist downloads is the
 * sheet a `bun test` golden hash covers, with no browser and no GPU anywhere in it.
 */
export interface Sheet {
    readonly width: number
    readonly height: number
    readonly cell: number
    readonly columns: number
    readonly rows: number
    readonly color: Uint8Array
    readonly normal: Uint8Array
}

/** Four across is what a sheet of eight directions wants to be; it is a layout, not a constraint. */
export const DEFAULT_COLUMNS = 4

export const renderSheet = (
    volume: Volume,
    cameras: readonly NamedCamera[],
    cell: number,
    columns = DEFAULT_COLUMNS
): Sheet => {
    const across = Math.max(1, Math.min(columns, cameras.length || 1))
    const rows = Math.max(1, Math.ceil(cameras.length / across))
    const width = across * cell
    const height = rows * cell
    const color = new Uint8Array(width * height * 4)
    const normal = new Uint8Array(width * height * 4)
    const target = createTarget(cell, cell)

    cameras.forEach(({camera}, index) => {
        render(volume, basisFor(camera, volume, cell), cell, cell, target)
        const ox = (index % across) * cell
        const oy = Math.floor(index / across) * cell
        for (let row = 0; row < cell; row += 1) {
            const from = row * cell * 4
            const to = ((oy + row) * width + ox) * 4
            color.set(target.color.subarray(from, from + cell * 4), to)
            normal.set(target.normal.subarray(from, from + cell * 4), to)
        }
    })

    return {width, height, cell, columns: across, rows, color, normal}
}
