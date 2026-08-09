import {expect, test} from 'bun:test'
import {readVox} from '../vox/vox-file'
import {mountPanel, type Panel} from '../../test/panel'
import type {Reference} from '../doc/reference'
import {shownVolume} from '../doc/objects'
import {GridPanel} from './ToolRail'
import {ReferenceLayer} from './ReferenceLayer'
import {slicedFor} from './state'

/**
 * The scene panel under the viewport — the switches, symmetry, the drawing plane and the reference
 * rows — over the real reducer. See `test/panel.tsx`.
 *
 * `ReferenceLayer` is drawn beside it because half of what a reference row does is visible in the
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
            <GridPanel
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

test('the scene toggles, symmetry and the drawing plane all reach the document', async () => {
    const panel = await open()
    const toggle = (label: string): HTMLElement => {
        const row = [...panel.host.querySelectorAll<HTMLElement>('.snap-toggle')].find(node =>
            node.textContent.includes(label)
        )
        const input = row?.querySelector<HTMLElement>('input[role="switch"]')
        if (!input) throw new Error(`no toggle labelled "${label}"`)
        return input
    }

    for (const [label, field] of [
        ['Grid', 'grid'],
        ['Edges', 'edges'],
        ['Snap', 'snap'],
        ['Invert', 'invert']
    ] as const) {
        const was = panel.state()[field]
        await panel.act(() => {
            toggle(label).click()
        })
        expect(panel.state()[field]).toBe(!was)
    }

    await panel.click('Mirror drawing across X')
    expect(panel.state().symmetry.x).toBe(true)

    // The car is 16 × 10, so radial is refused and says so rather than going quietly dead.
    await panel.click('Radial symmetry needs a grid that is square in X and Y')
    expect(panel.state().symmetry.radial).toBe(false)

    await panel.click('Lock drawing to the XY plane')
    expect(panel.state().plane).toBe(2)
    await panel.click('Draw on the face under the cursor')
    expect(panel.state().plane).toBeUndefined()

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
