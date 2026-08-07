import {expect, test} from 'bun:test'
import {eightDirections} from '../doc/cameras'
import {readVox} from '../vox/vox-file'
import {DEFAULT_COLUMNS, renderSheet} from './sheet'

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

const hash = (bytes: Uint8Array): string =>
    new Bun.CryptoHasher('sha256').update(bytes).digest('hex').slice(0, 16)

/**
 * The golden test the whole architecture exists to make possible: this is the exact sheet the
 * download button produces, hashed, with no browser and no GPU in the room. If a change moves a
 * pixel, this fails; if it moves a pixel deliberately, the new hash goes in this file.
 */
test('the eight-direction sheet of car.vox is byte-for-byte what it was', () => {
    const sheet = renderSheet(volume, eightDirections(volume), 64)

    expect([sheet.width, sheet.height]).toEqual([256, 128])
    expect([sheet.columns, sheet.rows]).toEqual([DEFAULT_COLUMNS, 2])
    expect(hash(sheet.color)).toBe('932d7d5d0b94dacf')
    expect(hash(sheet.normal)).toBe('44a88c24f8079b5f')
})

test('every cell holds a sprite, and no cell holds the one before it', () => {
    const cameras = eightDirections(volume)
    const sheet = renderSheet(volume, cameras, 64)

    const opaqueIn = (index: number): number => {
        const ox = (index % sheet.columns) * sheet.cell
        const oy = Math.floor(index / sheet.columns) * sheet.cell
        let count = 0
        for (let row = 0; row < sheet.cell; row += 1) {
            for (let px = 0; px < sheet.cell; px += 1) {
                if (sheet.color[((oy + row) * sheet.width + ox + px) * 4 + 3] === 255) count += 1
            }
        }
        return count
    }

    const counts = cameras.map((_camera, index) => opaqueIn(index))
    for (const count of counts) {
        expect(count).toBeGreaterThan(200)
        expect(count).toBeLessThan(64 * 64)
    }
    // Eight different directions of an asymmetric model are eight different silhouettes.
    expect(new Set(counts).size).toBeGreaterThan(3)
})

test('the colour sheet and the normal sheet agree on where the sprite is', () => {
    const sheet = renderSheet(volume, eightDirections(volume), 32)
    for (let i = 3; i < sheet.color.length; i += 4) {
        expect(sheet.normal[i]).toBe(sheet.color[i] ?? 0)
    }
})

test('a sheet of one camera is one cell, not a row of blanks', () => {
    const [first] = eightDirections(volume)
    const sheet = renderSheet(volume, first ? [first] : [], 32)
    expect([sheet.width, sheet.height, sheet.columns, sheet.rows]).toEqual([32, 32, 1, 1])
})
