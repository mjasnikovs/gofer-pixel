import {expect, test} from 'bun:test'
import {readVox} from '../vox/vox-file'
import {mountPanel, type Panel} from '../../test/panel'
import {ObjectsPanel} from './ObjectsPanel'
import type {AppState} from './state'

/**
 * The objects panel on its own, over the real reducer — see `test/panel.tsx`.
 *
 * These four tests were four whole-window mounts in `App.test.tsx` at 209 ms each. Every one of
 * them drives exactly this panel and asserts on exactly this panel's rules, and none of them ever
 * needed the other fourteen. What stayed in the window file is composition: effects, the keyboard
 * listener, the file dialogs and the one live viewport.
 */

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

const open = (): Promise<Panel> =>
    mountPanel(volume, ({state, dispatch}) => (
        <ObjectsPanel
            state={state}
            dispatch={dispatch}
        />
    ))

const rowsOf = (panel: Panel): HTMLElement[] => [
    ...panel.host.querySelectorAll<HTMLElement>('.object-list .object-name')
]

/** A controlled `<input>` only hears a value React did not set through the prototype setter. */
const type = async (panel: Panel, field: HTMLInputElement, text: string): Promise<void> => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await panel.act(() => {
        setter?.call(field, text)
        field.dispatchEvent(new Event('input', {bubbles: true}))
    })
}

const dialogText = (): string =>
    global.document.querySelector('dialog[open]')?.textContent.trim() ?? ''

const dialogTitle = (): string =>
    global.document.querySelector('dialog[open] h1, dialog[open] h2')?.textContent.trim() ?? ''

const dialogButton = (label: string): HTMLElement => {
    const found = [...global.document.querySelectorAll<HTMLElement>('dialog[open] button')].find(
        node => node.getAttribute('aria-label') === label || node.textContent.trim() === label
    )
    if (!found) throw new Error(`no "${label}" in the dialog`)
    return found
}

test('the objects panel’s switches and its search reach the document', async () => {
    const panel = await open()
    const objects = (): AppState['objects']['list'] => panel.state().objects.list

    await panel.click('Add an object')
    expect(objects()).toHaveLength(2)
    const added = objects()[1]?.name ?? ''

    await panel.click(`Show ${added}`)
    expect(objects()[1]?.hidden).toBe(true)

    await panel.click(`Lock ${added}`)
    expect(objects()[1]?.locked).toBe(true)

    // Solo is one field on the list, not `hidden` on every other row: turning it off has to put
    // back exactly what was hidden before, and a per-row flag could not.
    await panel.click(`Show only ${added}`)
    expect(panel.state().objects.solo).toBe(objects()[1]?.id)
    await panel.click(`Show only ${added}`)
    expect(panel.state().objects.solo).toBeUndefined()

    await panel.click(`Duplicate ${added}`)
    expect(objects()).toHaveLength(3)

    // The search box only appears past `SEARCH_FROM`, so there has to be something to search.
    for (let step = 0; step < 7; step += 1)
        await panel.dispatch({type: 'object', op: {kind: 'add'}})
    const rows = (): number => panel.host.querySelectorAll('.object-list [role="radio"]').length
    expect(rows()).toBeGreaterThan(8)

    const field = panel.host.querySelector<HTMLInputElement>('.object-body input[type="text"]')
    if (!field) throw new Error('no search box')
    await type(panel, field, 'nothing-matches-this')
    expect(panel.state().search).toBe('nothing-matches-this')

    // Nothing left, and the list says so rather than showing an empty box.
    expect(rows()).toBe(0)
    expect(panel.host.querySelector('.object-list')?.textContent).toBe('No object matches that.')

    await panel.unmount()
})

test('a name renames in place, and Enter and Escape both put the row back', async () => {
    const panel = await open()
    await panel.dispatch({type: 'object', op: {kind: 'add'}})

    const [, added] = rowsOf(panel)
    if (!added) throw new Error('no second object')
    await panel.act(() => {
        added.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}))
    })

    const field = panel.host.querySelector<HTMLInputElement>('.object-list input[type="text"]')
    if (!field) throw new Error('the row should have turned into a field')
    await type(panel, field, 'Roof')
    expect(panel.state().objects.list[1]?.name).toBe('Roof')

    await panel.act(() => {
        field.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
    })
    expect(panel.host.querySelector('.object-list input[type="text"]')).toBeNull()
    expect(rowsOf(panel)[1]?.textContent).toContain('Roof')

    // Escape leaves it too — a field that only closes on Enter is a field with no way out.
    await panel.act(() => {
        rowsOf(panel)[1]?.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}))
    })
    const again = panel.host.querySelector<HTMLElement>('.object-list input[type="text"]')
    await panel.act(() => {
        again?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))
    })
    expect(panel.host.querySelector('.object-list input[type="text"]')).toBeNull()

    await panel.unmount()
})

/*
 * "You can undo it" is not a reason to let a stray click cost an hour in silence, so the dialog
 * says the name and the voxel count — the whole of what is about to be lost.
 */
test('deleting an object asks first, and says how many voxels go with it', async () => {
    const panel = await open()
    await panel.dispatch({type: 'object', op: {kind: 'add'}})
    const empty = panel.state().objects.list[1]?.name ?? ''

    await panel.click(`Delete ${empty}`)
    expect(dialogTitle()).toBe(`Delete ${empty}?`)
    expect(dialogText()).toContain('It is empty')

    // Cancelling leaves the object where it was.
    await panel.act(() => {
        dialogButton('Cancel').click()
    })
    expect(panel.state().objects.list).toHaveLength(2)

    // The one with the voxels in it counts them instead.
    const model = panel.state().objects.list[0]?.name ?? ''
    await panel.click(`Delete ${model}`)
    expect(dialogText()).toContain('478 voxels')

    await panel.act(() => {
        dialogButton('Delete').click()
    })
    expect(panel.state().objects.list).toHaveLength(1)
    expect(panel.state().objects.list[0]?.name).toBe(empty)

    await panel.unmount()
})

test('a row drags along the list to reorder it, and the drag dies with the pointer', async () => {
    const panel = await open()
    for (let step = 0; step < 2; step += 1)
        await panel.dispatch({type: 'object', op: {kind: 'add'}})
    const order = (): string[] => panel.state().objects.list.map(entry => entry.name)
    const before = order()
    expect(before).toHaveLength(3)

    const [first, , third] = rowsOf(panel)
    if (!first || !third) throw new Error('three rows expected')

    // The drag starts on the name and nowhere else — starting it on the row would arm a reorder
    // every time one of the switches beside it was pressed.
    await panel.act(() => {
        first.dispatchEvent(new Event('pointerdown', {bubbles: true}))
    })
    await panel.act(() => {
        third.dispatchEvent(new Event('pointerover', {bubbles: true}))
    })
    await panel.act(() => {
        third.dispatchEvent(new Event('pointerup', {bubbles: true}))
    })

    expect(order()).not.toEqual(before)
    expect(order().toSorted()).toEqual(before.toSorted())

    // A pointer that leaves the list has dropped the row: the next hover must not keep reordering.
    const dropped = order()
    await panel.act(() => {
        rowsOf(panel)[0]?.dispatchEvent(new Event('pointerdown', {bubbles: true}))
    })
    await panel.act(() => {
        panel.host
            .querySelector('.object-list')
            ?.dispatchEvent(new Event('pointerout', {bubbles: true}))
    })
    await panel.act(() => {
        rowsOf(panel)[2]?.dispatchEvent(new Event('pointerover', {bubbles: true}))
    })
    expect(order()).toEqual(dropped)

    await panel.unmount()
})
