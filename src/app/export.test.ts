import {expect, test} from 'bun:test'
import {readVox} from '../vox/vox-file'
import {initialState, reduce, type AppState} from './state'
import {writeExport, writeSheetMetadata, writeSprites} from './export'

/**
 * The three things an export writes, and the guard in front of all three.
 *
 * That guard is the interesting part — a sheet can be stale, and writing a stale one is silent —
 * and it had no test of its own. What covered it was a whole-window mount that monkey-patched
 * `URL.createObjectURL` and `HTMLAnchorElement.prototype.click`, then filtered the results by
 * filename to dodge a race with the export effect's own `CompressionStream`. The patching is still
 * the only way to watch a download, but nothing here needs a window to do it.
 */

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

/** Every filename an anchor was asked to download, in order. */
const downloads = async (run: () => Promise<void> | void): Promise<string[]> => {
    const written: string[] = []
    const realCreate = URL.createObjectURL
    const realRevoke = URL.revokeObjectURL
    const realClick = HTMLAnchorElement.prototype.click
    URL.createObjectURL = (): string => 'blob:test'
    URL.revokeObjectURL = (): void => undefined
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
        written.push(this.download)
    }
    try {
        await run()
        return written
    } finally {
        URL.createObjectURL = realCreate
        URL.revokeObjectURL = realRevoke
        HTMLAnchorElement.prototype.click = realClick
    }
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
    const fresh = initialState(volume, 'car.vox')

    expect(
        await downloads(async () => {
            await writeExport(fresh)
            await writeSprites(fresh)
            writeSheetMetadata(fresh)
        })
    ).toEqual([])
})

test('a stale sheet is no sheet at all, and writes nothing', async () => {
    // Adding a camera changes what the bake would have to have come from — see `sheet/baked.ts`.
    const moved = reduce(baked(), {type: 'capture'})

    expect(
        await downloads(async () => {
            await writeSprites(moved)
            writeSheetMetadata(moved)
        })
    ).toEqual([])
})

test('one PNG per camera, plus the JSON that says where each of them landed', async () => {
    const state = baked()

    const sprites = await downloads(async () => {
        await writeSprites(state)
    })
    expect(sprites).toHaveLength(state.cameras.length)
    expect(sprites.every(name => name.endsWith('.png'))).toBe(true)

    expect(
        await downloads(() => {
            writeSheetMetadata(state)
        })
    ).toEqual(['sprites.json'])
})

/*
 * Compared as a set of names, not as a list. `writeSheet` goes through a `CompressionStream`, which
 * settles on the macrotask queue rather than the microtask queue — so an export another test file
 * started can land inside this one's window, under the same filenames. The claim here is *which
 * maps a preset writes*, and a set says that exactly.
 */
test('the sheet is written as the preset asks, and no other map', async () => {
    const every = reduce(baked(), {type: 'output', output: {preset: 'Every map'}})
    // The preset is part of `sheetKey`, so changing it stales the bake — bake again to compare.
    const rebaked = reduce(every, {type: 'bake'})

    const two = await downloads(async () => {
        await writeExport(baked())
    })
    expect(new Set(two)).toEqual(new Set(['sprites.png', 'sprites-normal.png']))

    const all = await downloads(async () => {
        await writeExport(rebaked)
    })
    expect(new Set(all).size).toBe(8)
    expect(all).toContain('sprites-depth.png')
})
