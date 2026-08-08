import {afterEach, beforeEach, expect, test} from 'bun:test'
import {eightDirections} from '../doc/cameras'
import {encodePng} from '../image/png'
import {sheetMetadata} from '../sheet/metadata'
import {renderSheet, type Sheet} from '../sheet/sheet'
import {createVolume, setVoxel} from '../render/volume'
import {writeMetadata, writePalette, writeSheet, writeSheetMap, writeSprite} from './download'

/**
 * Every export in the app ends at one anchor click, so that anchor is where the test stands.
 *
 * The alternative is asserting on a `blob:` URL, which says nothing: happy-dom hands back an opaque
 * handle and there is no way to read it. Patching `createObjectURL` keeps the `Blob` itself, so a
 * test can ask what the artist would actually have got in their downloads folder — the bytes, not
 * just the fact that something was offered.
 */
interface Written {
    readonly name: string
    readonly type: string
    readonly blob: Blob
}

let written: Written[] = []
let handed: Blob[] = []
let revoked: string[] = []

const realCreate = URL.createObjectURL
const realRevoke = URL.revokeObjectURL
const realClick = HTMLAnchorElement.prototype.click

beforeEach(() => {
    written = []
    handed = []
    revoked = []
    URL.createObjectURL = (blob: Blob): string => {
        handed.push(blob)
        return `blob:test/${String(handed.length)}`
    }
    URL.revokeObjectURL = (url: string): void => {
        revoked.push(url)
    }
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
        const blob = handed[handed.length - 1]
        if (!blob) throw new Error('an anchor clicked with no object URL behind it')
        written.push({name: this.download, type: blob.type, blob})
    }
})

afterEach(() => {
    URL.createObjectURL = realCreate
    URL.revokeObjectURL = realRevoke
    HTMLAnchorElement.prototype.click = realClick
})

const names = (): string[] => written.map(entry => entry.name)

const only = (): Written => {
    const [first] = written
    if (!first || written.length !== 1) throw new Error(`expected one file, got ${names().join()}`)
    return first
}

const bytes = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer())

const volume = createVolume(8, 8, 8, new Uint8Array(256 * 4))
for (let x = 0; x < 8; x += 1)
    for (let y = 0; y < 8; y += 1) for (let z = 0; z < 4; z += 1) setVoxel(volume, x, y, z, 1)

const cameras = eightDirections(volume)

/** Small and padded: padding is where an off-by-one in the sprite cut shows up. */
const sheet: Sheet = renderSheet(volume, cameras, 8, ['color', 'normal', 'ao'], 2, 4)

test('the palette writes one .hex file with the text in it', async () => {
    writePalette('ff0000\n00ff00\n')

    expect(only().name).toBe('palette.hex')
    expect(only().type).toBe('text/plain')
    expect(await only().blob.text()).toBe('ff0000\n00ff00\n')
})

test('the metadata writes one .json file that parses back to what went in', async () => {
    const metadata = sheetMetadata(volume, cameras, sheet, true)
    writeMetadata(metadata)

    expect(only().name).toBe('sprites.json')
    expect(only().type).toBe('application/json')
    expect(JSON.parse(await only().blob.text())).toEqual(JSON.parse(JSON.stringify(metadata)))
})

test('the colour sheet is sprites.png and every other map carries its name', async () => {
    await writeSheetMap(sheet, 'color')
    await writeSheetMap(sheet, 'normal')
    await writeSheetMap(sheet, 'ao')

    expect(names()).toEqual(['sprites.png', 'sprites-normal.png', 'sprites-ao.png'])
    for (const entry of written) expect(entry.type).toBe('image/png')
})

test('a map the sheet was never baked with writes nothing', async () => {
    await writeSheetMap(sheet, 'emission')

    expect(written).toEqual([])
})

test('writing a sheet writes one file per map asked for, and skips the ones it lacks', async () => {
    await writeSheet(sheet, ['color', 'ao', 'depth'])

    expect(names().toSorted()).toEqual(['sprites-ao.png', 'sprites.png'])
})

test('every object URL handed out is revoked again', async () => {
    await writeSheet(sheet, ['color', 'normal'])
    writePalette('ffffff')

    expect(revoked.length).toBe(handed.length)
    expect(revoked.toSorted()).toEqual(['blob:test/1', 'blob:test/2', 'blob:test/3'])
})

test('one sprite is the cell out of the baked sheet, byte for byte', async () => {
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

    await writeSprite(sheet, index, 'Front Left')

    expect(only().name).toBe('front-left.png')
    expect(await bytes(only().blob)).toEqual(await encodePng(sheet.cell, sheet.cell, cut))
})

test('a sprite cut from a different cell is different pixels', async () => {
    await writeSprite(sheet, 0, 'front')
    await writeSprite(sheet, 3, 'back')

    const [front, back] = written
    if (!front || !back) throw new Error('two sprites should have been written')
    expect(await bytes(front.blob)).not.toEqual(await bytes(back.blob))
})

test('a sheet with no colour map writes no sprite', async () => {
    await writeSprite({...sheet, maps: {}}, 0, 'front')

    expect(written).toEqual([])
})
