import {expect, test} from 'bun:test'
import {readVox} from '../vox/vox-file'
import {createVolume, setVoxel} from '../render/volume'
import {beginEdit, commitEdit, revertEdit} from './edits'
import {
    colorCss,
    freeSlot,
    freshenPalette,
    fromHexPalette,
    projectPalette,
    RECENT_COLORS,
    remember,
    SWATCH_COLUMNS,
    SWATCH_ROWS,
    toHexPalette,
    usedColors,
    withColor
} from './palette'
import {selectColor} from './selection'
import {remapColor} from './transform'

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

/** As the app opens it — see `freshenPalette`, which every document goes through in `initialState`. */
const opened = {...volume, palette: freshenPalette(volume)}

test('the model’s own colours come first, then the palette, then nothing', () => {
    const used = usedColors(opened)
    expect(used.size).toBeGreaterThan(0)
    expect(used.has(0)).toBe(false)

    const swatches = projectPalette(opened)
    expect(swatches.slice(0, used.size).every(({isUsed}) => isUsed)).toBe(true)
    expect(swatches.slice(used.size).some(({isUsed}) => isUsed)).toBe(false)

    // The model's three colours and DB32, and not one entry of MagicaVoxel's ramp behind them.
    expect(swatches).toHaveLength(used.size + 31)
    expect(swatches.length).toBeLessThan(SWATCH_COLUMNS * SWATCH_ROWS)

    // Every entry is a distinct index, so clicking one swatch cannot select another. And a distinct
    // colour, or the grid offers the same paint twice under two names.
    expect(new Set(swatches.map(({index}) => index)).size).toBe(swatches.length)
    expect(new Set(swatches.map(({css}) => css)).size).toBe(swatches.length)
})

test('the default palette lands on the filler and on nothing else', () => {
    // The model's own three entries survive the trip byte for byte. This is the whole guard: a
    // default palette that recoloured the artwork it opened would be a data-loss bug, not a theme.
    for (const index of usedColors(volume)) {
        expect([...opened.palette.subarray(index * 4, index * 4 + 4)]).toEqual([
            ...volume.palette.subarray(index * 4, index * 4 + 4)
        ])
    }

    // A colour somebody chose is never overwritten either, used or not.
    const authored = {...volume, palette: withColor(volume.palette, 7, '#123456')}
    expect(colorCss({...authored, palette: freshenPalette(authored)}, 7)).toBe('#123456')

    // Running it twice is running it once — a recovered autosave is freshened again on open.
    expect([...freshenPalette(opened)]).toEqual([...opened.palette])
})

test('a document with no palette at all opens on the default one', () => {
    const blank = createVolume(4, 4, 4)
    const swatches = projectPalette({...blank, palette: freshenPalette(blank)})
    expect(swatches).toHaveLength(32)
    expect(swatches[0]?.css).toBe('#000000')
    expect(swatches.some(({css}) => css === '#ffffff')).toBe(true)
})

test('a swatch carries the palette’s own bytes, not a re-derived colour', () => {
    const first = projectPalette(volume, 1)[0]
    const index = first?.index ?? 0
    const {palette} = volume
    const expected = [palette[index * 4], palette[index * 4 + 1], palette[index * 4 + 2]]
        .map(value => (value ?? 0).toString(16).padStart(2, '0'))
        .join('')
    expect(first?.css).toBe(`#${expected}`)
    expect(colorCss(volume, index)).toBe(`#${expected}`)
})

test('recent colours are most-recent-first, unique, and one row long', () => {
    let recent: readonly number[] = []
    for (const index of [3, 7, 3, 9]) recent = remember(recent, index)
    expect(recent).toEqual([9, 3, 7])

    // Air is not a colour anyone was just using.
    expect(remember(recent, 0)).toBe(recent)

    for (let index = 20; index < 40; index += 1) recent = remember(recent, index)
    expect(recent).toHaveLength(RECENT_COLORS)
    expect(recent[0]).toBe(39)
})

test('a palette round-trips through the text format every pixel editor reads', () => {
    const palette = new Uint8Array(256 * 4)
    for (let i = 0; i < 256; i += 1) {
        palette.set([(i * 7) % 256, (i * 31) % 256, (i * 97) % 256, 255], i * 4)
    }

    const text = toHexPalette(palette)
    expect(text.split('\n').filter(line => line !== '')).toHaveLength(255)

    const back = fromHexPalette(text, new Uint8Array(256 * 4))
    // Entry 0 is never written and never read; every other entry survives the trip.
    expect([...back.subarray(4)]).toEqual([...palette.subarray(4)])
})

test('a palette file with junk in it loads the colours and skips the rest', () => {
    const base = new Uint8Array(256 * 4)
    const loaded = fromHexPalette('; Lospec\n\nff0000\nnot a colour\n#00ff00\n', base)
    expect([...loaded.subarray(4, 8)]).toEqual([255, 0, 0, 255])
    expect([...loaded.subarray(8, 12)]).toEqual([0, 255, 0, 255])
    expect([...loaded.subarray(12, 16)]).toEqual([0, 0, 0, 0])
})

test('writing one palette entry leaves the rest of the palette alone', () => {
    const palette = new Uint8Array(256 * 4)
    const next = withColor(palette, 5, '#3366ff')
    expect([...next.subarray(20, 24)]).toEqual([51, 102, 255, 255])
    expect(palette[20]).toBe(0)
    // A string that is not a colour changes nothing rather than writing black.
    expect([...withColor(next, 5, 'nope').subarray(20, 24)]).toEqual([51, 102, 255, 255])
})

test('the first free slot skips the colours the model is made of', () => {
    const grid = createVolume(4, 4, 4)
    setVoxel(grid, 0, 0, 0, 1)
    setVoxel(grid, 1, 0, 0, 2)
    expect(freeSlot(grid)).toBe(3)
})

test('replacing a colour moves voxels between entries and undoes in one step', () => {
    const grid = createVolume(8, 8, 8, new Uint8Array(256 * 4))
    for (let x = 0; x < 5; x += 1) setVoxel(grid, x, 0, 0, 4)
    setVoxel(grid, 6, 0, 0, 9)

    const draft = beginEdit(grid)
    expect(remapColor(draft, 4, 9)).toBe(5)
    expect(selectColor(draft.volume, 9).size).toBe(6)
    expect(selectColor(draft.volume, 4).size).toBe(0)

    const edit = commitEdit(draft)
    if (!edit) throw new Error('the replacement changed cells')
    expect(revertEdit(draft.volume, edit).data).toEqual(grid.data)

    // Replacing a colour with itself, or with air, is not a replacement.
    expect(remapColor(beginEdit(grid), 4, 4)).toBe(0)
    expect(remapColor(beginEdit(grid), 4, 0)).toBe(0)
})

test('replacing a colour leaves every voxel with the object that owned it', () => {
    const grid = createVolume(4, 4, 4, new Uint8Array(256 * 4))
    setVoxel(grid, 0, 0, 0, 4)
    grid.owner[0] = 3

    const draft = beginEdit(grid, 1)
    remapColor(draft, 4, 9)
    expect(draft.volume.owner[0]).toBe(3)
})
