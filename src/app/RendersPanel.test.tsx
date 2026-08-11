import {expect, test} from 'bun:test'
import {readVox} from '../vox/vox-file'
import {mountPanel, type Panel} from '../../test/panel'
import {shownVolume} from '../doc/objects'
import {RendersPanel} from './RendersPanel'
import {ViewsStrip} from './ViewsStrip'
import {slicedFor} from './state'

/**
 * The renders panel and the views strip, over the real reducer — see `test/panel.tsx`.
 *
 * They are in one file because the camera list is the subject of both: the strip is where a camera
 * is chosen and deleted, and the panel is what draws the one that is chosen. Every assertion here
 * used to cost a whole window.
 */

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

const open = (): Promise<Panel> =>
    mountPanel(volume, ({state, dispatch}) => {
        const shown = slicedFor(state, shownVolume(state.volume, state.objects))
        return (
            <>
                <ViewsStrip
                    state={state}
                    dispatch={dispatch}
                    volume={shown}
                />
                <RendersPanel
                    state={state}
                    dispatch={dispatch}
                    volume={shown}
                    camera={state.cameras.find(({id}) => id === state.previewed)}
                />
            </>
        )
    })

/** A control inside one region, when the same label exists in both. */
const within = (panel: Panel, selector: string, label: string): HTMLElement => {
    const region = panel.host.querySelector<HTMLElement>(selector)
    if (!region) throw new Error(`no ${selector}`)
    const found = [...region.querySelectorAll<HTMLElement>('button, input')].find(
        node => node.getAttribute('aria-label') === label || node.textContent.trim() === label
    )
    if (!found) throw new Error(`nothing labelled "${label}" in ${selector}`)
    return found
}

test('picking a map redraws the preview, and only Normal brings the light check with it', async () => {
    const panel = await open()
    const preview = (): Element | null => panel.host.querySelector('canvas.render-canvas')

    expect(panel.state().map).toBe(0)
    expect(panel.host.querySelector('.normal-check')).toBeNull()

    await panel.click('Normal')
    expect(panel.state().map).toBe(1)
    expect(panel.host.querySelector('.normal-check')).not.toBeNull()
    expect(panel.host.textContent).toContain('% of the sprite faces the light')
    expect(panel.host.textContent).toContain('+X right, +Y up, +Z out of the screen')

    await panel.click('AO')
    expect(panel.state().map).toBe(4)
    expect(panel.host.querySelector('.normal-check')).toBeNull()
    expect(preview()).not.toBeNull()

    await panel.unmount()
})

test('the preview size is the sprite size, not the size of the box it sits in', async () => {
    const panel = await open()
    const preview = (): Element | null => panel.host.querySelector('canvas.render-canvas')

    expect(preview()?.getAttribute('data-pixels')).toBe('64x64')

    await panel.click('Preview at 16 pixels')
    expect(panel.state().preview).toBe(16)
    expect(preview()?.getAttribute('data-pixels')).toBe('16x16')

    // And the light check follows it, so both halves of the diagnostic show the same pixels.
    await panel.click('Normal')
    expect(panel.host.querySelector('.normal-check canvas')?.getAttribute('data-pixels')).toBe(
        '16x16'
    )

    await panel.unmount()
})

test('with every camera deleted the render panel says so instead of showing a blank box', async () => {
    const panel = await open()

    // Selected, deleted, selected again: the button acts on the chosen camera and the choice does
    // not survive the deletion.
    for (let step = 0; step < 8; step += 1) {
        const next = panel.state().cameras[0]
        if (!next) break
        await panel.act(() => {
            within(panel, '.views-strip', next.name).click()
        })
        await panel.click('Delete camera')
    }

    expect(panel.state().cameras).toEqual([])
    expect(panel.host.querySelector('.render-preview')?.textContent).toBe(
        'No cameras — capture one to preview its maps.'
    )
    expect(panel.host.querySelector('canvas.render-canvas')).toBeNull()

    await panel.unmount()
})

/*
 * Capture is the strip's one button that adds rather than rearranges, and it is on the strip twice
 * — the header when there are cameras, the empty state when there are none. Both are the same call,
 * which is what stops the empty strip becoming a dead end.
 */
test('capture adds the live view, from the header and from the empty strip alike', async () => {
    const panel = await open()
    expect(panel.state().cameras).toHaveLength(8)

    await panel.click('Capture view as a camera')
    const grown = panel.state().cameras
    expect(grown).toHaveLength(9)
    // The new one is the chosen one: the artist captured it to work on it.
    expect(panel.state().selected).toBe(grown[grown.length - 1]?.id)

    // Empty the strip, and the button that is left is the same one.
    for (let step = 0; step < 9; step += 1) {
        const next = panel.state().cameras[0]
        if (!next) break
        await panel.act(() => {
            within(panel, '.views-strip', next.name).click()
        })
        await panel.click('Delete camera')
    }
    expect(panel.state().cameras).toEqual([])

    await panel.click('Capture view')
    expect(panel.state().cameras).toHaveLength(1)

    await panel.unmount()
})

test('the views strip rebuilds, aligns, duplicates, deletes and reorders the camera list', async () => {
    const panel = await open()
    const names = (): string[] => panel.state().cameras.map(entry => entry.name)

    expect(names()).toHaveLength(8)

    await panel.click('Create 4 directions')
    expect(names()).toHaveLength(4)

    await panel.act(() => {
        within(panel, '.views-strip', 'Right').click()
    })
    await panel.click('Duplicate camera')
    expect(names()).toHaveLength(5)

    await panel.click('Delete camera')
    expect(names()).toHaveLength(4)

    // Align turns the live view to the nearest stop, which is what makes a captured camera square.
    await panel.dispatch({
        type: 'orbit',
        event: {type: 'pointerdown', x: 100, y: 100, secondary: false},
        height: 512
    })
    await panel.dispatch({type: 'orbit', event: {type: 'pointermove', x: 137, y: 118}, height: 512})
    await panel.dispatch({type: 'orbit', event: {type: 'pointerup'}, height: 512})
    const crooked = panel.state().orbit.camera.yaw
    await panel.click('Align the view to the nearest stop')
    expect(panel.state().orbit.camera.yaw).not.toBe(crooked)

    const order = names()
    const tiles = [...panel.host.querySelectorAll('.views-strip [role="radio"]')]
    const [first, , third] = tiles
    if (!first || !third) throw new Error('the strip should hold four cameras')
    await panel.act(() => {
        first.dispatchEvent(new Event('pointerdown', {bubbles: true}))
    })
    expect(panel.state().draggingCamera).toBeDefined()
    await panel.act(() => {
        third.dispatchEvent(new Event('pointerover', {bubbles: true}))
    })
    await panel.act(() => {
        third.dispatchEvent(new Event('pointerup', {bubbles: true}))
    })
    expect(panel.state().draggingCamera).toBeUndefined()
    expect(names()).not.toEqual(order)
    expect(names().toSorted()).toEqual(order.toSorted())

    await panel.unmount()
})
