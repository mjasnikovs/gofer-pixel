import {expect, test} from 'bun:test'
import {readVox} from '../vox/vox-file'
import {mountPanel, type Panel} from '../../test/panel'
import {Header} from './Header'

/**
 * The header and its menu, over the real reducer — see `test/panel.tsx`.
 *
 * The snapshot list is a prop rather than state, because it comes off the autosave store and the
 * store is a port. So what is testable here is what the header *does with* the list, which is the
 * part that had a bug: two strokes inside one second are two snapshots, one label, and a duplicate
 * React key.
 */

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

const at = Date.parse('2026-08-07T19:11:18.000Z')

const open = (restores: readonly {key: string; at: number; name: string}[] = []): Promise<Panel> =>
    mountPanel(volume, ({state, dispatch}) => (
        <Header
            state={state}
            dispatch={dispatch}
            restores={restores}
            onRestore={() => undefined}
            onForget={() => undefined}
            overwrites
            onNew={() => undefined}
            onOpen={() => undefined}
            onSave={() => undefined}
            onSaveAs={() => undefined}
            onGenerate={() => undefined}
        />
    ))

const menuLabels = (): string[] =>
    [...global.document.querySelectorAll('[role="menuitem"]')].map(node => node.textContent.trim())

const openMenu = async (panel: Panel): Promise<void> => {
    await panel.click('Main menu')
}

test('two snapshots in the same second are two distinct entries in the menu', async () => {
    // Autosave fires per committed edit, so this is the ordinary case, not a corner one: two
    // strokes inside a second used to render two menu items with one React key.
    const panel = await open([
        {key: 'gofer-pixel/snapshot/a', at, name: 'car.vox'},
        {key: 'gofer-pixel/snapshot/b', at: at + 400, name: 'car.vox'}
    ])
    await openMenu(panel)

    const restores = menuLabels().filter(label => label.startsWith('Restore'))
    expect(restores).toHaveLength(2)
    expect(new Set(restores).size).toBe(2)

    await panel.unmount()
})

test('with no snapshots there is nothing to restore', async () => {
    const panel = await open()
    await openMenu(panel)

    expect(menuLabels().some(label => label.startsWith('Restore'))).toBe(false)

    await panel.unmount()
})

test('the header says the document’s name, its size and whether it is saved', async () => {
    const panel = await open()
    const said = (): string => panel.host.querySelector('.app-header')?.textContent ?? ''

    expect(said()).toContain('car.vox')
    expect(said()).toContain('16 × 10 × 7')
    expect(said()).not.toContain('Unsaved changes')

    // Anything that touches the document marks it unsaved, and the header is where that is said.
    await panel.dispatch({type: 'object', op: {kind: 'add'}})
    expect(said()).toContain('Unsaved changes')

    await panel.unmount()
})
