import {expect, test} from 'bun:test'
import {readVox} from '../vox/vox-file'
import {colorCss, projectPalette, SWATCH_COLUMNS, SWATCH_ROWS, usedColors} from './palette'

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

test('the model’s own colours come first, and the grid is still full afterwards', () => {
    const used = usedColors(volume)
    expect(used.size).toBeGreaterThan(0)
    expect(used.has(0)).toBe(false)

    const swatches = projectPalette(volume)
    expect(swatches).toHaveLength(SWATCH_COLUMNS * SWATCH_ROWS)
    expect(swatches.slice(0, used.size).every(({isUsed}) => isUsed)).toBe(true)
    expect(swatches.slice(used.size).some(({isUsed}) => isUsed)).toBe(false)

    // Every entry is a distinct index, so clicking one swatch cannot select another.
    expect(new Set(swatches.map(({index}) => index)).size).toBe(swatches.length)
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
