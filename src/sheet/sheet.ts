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
    /**
     * One sprite's own width and height in pixels, which are not required to match.
     *
     * They were one number until a character taller than it is wide had to be packed into a square
     * and given air on both sides for it. Nothing in the renderer ever wanted them joined: the
     * scale comes off `cellH` alone — `basisFor` takes a height and derives voxels-per-pixel from
     * it — and `cellW` only says how far the frame reaches left and right of the pivot. A 32 × 64
     * cell is the same rays as a 64 × 64 one with the outer 16 columns not cast.
     *
     * `cellH` is therefore the number `render/perfect.ts` asks its question about. The width cannot
     * make a voxel land off the grid and cannot save it either.
     */
    readonly cellW: number
    readonly cellH: number
    readonly columns: number
    readonly rows: number
    /** Transparent pixels between cells and around the edge — `FEATURESET.md` §16. */
    readonly padding: number
    /**
     * Only the maps that were asked for, colour always among them.
     *
     * They all come off one ray, so having them all is free in *rays* — but not in bytes. A sheet
     * of eight 64 px sprites is 128 KB a map, and baking four nobody asked for cost the seven-window
     * UI test three and a half seconds of garbage collection. What a preset wants is what gets
     * built; `FEATURESET.md` §38 is the reason there is a preset to ask.
     */
    /**
     * Height and depth are one measurement read two ways round, so the exporter writes both rather
     * than making the artist work out which convention their engine wants. They are exact
     * complements — `height = 255 - depth` — and neither costs a second render.
     */
    readonly maps: Readonly<Partial<Record<SheetMap, Uint8Array>>>
}

/** Four across is what a sheet of eight directions wants to be; it is a layout, not a constraint. */
export const DEFAULT_COLUMNS = 4

/**
 * One sprite's size, which a caller may give as a single number when it is square.
 *
 * The number form is not a convenience left over from before the split: a square cell is what most
 * of the app wants and spelling `{cellW: 64, cellH: 64}` at every one of those call sites would be
 * noise around the two places that differ. `cellSize` is the one widening, so nothing else has to
 * decide what a bare number means.
 */
export interface CellSize {
    readonly cellW: number
    readonly cellH: number
}

export const cellSize = (cell: number | CellSize): CellSize =>
    typeof cell === 'number' ? {cellW: cell, cellH: cell} : cell

/**
 * Which maps a sheet carries, in the order the export panel lists them.
 *
 * `index` and `object` are the two that are data rather than pictures: the palette index and the
 * owning object, written into the red channel with a solid alpha. They close `FEATURESET.md` §18's
 * "object/material ID" and §7's "optional indexed-color output" at once, because in a document
 * whose colours are palette entries those two questions have the same shape of answer.
 */
export const SHEET_MAPS = [
    'color',
    'normal',
    'depth',
    'height',
    'ao',
    'emission',
    'index',
    'object'
] as const
export type SheetMap = (typeof SHEET_MAPS)[number]

export const sheetPlane = (sheet: Sheet, map: SheetMap): Uint8Array | undefined => sheet.maps[map]

/** Where camera `index` sits in the sheet, in pixels from the top-left. */
export const cellAt = (sheet: Sheet, index: number): {x: number; y: number} => ({
    x: sheet.padding + (index % sheet.columns) * (sheet.cellW + sheet.padding),
    y: sheet.padding + Math.floor(index / sheet.columns) * (sheet.cellH + sheet.padding)
})

/**
 * One camera's cell of one map, cut out of the packed sheet.
 *
 * **Cut, never re-rendered**, and that is the rule this function exists to hold. Everything the
 * export dialog shows and everything it writes for a single sprite comes through here, so the
 * preview cannot be a second opinion about what the file will contain — it is the file's own bytes,
 * at the offset the metadata JSON records.
 *
 * The alternative had already grown: `app/sprite-cache.ts` renders a sprite for the viewport and
 * covers five of the eight maps, and its depth is a *view* mode whose own comment says it is not
 * what gets exported. A preview built on that would have disagreed with the download for three
 * maps out of eight, silently, in the one panel whose whole job is to show what lands on disk.
 *
 * `undefined` when the sheet was not baked with that map — there is nothing to cut.
 */
