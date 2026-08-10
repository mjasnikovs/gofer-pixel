import {expect, test} from 'bun:test'
import {readVox} from '../vox/vox-file'
import {mountPanel, type Panel} from '../../test/panel'
import type {Reference} from '../doc/reference'
import {shownVolume} from '../doc/objects'
import {ScenePanel} from './ScenePanel'
import {ToolRail} from './ToolRail'
import {ReferenceLayer} from './ReferenceLayer'
import {slicedFor, TOOLS} from './state'

/**
 * The rail's four view switches and what is left of `ScenePanel`, over the real reducer. See
 * `test/panel.tsx`.
 *
 * They were one panel in the bottom-left corner, and its contents have been dealt out three ways
 * since: the four switches to the rail, symmetry and the drawing plane to the Brush section — those
 * two are `BrushPanel.test.tsx`'s now, and moved with them — and the voxel size over the viewport.
 * What is mounted here is what is still in these two: the switches, and the reference rows.
 *
 * `ReferenceLayer` is drawn beside them because half of what a reference row does is visible in the
 * SVG rather than in the state: dropping a second picture on one plane has to *replace* the first,
 * and "replace" means one `<image>` and not two. Five whole-window mounts before.
 */

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

const PICTURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

const open = (): Promise<Panel> =>
    mountPanel(volume, ({state, dispatch}) => (
        <>
            <ToolRail
                tools={TOOLS}
                state={state}
                dispatch={dispatch}
            />
            <ScenePanel
                state={state}
                dispatch={dispatch}
            />
            <ReferenceLayer
                volume={slicedFor(state, shownVolume(state.volume, state.objects))}
                camera={state.orbit.camera}
                references={state.references}
            />
        </>
    ))

/** One already dropped, because three of these tests are about what happens to it afterwards. */
const withReference = async (): Promise<Panel> => {
    const panel = await open()
    await panel.dispatch({type: 'reference', plane: 1, url: PICTURE})
    return panel
}

const referencesOf = (panel: Panel): readonly Reference[] => panel.state().references

test('the view switches reach the document, and are not heard as a tenth tool', async () => {
    const panel = await open()

    for (const [label, field] of [
        ['Grid', 'grid'],
        ['Edges', 'edges'],
        ['Snap', 'snap'],
        ['Invert', 'invert']
    ] as const) {
        const was = panel.state()[field]
        const control = panel.control(label)
        // Heard as a switch, not as a tenth tool, even though it wears the same face as the nine.
        expect(control.getAttribute('role')).toBe('switch')
        expect(control.getAttribute('aria-checked')).toBe(String(was))
        await panel.click(label)
        expect(panel.state()[field]).toBe(!was)
        expect(panel.control(label).getAttribute('aria-checked')).toBe(String(!was))
    }

    // Arming a tool is a different question from turning a switch on, and the rail holds both.
    await panel.click('Erase')
    expect(panel.state().tool).toBe('erase')
    expect(panel.state().grid).toBe(false)

    await panel.unmount()
})

test('a reference appears with its row, and only once something has been dropped', async () => {
    const panel = await open()

    expect(panel.host.textContent).not.toContain(' ref')
    expect(panel.host.querySelector('.reference-layer')).toBeNull()

    await panel.dispatch({type: 'reference', plane: 1, url: PICTURE})

    expect(referencesOf(panel)).toEqual([{plane: 1, url: PICTURE, opacity: 0.5, locked: false}])
    expect(panel.host.querySelector('.reference-layer image')?.getAttribute('href')).toBe(PICTURE)
    // The row names the plane it belongs to, so two references are told apart.
    expect(panel.host.textContent).toContain('XZ ref')

    await panel.unmount()
})

test('fainter and brighter step the reference opacity and stop at the ends', async () => {
    const panel = await withReference()

    await panel.click('Fainter reference')
    expect(referencesOf(panel)[0]?.opacity).toBeCloseTo(0.35, 6)

    await panel.click('Brighter reference')
    expect(referencesOf(panel)[0]?.opacity).toBeCloseTo(0.5, 6)

    // Clamped, not wrapped: four more steps up would run past 1 without this.
    for (let step = 0; step < 5; step += 1) await panel.click('Brighter reference')
    expect(referencesOf(panel)[0]?.opacity).toBe(1)

    for (let step = 0; step < 9; step += 1) await panel.click('Fainter reference')
    expect(referencesOf(panel)[0]?.opacity).toBe(0)

    await panel.unmount()
})

test('a locked reference cannot be faded or dropped by accident', async () => {
    const panel = await withReference()

    const lock = panel.control('Lock the reference')
    expect(lock.getAttribute('aria-checked')).toBe('false')
    // The button says which way it goes, rather than only which state it is in.
    expect(lock.getAttribute('title')).toContain('Lock it')

    await panel.act(() => {
        lock.click()
    })
    expect(referencesOf(panel)[0]?.locked).toBe(true)
    expect(panel.control('Lock the reference').getAttribute('title')).toBe('Unlock the reference')

    await panel.click('Fainter reference')
    await panel.click('Remove the reference')
    expect(referencesOf(panel)).toEqual([{plane: 1, url: PICTURE, opacity: 0.5, locked: true}])

    // Unlocked again, the same two clicks land.
    await panel.click('Lock the reference')
    await panel.click('Remove the reference')
    expect(referencesOf(panel)).toEqual([])
    expect(panel.host.querySelector('.reference-layer')).toBeNull()

    await panel.unmount()
})

test('a second picture on the same plane replaces the first rather than stacking', async () => {
    const panel = await withReference()
    const other = 'data:image/png;base64,iVBORw0KGgoAAAA='

    await panel.dispatch({type: 'reference', plane: 1, url: other})
    expect(referencesOf(panel)).toEqual([{plane: 1, url: other, opacity: 0.5, locked: false}])
    expect(panel.host.querySelectorAll('.reference-layer image')).toHaveLength(1)

    // A different plane is a different picture and both stay.
    await panel.dispatch({type: 'reference', plane: 2, url: PICTURE})
    expect(referencesOf(panel)).toHaveLength(2)
    expect(panel.host.querySelectorAll('.reference-layer image')).toHaveLength(2)
    expect(panel.host.textContent).toContain('XY ref')

    await panel.unmount()
})
