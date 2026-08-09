import {expect, test} from 'bun:test'
import {eightDirections} from '../doc/cameras'
import {memoryFiles} from '../doc/files'
import {encodePng} from '../image/png'
import {sheetMetadata} from '../sheet/metadata'
import {renderSheet, type Sheet} from '../sheet/sheet'
import {createVolume, setVoxel} from '../render/volume'
import {writeMetadata, writePalette, writeSheet, writeSheetMap, writeSprite} from './download'

/**
 * Every export goes through `Files.write`, so the test stands at the port and holds the disk.
 *
 * It used to stand at the anchor — replacing `URL.createObjectURL`, `URL.revokeObjectURL` and
 * `HTMLAnchorElement.prototype.click` before every case in this file, because that was the only way
 * to see a download happen. It could see *that* one happened and never *what* was in it: happy-dom
 * hands back an opaque `blob:` handle and there is nothing behind it to read.
 *
 * A `Map` has the bytes. The anchor is `doc/files.ts`'s now, and `files.test.ts` is where it is
 * watched — once, for both callers, instead of in every file that writes something.
 */
const disk = () => {
    const backing = new Map<string, string | Uint8Array>()
    return {
        files: memoryFiles(backing),
        names: (): string[] => [...backing.keys()],
        text: (name: string): string => {
            const held = backing.get(name)
            if (typeof held !== 'string') throw new Error(`${name} is not text`)
            return held
        },
        bytes: (name: string): Uint8Array => {
            const held = backing.get(name)
            if (held === undefined || typeof held === 'string')
                throw new Error(`${name} is not bytes`)
            return held
        }
    }
}

const volume = createVolume(8, 8, 8, new Uint8Array(256 * 4))
for (let x = 0; x < 8; x += 1)
    for (let y = 0; y < 8; y += 1) for (let z = 0; z < 4; z += 1) setVoxel(volume, x, y, z, 1)

const cameras = eightDirections(volume)

/** Small and padded: padding is where an off-by-one in the sprite cut shows up. */
const sheet: Sheet = renderSheet(volume, cameras, 8, ['color', 'normal', 'ao'], 2, 4)

test('the palette writes one .hex file with the text in it', async () => {
    const out = disk()

    await writePalette(out.files, 'ff0000\n00ff00\n')

    expect(out.names()).toEqual(['palette.hex'])
    expect(out.text('palette.hex')).toBe('ff0000\n00ff00\n')
})

test('the metadata writes one .json file that parses back to what went in', async () => {
    const out = disk()
    const metadata = sheetMetadata(volume, cameras, sheet, true)

    await writeMetadata(out.files, metadata)

    expect(out.names()).toEqual(['sprites.json'])
    expect(JSON.parse(out.text('sprites.json'))).toEqual(JSON.parse(JSON.stringify(metadata)))
})

test('the colour sheet is sprites.png and every other map carries its name', async () => {
    const out = disk()

    await writeSheetMap(out.files, sheet, 'color')
    await writeSheetMap(out.files, sheet, 'normal')
    await writeSheetMap(out.files, sheet, 'ao')

    expect(out.names()).toEqual(['sprites.png', 'sprites-normal.png', 'sprites-ao.png'])
})

test('a map the sheet was never baked with writes nothing', async () => {
    const out = disk()

    await writeSheetMap(out.files, sheet, 'emission')

    expect(out.names()).toEqual([])
})

test('writing a sheet writes one file per map asked for, and skips the ones it lacks', async () => {
    const out = disk()

    await writeSheet(out.files, sheet, ['color', 'ao', 'depth'])

    expect(out.names().toSorted()).toEqual(['sprites-ao.png', 'sprites.png'])
})

test('one sprite is the cell out of the baked sheet, byte for byte', async () => {
    const out = disk()
    const plane = sheet.maps.color
    if (!plane) throw new Error('the colour map is always baked')

    // The third cell, cut by hand the long way round, is what the export has to equal.
    const index = 2
    const stride = sheet.cell + sheet.padding
    const ox = sheet.padding + (index % sheet.columns) * stride
    const oy = sheet.padding + Math.floor(index / sheet.columns) * stride
    const cut = new Uint8Array(sheet.cell * sheet.cell * 4)
    for (let row = 0; row < sheet.cell; row += 1) {
        const from = ((oy + row) * sheet.width + ox) * 4
        cut.set(plane.subarray(from, from + sheet.cell * 4), row * sheet.cell * 4)
    }

    await writeSprite(out.files, sheet, index, 'Front Left')

    expect(out.names()).toEqual(['front-left.png'])
    expect(out.bytes('front-left.png')).toEqual(await encodePng(sheet.cell, sheet.cell, cut))
})

test('a sprite cut from a different cell is different pixels', async () => {
    const out = disk()

    await writeSprite(out.files, sheet, 0, 'front')
    await writeSprite(out.files, sheet, 3, 'back')

    expect(out.bytes('front.png')).not.toEqual(out.bytes('back.png'))
})

test('a sheet with no colour map writes no sprite', async () => {
    const out = disk()

    await writeSprite(out.files, {...sheet, maps: {}}, 0, 'front')

    expect(out.names()).toEqual([])
})
