import {expect, test} from 'bun:test'
import {eightDirections} from '../doc/cameras'
import {initialObjects} from '../doc/objects'
import {sheetMetadata} from './metadata'
import {readVox} from '../vox/vox-file'
import {
    DEFAULT_COLUMNS,
    renderSheet,
    SHEET_MAPS,
    sheetColor,
    sheetPlane,
    type Sheet,
    type SheetMap
} from './sheet'

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

const hash = (bytes: Uint8Array): string =>
    new Bun.CryptoHasher('sha256').update(bytes).digest('hex').slice(0, 16)

/**
 * Two sheets for the whole file, because rendering one is real work — eight sprites at 64 px is
 * about 30 ms of raycasting, and a fresh one per test would put a fifth of a second into a gate
 * whose whole point is that it costs nothing.
 */
initialObjects(volume)
const cameras = eightDirections(volume)
const big = renderSheet(volume, cameras, 64)
const plane = (sheet: Sheet, map: SheetMap): Uint8Array =>
    sheetPlane(sheet, map) ?? new Uint8Array(0)
const small = renderSheet(volume, cameras, 32)

/**
 * The golden test the whole architecture exists to make possible: this is the exact sheet the
 * download button produces, hashed, with no browser and no GPU in the room. If a change moves a
 * pixel, this fails; if it moves a pixel deliberately, the new hash goes in this file.
 */
test('a sheet builds only the maps it was asked for', () => {
    const two = renderSheet(volume, cameras, 32, ['normal'])
    expect(Object.keys(two.maps).sort()).toEqual(['color', 'normal'])
    expect(sheetPlane(two, 'ao')).toBeUndefined()
    // Colour is always there: it is what the preview and the packing are made of.
    expect(sheetColor(two).length).toBe(two.width * two.height * 4)
})

test('the eight-direction sheet of car.vox is byte-for-byte what it was', () => {
    const sheet = big
    expect([sheet.width, sheet.height]).toEqual([256, 128])
    expect([sheet.columns, sheet.rows]).toEqual([DEFAULT_COLUMNS, 2])
    expect(hash(plane(sheet, 'color'))).toBe('932d7d5d0b94dacf')
    expect(hash(plane(sheet, 'normal'))).toBe('44a88c24f8079b5f')
})

/**
 * The other four maps, hashed the same way. Emission is the odd one: `car.vox` has no emissive
 * colours, so its emission sheet is a black silhouette on transparent — which is the correct answer
 * and worth pinning, because a bug that made every voxel glow would look like a feature.
 */
test('every map of the sheet is byte-for-byte what it was', () => {
    const sheet = big
    const golden: Record<string, string> = {
        color: '932d7d5d0b94dacf',
        normal: '44a88c24f8079b5f',
        depth: '8bfdc8195783092e',
        height: 'bfb88f409dae4a29',
        ao: 'bdc5da61f04cf05e',
        emission: 'c2bf911997b4cc37',
        index: 'ee584af307914d2e',
        // Every voxel of `car.vox` belongs to the one object it opened as, so this is a silhouette
        // of ones — which is the right answer and worth pinning, because a bug that left it blank
        // would look exactly like a model with no objects in it.
        object: '7324b890fc196f40'
    }
    for (const map of SHEET_MAPS) {
        expect(`${map}:${hash(plane(sheet, map))}`).toBe(`${map}:${golden[map] ?? ''}`)
    }
})

test('depth and height are exact complements wherever the sprite is', () => {
    const sheet = small
    let opaque = 0
    for (let i = 0; i < plane(sheet, 'depth').length; i += 4) {
        if (plane(sheet, 'depth')[i + 3] !== 255) continue
        opaque += 1
        expect((plane(sheet, 'depth')[i] ?? 0) + (plane(sheet, 'height')[i] ?? 0)).toBe(255)
    }
    expect(opaque).toBeGreaterThan(200)
    // Not one flat grey: normalising across the ray's full range instead of the model's own
    // diagonal is the mistake that produces exactly that, and it looks like a working map.
    const shades = new Set<number>()
    for (let i = 0; i < plane(sheet, 'depth').length; i += 4) {
        if (plane(sheet, 'depth')[i + 3] === 255) shades.add(plane(sheet, 'depth')[i] ?? 0)
    }
    expect(shades.size).toBeGreaterThan(20)
})

