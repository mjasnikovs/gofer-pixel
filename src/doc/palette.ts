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

/**
 * Recent colours — `FEATURESET.md` §7.
 *
 * Most recent first, no duplicates, eight of them. Eight because that is one row of the swatch
 * grid, and a "recent" list long enough to need scanning is the palette again.
 */
export const RECENT_COLORS = 8

export const remember = (recent: readonly number[], index: number): readonly number[] => {
    if (index === 0) return recent
    return [index, ...recent.filter(entry => entry !== index)].slice(0, RECENT_COLORS)
}

/** Write one palette entry. Returns a new palette; the old one is left alone. */
export const withColor = (palette: Uint8Array, index: number, css: string): Uint8Array => {
    const next = new Uint8Array(palette)
    const rgb = parseHex(css)
    if (!rgb || index <= 0 || index > 255) return next
    next.set([rgb[0], rgb[1], rgb[2], 255], index * 4)
    return next
}

const parseHex = (css: string): readonly [number, number, number] | undefined => {
    const digits = css.trim().replace(/^#/, '')
    if (!/^[0-9a-fA-F]{6}$/.test(digits)) return undefined
    return [
        Number.parseInt(digits.slice(0, 2), 16),
        Number.parseInt(digits.slice(2, 4), 16),
        Number.parseInt(digits.slice(4, 6), 16)
    ]
}

/**
 * The palette as text, one `RRGGBB` a line — the `.hex` format Aseprite, Lospec and half the pixel
 * art world already read and write.
 *
 * A `.png` strip is the other convention and this project could write one, having an encoder. It
 * could not *read* one, having no decoder, and a palette you can export but not import is worse
 * than one text file that goes both ways.
 */
export const toHexPalette = (palette: Uint8Array): string => {
    const lines: string[] = []
    for (let index = 1; index < 256; index += 1) lines.push(cssAt(palette, index).slice(1))
    return `${lines.join('\n')}\n`
}

/**
 * Read a `.hex` file back, filling from entry 1 on.
 *
 * A line that is not six hex digits is skipped rather than rejected, which is how the comments and
 * headers that real palette files carry get past. Anything after entry 255 is dropped rather than
 * wrapping onto entry 1 and quietly recolouring the model.
 */
export const fromHexPalette = (text: string, base: Uint8Array): Uint8Array => {
    const palette = new Uint8Array(base)
    let index = 1
    for (const line of text.split(/\r?\n/)) {
        const rgb = parseHex(line)
        if (!rgb || index > 255) continue
        palette.set([rgb[0], rgb[1], rgb[2], 255], index * 4)
        index += 1
    }
    return palette
}

/** The first palette slot no voxel uses, for "add a colour". `0` when every slot is taken. */
export const freeSlot = (volume: Volume): number => {
    const used = usedColors(volume)
    for (let index = 1; index < 256; index += 1) if (!used.has(index)) return index
    return 0
}
