import type {Volume} from '../render/volume'

/**
 * The project palette of `docs/editor.png`, read off the model instead of invented.
 *
 * A `.vox` file carries 255 colours whether or not the artist used them, so a grid that just walks
 * the file shows a wall of MagicaVoxel's defaults with the model's own colours buried somewhere in
 * it. Used colours come first, in palette order, and the unused entries fill the rest of the grid —
 * so the top-left of the swatch grid is always the model, and the palette is still all there.
 */
export interface Swatch {
    /** 1-based index into `volume.palette`, the `.vox` format's own convention. */
    readonly index: number
    readonly css: string
    /** Whether any voxel in the model carries this colour. */
    readonly isUsed: boolean
}

/** Seven across and eight down, as the mockup draws it. */
export const SWATCH_COLUMNS = 7
export const SWATCH_ROWS = 8

const hex = (value: number): string => value.toString(16).padStart(2, '0')

const cssAt = (palette: Uint8Array, index: number): string =>
    `#${hex(palette[index * 4] ?? 0)}${hex(palette[index * 4 + 1] ?? 0)}${hex(palette[index * 4 + 2] ?? 0)}`

/** Which palette indices the model's voxels actually carry. */
export const usedColors = ({data}: Volume): Set<number> => {
    const used = new Set<number>()
    for (const value of data) if (value !== 0) used.add(value)
    return used
}

export const projectPalette = (
    volume: Volume,
    limit = SWATCH_COLUMNS * SWATCH_ROWS
): readonly Swatch[] => {
    const used = usedColors(volume)
    const swatches: Swatch[] = []
    for (const index of [...used].sort((a, b) => a - b)) {
        swatches.push({index, css: cssAt(volume.palette, index), isUsed: true})
    }
    for (let index = 1; index < 256 && swatches.length < limit; index += 1) {
        if (!used.has(index)) {
            swatches.push({index, css: cssAt(volume.palette, index), isUsed: false})
        }
    }
    return swatches.slice(0, limit)
}

/** The colour a freshly opened document is loaded with: the model's own first colour. */
export const firstColor = (volume: Volume): number => projectPalette(volume, 1)[0]?.index ?? 1

export const colorCss = (volume: Volume, index: number): string => cssAt(volume.palette, index)