test('occlusion is dark in the corners and open on the outside', () => {
    const sheet = small
    const shades = new Set<number>()
    for (let i = 0; i < plane(sheet, 'ao').length; i += 4) {
        if (plane(sheet, 'ao')[i + 3] === 255) shades.add(plane(sheet, 'ao')[i] ?? 0)
    }
    // A flat per-face occlusion would give four values; the interpolated one gives a spread.
    expect(shades.size).toBeGreaterThan(20)
    expect(Math.max(...shades)).toBe(255)
    expect(Math.min(...shades)).toBeLessThan(200)
})

test('every cell holds a sprite, and no cell holds the one before it', () => {
    const sheet = big

    const opaqueIn = (index: number): number => {
        const ox = (index % sheet.columns) * sheet.cell
        const oy = Math.floor(index / sheet.columns) * sheet.cell
        let count = 0
        for (let row = 0; row < sheet.cell; row += 1) {
            for (let px = 0; px < sheet.cell; px += 1) {
                if (plane(sheet, 'color')[((oy + row) * sheet.width + ox + px) * 4 + 3] === 255)
                    count += 1
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
    const sheet = small
    for (let i = 3; i < plane(sheet, 'color').length; i += 4) {
        expect(plane(sheet, 'normal')[i]).toBe(plane(sheet, 'color')[i] ?? 0)
    }
})

test('a sheet of one camera is one cell, not a row of blanks', () => {
    const [first] = cameras
    const sheet = renderSheet(volume, first ? [first] : [], 32)
    expect([sheet.width, sheet.height, sheet.columns, sheet.rows]).toEqual([32, 32, 1, 1])
})

test('padding sits between the cells and around the outside', () => {
    const padded = renderSheet(volume, cameras, 32, ['color'], 2)
    // Four across, two down, two pixels between and two more all the way round.
    expect([padded.width, padded.height]).toEqual([4 * 34 + 2, 2 * 34 + 2])
    expect(padded.padding).toBe(2)

    // The gutters are transparent: nothing bled into them and nothing was drawn there.
    const colour = sheetColor(padded)
    for (let column = 0; column < padded.width; column += 1) {
        expect(colour[column * 4 + 3]).toBe(0)
    }
    for (let row = 0; row < padded.height; row += 1) {
        expect(colour[(row * padded.width + 33) * 4 + 3]).toBe(0)
    }
})

test('the metadata places every sprite, names it, and pivots on the model rather than the art', () => {
    const meta = sheetMetadata(volume, cameras, big, true)
    expect(meta.sprites).toHaveLength(8)
    expect(meta.sprites[0]?.name).toBe('Front')
    expect(meta.cell).toBe(64)
    expect(meta.maps).toContain('color')

    // Cells are laid out in list order, and the entry says where each one actually is.
    expect(meta.sprites[0]).toMatchObject({x: 0, y: 0})
    expect(meta.sprites[4]).toMatchObject({x: 0, y: 64})

    // No pan and no zoom difference across the ring, so every sprite pivots on the same pixel.
    expect(
        new Set(meta.sprites.map(entry => `${String(entry.pivotX)},${String(entry.pivotY)}`)).size
    ).toBe(1)

    // The bounds are the opaque box, so they are inside the cell and not the whole of it.
    for (const entry of meta.sprites) {
        if (!entry.bounds) throw new Error('every sprite of car.vox has artwork in it')
        expect(entry.bounds.width).toBeLessThanOrEqual(64)
        expect(entry.bounds.width).toBeGreaterThan(0)
    }
    expect(sheetMetadata(volume, cameras, big, false).sprites[0]?.bounds).toBeUndefined()
})
