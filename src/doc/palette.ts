import {magicaPalette} from '../vox/vox-file'
import type {Volume} from '../render/volume'

/**
 * DawnBringer 32 — the default palette this editor opens on.
 *
 * The alternative was MagicaVoxel's own, and MagicaVoxel's own is not a palette. It is a 6×6×3 RGB
 * cube walked in index order: every hue at every lightness, none of them chosen, no ramp that runs
 * anywhere, and the first two rows of it are five near-blacks that differ by two levels of red. An
 * artist picking colours out of that grid is doing colour theory from scratch on every voxel.
 *
 * DB32 is the one pixel-art palette that needs no introduction — 32 colours with ramps already cut
 * through them, warm and cool greys that are actually different, and a skin ramp. It is small enough
 * that the whole thing fits in five rows of the swatch grid, which matters: a palette you have to
 * scroll is a palette you pick the top-left of.
 */
const DB32 = [
    '000000',
    '222034',
    '45283c',
    '663931',
    '8f563b',
    'df7126',
    'd9a066',
    'eec39a',
    'fbf236',
    '99e550',
    '6abe30',
    '37946e',
    '4b692f',
    '524b24',
    '323c39',
    '3f3f74',
    '306082',
    '5b6ee1',
    '639bff',
    '5fcde4',
    'cbdbfc',
    'ffffff',
    '9badb7',
    '847e87',
    '696a6a',
    '595652',
    '76428a',
    'ac3232',
    'd95763',
    'd77bba',
    '8f974a',
    '8a6f30'
] as const

/**
 * The project palette of `docs/editor.png`, read off the model instead of invented.
 *
 * A `.vox` file carries 255 colours whether or not the artist used them, so a grid that just walks
 * the file shows a wall of MagicaVoxel's defaults with the model's own colours buried somewhere in
 * it. Used colours come first, in palette order; then the colours somebody chose, which after
 * `freshenPalette` means DB32. The top-left of the grid is always the model, and the rest is a
 * palette rather than a dump of the format's filler.
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
    const ramp = magicaPalette()
    const swatches: Swatch[] = []
    for (const index of [...used].sort((a, b) => a - b)) {
        swatches.push({index, css: cssAt(volume.palette, index), isUsed: true})
    }
    /*
     * Untouched filler is skipped rather than shown. `freshenPalette` has already put DB32 into the
     * front of it, so what is left here is the tail of MagicaVoxel's ramp — 200-odd colours nobody
     * chose, whose only effect on the grid is to bury the ones somebody did. The grid is therefore
     * as long as the palette has real colours, and no longer.
     */
    for (let index = 1; index < 256 && swatches.length < limit; index += 1) {
        if (!used.has(index) && !isFiller(volume.palette, ramp, index)) {
            swatches.push({index, css: cssAt(volume.palette, index), isUsed: false})
        }
    }
    return swatches.slice(0, limit)
}

/**
 * Whether slot `index` holds a colour nobody chose — either MagicaVoxel's generated ramp, or the
 * blank a document built from a PNG leaves behind.
 *
 * Exact byte equality against the ramp, because the ramp comes out of a formula rather than out of
 * a person: a slot that matches it to the byte was filled in by the format, and a slot that does not
 * was filled in by somebody. There is no near-miss to worry about. A zero alpha is the other case —
 * `doc/import.ts` sizes a palette to 256 and fills only the colours the image had.
 */
const isFiller = (palette: Uint8Array, ramp: Uint8Array, index: number): boolean =>
    (palette[index * 4 + 3] ?? 0) === 0
    || (palette[index * 4] === ramp[index * 4]
        && palette[index * 4 + 1] === ramp[index * 4 + 1]
        && palette[index * 4 + 2] === ramp[index * 4 + 2])

/**
 * Make sure every DB32 colour is somewhere in the palette, using only the slots nobody wants.
 *
 * Two guards on what may be written over, and both matter. A slot a voxel carries is the *model*, so
 * touching it would silently recolour the artwork on open. A slot that differs from MagicaVoxel's
 * ramp was picked by whoever made the file — unused today, but staged for tomorrow — so touching it
 * would throw away their work. What is left is the format's filler, and that is all this replaces.
 *
 * Stated as "is this colour present" rather than "fill the first 32 free slots", which is what makes
 * it idempotent: a document that was freshened when it was created gets freshened again every time
 * it is recovered from an autosave, and the second pass has to be a no-op. Filling free slots is not
 * — the slots move, so the second pass would lay a second copy of DB32 further down the palette. It
 * also means a model that already paints in DB32 white does not get a duplicate white.
 */
export const freshenPalette = (volume: Volume): Uint8Array => {
    const palette = new Uint8Array(volume.palette)
    const ramp = magicaPalette()
    const used = usedColors(volume)

    // A slot counts as holding a colour when the model paints with it or somebody chose it. The
    // `used` half is not redundant: MagicaVoxel's own entry 1 is white, so a model painted white
    // would otherwise read as filler and earn the palette a second, duplicate white.
    const holds = (rgb: readonly [number, number, number]): boolean => {
        for (let index = 1; index < 256; index += 1) {
            if (!used.has(index) && isFiller(palette, ramp, index)) continue
            if (
                palette[index * 4] === rgb[0]
                && palette[index * 4 + 1] === rgb[1]
                && palette[index * 4 + 2] === rgb[2]
            ) {
                return true
            }
        }
        return false
    }

    let slot = 1
    for (const entry of DB32) {
        const rgb = parseHex(entry)
        if (!rgb || holds(rgb)) continue
        while (slot < 256 && (used.has(slot) || !isFiller(palette, ramp, slot))) slot += 1
        if (slot >= 256) break
        palette.set([rgb[0], rgb[1], rgb[2], 255], slot * 4)
    }
    return palette
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
