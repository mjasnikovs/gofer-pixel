import {expect, test} from 'bun:test'
import {readVox} from '../vox/vox-file'
import {mountPanel, type Panel} from '../../test/panel'
import {memoryFiles, type Files} from '../doc/files'
import {shownVolume} from '../doc/objects'
import type {Sheet} from '../sheet/sheet'
import {ExportPanel} from './ExportPanel'
import {currentSheet, slicedFor} from './state'

/**
 * The export panel on its own, over the real reducer — see `test/panel.tsx`.
 *
 * Everything here is one panel reaching the document and the document reaching a bake, which is
 * what the panel is for. These were three whole-window mounts; the two derivations `App.tsx`
 * memoises are computed in the harness instead, from the same two functions the app uses.
 */

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

const open = (files: Files = memoryFiles()): Promise<Panel> =>
    mountPanel(volume, ({state, dispatch}) => (
        <ExportPanel
            state={state}
            dispatch={dispatch}
            files={files}
            volume={slicedFor(state, shownVolume(state.volume, state.objects))}
            sheet={currentSheet(state)}
        />
    ))

/** The baked sheet as the app would show it — derived, not stored. See `sheet/baked.ts`. */
const sheetOf = (panel: Panel): Sheet | undefined => currentSheet(panel.state())

test('padding, bounds and sprite size are the sheet’s own numbers', async () => {
    const panel = await open()

    await panel.click('2 pixels of padding')
    expect(panel.state().output.padding).toBe(2)

    // Astryx's Switch is a checkbox with a `<label for>` beside it, so it is reached by role.
    const box = panel.host.querySelector<HTMLElement>('.export-body input[role="switch"]')
    if (!box) throw new Error('no collision-box switch')
    const wasBoxed = panel.state().output.bounds
    await panel.act(() => {
        box.click()
    })
    expect(panel.state().output.bounds).toBe(!wasBoxed)

    await panel.click('32 px')
    await panel.click('Export sprite sheet')

    // Four across, eight cameras: two rows of 32 px cells with 2 px around and between.
    expect(sheetOf(panel)?.width).toBe(4 * 34 + 2)
    expect(sheetOf(panel)?.height).toBe(2 * 34 + 2)
    expect(sheetOf(panel)?.padding).toBe(2)
    expect(panel.state().output.bounds).toBe(!wasBoxed)

    await panel.unmount()
})

/*
 * Naming a preset is `globalThis.prompt`, which is why this test stubs a browser primitive rather
 * than clicking a field. That is the whole of what it adds over `state.test.ts`.
 */
test('saving a preset takes the name the artist typed, and a cancelled prompt saves nothing', async () => {
    const realPrompt = globalThis.prompt
    const answers: (string | null)[] = [null, 'Mine']
    globalThis.prompt = (): string | null => answers.shift() ?? null

    try {
        const panel = await open()
        const presets = (): number => panel.state().output.presets.length
        const before = presets()

        await panel.click('Save these maps as a preset')
        expect(presets()).toBe(before)

        await panel.click('Save these maps as a preset')
        expect(presets()).toBe(before + 1)
        expect(panel.state().output.preset).toBe('Mine')

        await panel.unmount()
    } finally {
        globalThis.prompt = realPrompt
    }
})

test('a preset changes which maps an export writes', async () => {
    const panel = await open()
    expect(panel.state().output.preset).toBe('Sprite Sheet (Auto)')

    // Astryx's Selector keeps its listbox in the tree, so the option is reachable without the
    // popover having been opened first.
    const option = [...panel.host.querySelectorAll<HTMLElement>('[role="option"]')].find(
        node => node.textContent.trim() === 'Every map'
    )
    if (!option) throw new Error('no "Every map" option')
    await panel.act(() => {
        option.click()
    })
    expect(panel.state().output.preset).toBe('Every map')

    // The smallest sprite the panel offers: what is being checked is which maps get baked, and
    // eight PNG encodes of a 256 × 128 sheet cost a second to prove nothing about that.
    await panel.click('32 px')
    await panel.click('Export sprite sheet')
    expect(Object.keys(sheetOf(panel)?.maps ?? {})).toHaveLength(8)

    await panel.unmount()
})

/*
 * The three menu items that write files, watched at the port they write through.
 *
 * They could not be asked this before. Each one reached for `document.createElement('a')` three
 * modules down, so the only way to see one land was to replace `HTMLAnchorElement.prototype.click`
 * for the whole process — and what came back was a filename and an opaque `blob:` handle. This is a
 * `Map` the test holds, and the panel was handed it.
 */
test('the export menu writes through the port it was handed, not through an anchor', async () => {
    const backing = new Map<string, string | Uint8Array>()
    const panel = await open(memoryFiles(backing))

    // The smallest sprite on offer: eight PNG encodes of a 256 px sheet prove nothing extra here.
    await panel.click('32 px')
    await panel.click('Export sprite sheet')

    // The menu renders into a portal on `document.body`, so the items are not inside the panel.
    await panel.click('More export options')
    const item = (label: string): HTMLElement => {
        const found = [...global.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
            node => node.textContent.trim() === label
        )
        if (!found) throw new Error(`no menu item "${label}"`)
        return found
    }

    await panel.act(() => {
        item('Download metadata JSON').click()
    })
    expect([...backing.keys()]).toEqual(['sprites.json'])

    await panel.act(() => {
        item('Download every sprite separately').click()
    })
    const sprites = [...backing.keys()].filter(name => name.endsWith('.png'))
    expect(sprites).toHaveLength(panel.state().cameras.length)

    await panel.unmount()
})
