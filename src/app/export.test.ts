import {expect, test} from 'bun:test'
import {memoryFiles} from '../doc/files'
import {renderSheet, SHEET_MAPS, type Sheet} from '../sheet/sheet'
import {readVox} from '../vox/vox-file'
import {initialState, reduce, type AppState} from './state'
import {writeExportPack, writeLoose, writeSheetMetadata, writeSprites} from './export'

/**
 * The four things an export writes, over the sheet the dialog is showing.
 *
 * They used to be watched through three patched globals, which could see that an anchor was clicked
 * and nothing about what was on it; and because the patches were global, an export another test
 * file had started could land inside this one's window under the same filenames. Every claim here
 * had to be softened to a *set* of names to survive that. Each test holds its own disk now.
 *
 * There is no longer a stale-sheet case to test, and that is the point of the change these tests
 * moved through. The sheet used to live in the state and outlive the click that made it, so every
 * writer opened with a guard and `sheet/baked.ts` existed to answer "is that still the sheet for
 * this document?". The dialog rebakes on every input it can see, so the sheet it hands over cannot
 * be a sheet for something else.
 */

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

/** A disk of this test's own, and every filename that landed on it. */
const disk = () => {
    const backing = new Map<string, string | Uint8Array>()
    return {
        files: memoryFiles(backing),
        names: (): string[] => [...backing.keys()],
        bytes: (name: string): Uint8Array => {
            const held = backing.get(name)
            if (!(held instanceof Uint8Array)) throw new Error(`${name} is not bytes`)
            return held
        }
    }
}

/** The document, and the sheet the dialog would bake from it — 32 px, so eight PNGs cost no time. */
const state: AppState = reduce(initialState(volume, 'Knight.gpix'), {
    type: 'output',
    output: {cell: 32}
})
const sheet: Sheet = renderSheet(volume, state.cameras, 32, SHEET_MAPS, 0)

test('one PNG per camera, plus the JSON that says where each of them landed', async () => {
    const out = disk()

    await writeSprites(out.files, state, sheet)
    expect(out.names()).toHaveLength(state.cameras.length)
    expect(out.names().every(name => name.endsWith('.png'))).toBe(true)

    await writeSheetMetadata(out.files, state, sheet)
    expect(out.names().at(-1)).toBe('sprites.json')
})

test('the loose PNGs are the maps that were asked for, and no others', async () => {
    const two = disk()
    await writeLoose(two.files, sheet, ['color', 'normal'])
    expect(two.names().toSorted()).toEqual(['sprites-normal.png', 'sprites.png'])

    const all = disk()
    await writeLoose(all.files, sheet, SHEET_MAPS)
    expect(all.names()).toHaveLength(8)
    expect(all.names()).toContain('sprites-depth.png')
})

/*
 * The pack is one file, named after the document, and it carries the JSON as well as the maps —
 * `FEATURESET.md` §37's "one-click". Read back through the central directory, which is what an
 * unarchiver reads; the encoder's own tests are `image/zip.test.ts`.
 */
test('the pack is one zip, named after the document, holding the maps and the JSON', async () => {
    const out = disk()
    await writeExportPack(out.files, state, sheet, ['color', 'normal'])
    expect(out.names()).toEqual(['knight-gpix.zip'])

    const archive = out.bytes('knight-gpix.zip')
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
    const end = archive.length - 22
    const count = view.getUint16(end + 10, true)
    let at = view.getUint32(end + 16, true)
    const decoder = new TextDecoder()
    const inside: string[] = []
    for (let i = 0; i < count; i += 1) {
        const length = view.getUint16(at + 28, true)
        inside.push(decoder.decode(archive.subarray(at + 46, at + 46 + length)))
        at += 46 + length
    }
    expect(inside).toEqual(['sprites.png', 'sprites-normal.png', 'sprites.json'])
})

/*
 * Everything the artist ticked and nothing else. A pack of every map is nine entries, and the JSON
 * is always the last of them because an engine that reads the JSON needs it whatever else is there.
 */
test('the pack carries exactly the maps it was given', async () => {
    const out = disk()
    await writeExportPack(out.files, state, sheet, SHEET_MAPS)
    const archive = out.bytes('knight-gpix.zip')
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
    expect(view.getUint16(archive.length - 22 + 10, true)).toBe(9)
})
