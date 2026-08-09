import {expect, test} from 'bun:test'
import {memoryFiles} from '../doc/files'
import {readVox} from '../vox/vox-file'
import {initialState, reduce, type AppState} from './state'
import {writeExport, writeSheetMetadata, writeSprites} from './export'

/**
 * The three things an export writes, and the guard in front of all three.
 *
 * That guard is the interesting part — a sheet can be stale, and writing a stale one is silent.
 * It used to be watched through three patched globals, which could see that an anchor was clicked
 * and nothing about what was on it; and because the patches were global, an export another test
 * file had started could land inside this one's window under the same filenames. Every claim here
 * had to be softened to a *set* of names to survive that.
 *
 * Each test holds its own disk now, so the race is gone and a list can be a list.
 */

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

/** A disk of this test's own, and every filename that landed on it. */
const disk = () => {
    const backing = new Map<string, string | Uint8Array>()
    return {files: memoryFiles(backing), names: (): string[] => [...backing.keys()]}
}

/** The document, baked, at the smallest sprite the panel offers — eight PNGs, not eight seconds. */
const baked = (): AppState => {
    const small = reduce(initialState(volume, 'car.vox'), {
        type: 'output',
        output: {cell: 32}
    })
    return reduce(small, {type: 'bake'})
}

test('nothing is written until there is a sheet to cut it from', async () => {
    const out = disk()
    const fresh = initialState(volume, 'car.vox')

    await writeExport(out.files, fresh)
    await writeSprites(out.files, fresh)
    await writeSheetMetadata(out.files, fresh)

    expect(out.names()).toEqual([])
})

test('a stale sheet is no sheet at all, and writes nothing', async () => {
    const out = disk()
    // Adding a camera changes what the bake would have to have come from — see `sheet/baked.ts`.
    const moved = reduce(baked(), {type: 'capture'})

    await writeSprites(out.files, moved)
    await writeSheetMetadata(out.files, moved)

    expect(out.names()).toEqual([])
})

test('one PNG per camera, plus the JSON that says where each of them landed', async () => {
    const out = disk()
    const state = baked()

    await writeSprites(out.files, state)
    expect(out.names()).toHaveLength(state.cameras.length)
    expect(out.names().every(name => name.endsWith('.png'))).toBe(true)

    await writeSheetMetadata(out.files, state)
    expect(out.names().at(-1)).toBe('sprites.json')
})

test('the sheet is written as the preset asks, and no other map', async () => {
    const two = disk()
    await writeExport(two.files, baked())
    expect(two.names().toSorted()).toEqual(['sprites-normal.png', 'sprites.png'])

    const every = reduce(baked(), {type: 'output', output: {preset: 'Every map'}})
    // The preset is part of `sheetKey`, so changing it stales the bake — bake again to compare.
    const all = disk()
    await writeExport(all.files, reduce(every, {type: 'bake'}))
    expect(all.names()).toHaveLength(8)
    expect(all.names()).toContain('sprites-depth.png')
})