export const cutCell = (sheet: Sheet, map: SheetMap, index: number): Uint8Array | undefined => {
    const plane = sheet.maps[map]
    if (!plane) return undefined
    const {x, y} = cellAt(sheet, index)
    const row = sheet.cellW * 4
    const cut = new Uint8Array(sheet.cellH * row)
    for (let line = 0; line < sheet.cellH; line += 1) {
        const from = ((y + line) * sheet.width + x) * 4
        cut.set(plane.subarray(from, from + row), line * row)
    }
    return cut
}

/** The colour sheet, which every sheet has: it is what the preview and the packing are made of. */
export const sheetColor = (sheet: Sheet): Uint8Array => sheet.maps.color ?? new Uint8Array(0)

/**
 * Padding is transparent and goes between the cells *and* around the outside.
 *
 * Around the outside as well, because the reason to pad at all is that a renderer sampling a
 * sprite's edge texel bleeds into its neighbour — and the sheet's own border is a neighbour as far
 * as clamping and mipmapping are concerned.
 */
export const renderSheet = (
    volume: Volume,
    cameras: readonly NamedCamera[],
    cell: number | CellSize,
    wanted: readonly SheetMap[] = SHEET_MAPS,
    padding = 0,
    columns = DEFAULT_COLUMNS
): Sheet => {
    const {cellW, cellH} = cellSize(cell)
    const across = Math.max(1, Math.min(columns, cameras.length || 1))
    const rows = Math.max(1, Math.ceil(cameras.length / across))
    const pad = Math.max(0, Math.round(padding))
    const strideX = cellW + pad
    const strideY = cellH + pad
    const width = across * strideX + pad
    const height = rows * strideY + pad
    const asked = new Set<SheetMap>([...wanted, 'color'])
    const planes: Partial<Record<SheetMap, Uint8Array>> = {}
    for (const map of SHEET_MAPS) {
        if (asked.has(map)) planes[map] = new Uint8Array(width * height * 4)
    }
    const target = createTarget(cellW, cellH)

    /*
     * Depth is written out across the volume's own diagonal rather than across the ray's full
     * range. The range is twice the distance the camera sits back, and a model occupies a sliver of
     * it — normalised that way an exported depth map is one flat grey, which is technically the
     * data and useless as a map.
     */
    const spread = volumeDiagonal(volume)

    cameras.forEach(({camera}, index) => {
        // The height, not the width: `basisFor` derives voxels-per-pixel from the height alone,
        // and a wider cell reaches further left and right of the pivot at the same scale.
        const basis = basisFor(camera, volume, cellH)
        render(volume, basis, cellW, cellH, target)
        const near = basis.dist - spread * 0.5
        const ox = pad + (index % across) * strideX
        const oy = pad + Math.floor(index / across) * strideY

        const grey = (into: Uint8Array | undefined, at: number, value: number): void => {
            if (!into) return
            into[at] = value
            into[at + 1] = value
            into[at + 2] = value
            into[at + 3] = 255
        }

        const channel = (into: Uint8Array | undefined, at: number, value: number): void => {
            if (!into) return
            into[at] = value
            into[at + 3] = 255
        }

        for (let row = 0; row < cellH; row += 1) {
            const from = row * cellW * 4
            const to = ((oy + row) * width + ox) * 4
            planes.color?.set(target.color.subarray(from, from + cellW * 4), to)
            planes.normal?.set(target.normal.subarray(from, from + cellW * 4), to)
            planes.emission?.set(target.emission.subarray(from, from + cellW * 4), to)
            if (!planes.depth && !planes.height && !planes.ao && !planes.index && !planes.object) {
                continue
            }

            for (let column = 0; column < cellW; column += 1) {
                const here = row * cellW + column
                const at = to + column * 4
                if ((target.id[here] ?? 0) === 0) continue
                const t = ((target.depth[here] ?? 0) / 65535) * basis.depthRange
                const near8 = Math.round(Math.min(Math.max(1 - (t - near) / spread, 0), 1) * 255)
                grey(planes.depth, at, near8)
                grey(planes.height, at, 255 - near8)
                grey(planes.ao, at, target.ao[here] ?? 0)
                // Not grey: an id is a number, and spreading it over three channels would invite
                // an engine to read it as a colour and resample it.
                channel(planes.index, at, target.id[here] ?? 0)
                channel(planes.object, at, target.object[here] ?? 0)
            }
        }
    })

    return {width, height, cellW, cellH, columns: across, rows, padding: pad, maps: planes}
}
