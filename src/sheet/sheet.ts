import type {NamedCamera} from '../doc/cameras'
import {basisFor} from '../render/camera'
import {createTarget, render} from '../render/raycast'
import {volumeDiagonal, type Volume} from '../render/volume'

/**
 * A packed sprite sheet and the maps that go with it.
 *
 * One geometry, six sheets: cell `n` is the same sprite in every one of them, because every one
 * came off the same ray. Nothing resamples, nothing is rendered twice, and the maps cannot drift
 * out of alignment without the renderer itself being wrong.
 *
 * This runs on the CPU in TypeScript, which is the point: the sheets the artist downloads are the
 * sheets a `bun test` golden hash covers, with no browser and no GPU anywhere in it.
 */
export interface Sheet {
    readonly width: number
    readonly height: number
    readonly cell: number
    readonly columns: number
    readonly rows: number
    /**
     * Only the maps that were asked for, colour always among them.
     *
     * They all come off one ray, so having them all is free in *rays* — but not in bytes. A sheet
     * of eight 64 px sprites is 128 KB a map, and baking four nobody asked for cost the seven-window
     * UI test three and a half seconds of garbage collection. What a preset wants is what gets
     * built; `FEATURESET.md` §38 is the reason there is a preset to ask.
     */
    readonly maps: Readonly<Partial<Record<SheetMap, Uint8Array>>>
}

/**
 * Height and depth are one measurement read two ways round, so the exporter writes both rather than
 * making the artist work out which convention their engine wants. They are exact complements —
 * `height = 255 - depth` — and neither costs a second render.
 */
export const HEIGHT_IS_DEPTH = true

/** Four across is what a sheet of eight directions wants to be; it is a layout, not a constraint. */
export const DEFAULT_COLUMNS = 4

/** Which maps a sheet carries, in the order the export panel lists them. */
export const SHEET_MAPS = ['color', 'normal', 'depth', 'height', 'ao', 'emission'] as const
export type SheetMap = (typeof SHEET_MAPS)[number]

export const sheetPlane = (sheet: Sheet, map: SheetMap): Uint8Array | undefined => sheet.maps[map]

/** The colour sheet, which every sheet has: it is what the preview and the packing are made of. */
export const sheetColor = (sheet: Sheet): Uint8Array => sheet.maps.color ?? new Uint8Array(0)

export const renderSheet = (
    volume: Volume,
    cameras: readonly NamedCamera[],
    cell: number,
    wanted: readonly SheetMap[] = SHEET_MAPS,
    columns = DEFAULT_COLUMNS
): Sheet => {
    const across = Math.max(1, Math.min(columns, cameras.length || 1))
    const rows = Math.max(1, Math.ceil(cameras.length / across))
    const width = across * cell
    const height = rows * cell
    const asked = new Set<SheetMap>([...wanted, 'color'])
    const planes: Partial<Record<SheetMap, Uint8Array>> = {}
    for (const map of SHEET_MAPS) {
        if (asked.has(map)) planes[map] = new Uint8Array(width * height * 4)
    }
    const target = createTarget(cell, cell)

    /*
     * Depth is written out across the volume's own diagonal rather than across the ray's full
     * range. The range is twice the distance the camera sits back, and a model occupies a sliver of
     * it — normalised that way an exported depth map is one flat grey, which is technically the
     * data and useless as a map.
     */
    const spread = volumeDiagonal(volume)

    cameras.forEach(({camera}, index) => {
        const basis = basisFor(camera, volume, cell)
        render(volume, basis, cell, cell, target)
        const near = basis.dist - spread * 0.5
        const ox = (index % across) * cell
        const oy = Math.floor(index / across) * cell

        const grey = (into: Uint8Array | undefined, at: number, value: number): void => {
            if (!into) return
            into[at] = value
            into[at + 1] = value
            into[at + 2] = value
            into[at + 3] = 255
        }

        for (let row = 0; row < cell; row += 1) {
            const from = row * cell * 4
            const to = ((oy + row) * width + ox) * 4
            planes.color?.set(target.color.subarray(from, from + cell * 4), to)
            planes.normal?.set(target.normal.subarray(from, from + cell * 4), to)
            planes.emission?.set(target.emission.subarray(from, from + cell * 4), to)
            if (!planes.depth && !planes.height && !planes.ao) continue

            for (let column = 0; column < cell; column += 1) {
                const here = row * cell + column
                const at = to + column * 4
                if ((target.id[here] ?? 0) === 0) continue
                const t = ((target.depth[here] ?? 0) / 65535) * basis.depthRange
                const near8 = Math.round(Math.min(Math.max(1 - (t - near) / spread, 0), 1) * 255)
                grey(planes.depth, at, near8)
                grey(planes.height, at, 255 - near8)
                grey(planes.ao, at, target.ao[here] ?? 0)
            }
        }
    })

    return {width, height, cell, columns: across, rows, maps: planes}
}
