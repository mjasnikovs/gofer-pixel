import {expect, test} from 'bun:test'
import {mountPanel} from '../../test/panel'
import {FACE_LIGHT} from '../render/faces'
import {DEFAULT_LIGHTING, lightFor} from '../render/light'
import {basisFor} from '../render/camera'
import {render} from '../render/raycast'
import {renderSheet} from '../sheet/sheet'
import {createVolume, setVoxel} from '../render/volume'
import {LightPanel} from './LightPanel'
import {spriteFor} from './sprite-cache'
import type {AppState} from './state'

const volume = () => {
    const grid = createVolume(4, 4, 4, new Uint8Array(256 * 4))
    grid.palette.set([200, 100, 50, 255], 4)
    setVoxel(grid, 1, 1, 1, 1)
    setVoxel(grid, 2, 1, 1, 1)
    return grid
}

const sunny = (state: AppState): AppState => ({...state, lighting: {...DEFAULT_LIGHTING, on: true}})

/**
 * Astryx's Slider is a div thumb named through `aria-labelledby`, not `aria-label`, so it is found
 * by the label element it points at. The value goes in through the reducer, not through a drag.
 */
const slider = (host: HTMLElement, label: string): HTMLElement => {
    const found = [...host.querySelectorAll<HTMLElement>('[role="slider"]')].find(node => {
        const id = node.getAttribute('aria-labelledby') ?? ''
        // `startsWith`, because the label element also holds the tooltip's info icon and its text.
        return host.querySelector(`#${id}`)?.textContent.trim().startsWith(label) === true
    })
    if (!found) throw new Error(`no "${label}" slider`)
    return found
}

test('there is no section at all until the sun is on', async () => {
    const panel = await mountPanel(volume(), LightPanel)
    expect(panel.host.querySelector('.section')).toBe(null)

    await panel.dispatch({type: 'lighting', lighting: {on: true}})
    expect(panel.host.querySelectorAll('[role="slider"]')).toHaveLength(4)
    await panel.unmount()
})

test('the four sliders show the four numbers', async () => {
    const panel = await mountPanel(volume(), LightPanel, sunny)
    expect(slider(panel.host, 'Angle').getAttribute('aria-valuenow')).toBe('30')
    expect(slider(panel.host, 'Height').getAttribute('aria-valuenow')).toBe('50')

    await panel.dispatch({type: 'lighting', lighting: {azimuth: 165}})
    expect(slider(panel.host, 'Angle').getAttribute('aria-valuenow')).toBe('165')
    await panel.unmount()
})

/**
 * The clamp lives in `withLight`, not in the panel.
 *
 * Held here as well as in `light.test.ts` because the failure it prevents is a control that clamps
 * for itself: two answers to "what is the top of the range", and the one nobody is looking at
 * drifts.
 */
test('the angle wraps at the compass and the height stops at the top', async () => {
    const panel = await mountPanel(volume(), LightPanel, sunny)

    await panel.dispatch({type: 'lighting', lighting: {azimuth: 365}})
    expect(panel.state().lighting.azimuth).toBe(5)

    await panel.dispatch({type: 'lighting', lighting: {elevation: 140}})
    expect(panel.state().lighting.elevation).toBe(90)
    await panel.unmount()
})

/*
 * The sun is chrome. This is the whole point of the feature and the reason it was rebuilt: lighting
 * is the game engine's job, so a sun that reached a file would be lit twice — once here and once by
 * the engine reading the normal map next to it.
 */
test('the sun is never in the save file and never marks the document unsaved', async () => {
    const panel = await mountPanel(volume(), LightPanel, sunny)
    expect(panel.state().doc.dirty).toBe(false)

    await panel.dispatch({type: 'lighting', lighting: {azimuth: 120, sun: 1}})
    expect(panel.state().doc.dirty).toBe(false)
    await panel.unmount()
})

test('moving the sun does not go on the undo stack', async () => {
    const panel = await mountPanel(volume(), LightPanel, sunny)
    const before = panel.state().history

    await panel.dispatch({type: 'lighting', lighting: {azimuth: 120}})
    expect(panel.state().history).toBe(before)
    await panel.unmount()
})

/**
 * No sprite carries the sun — asserted on the pixels, at both places a sprite comes from.
 *
 * The type system cannot say this: `render` takes an optional light and every shipping caller
 * simply does not pass one. So this is the test that would catch somebody threading it through
 * "for consistency" and quietly baking a second light into every exported PNG.
 */
test('nothing that stands for a file is lit', async () => {
    const panel = await mountPanel(volume(), LightPanel, sunny)
    await panel.dispatch({type: 'lighting', lighting: {azimuth: 200, sun: 1, ambient: 0}})
    const state = panel.state()
    const grid = state.volume
    const camera = state.orbit.camera

    // The sun really is somewhere else, or every comparison below passes by doing nothing.
    expect(Array.from(lightFor(state.lighting)).slice(1)).not.toEqual(
        Array.from(FACE_LIGHT).slice(1)
    )

    const flat = render(grid, basisFor(camera, grid, 32), 32, 32)
    expect(spriteFor(grid, camera, 32, 0)()).toEqual(flat.color)

    const sheet = renderSheet(grid, [{id: 'a', name: 'A', camera}], 32, ['color'])
    expect(sheet.maps.color?.slice(0, 32 * 4)).toEqual(flat.color.slice(0, 32 * 4))
    await panel.unmount()
})

/*
 * Reset. Greyed while there is nothing to put back rather than hidden — a control that vanishes
 * when it has no work is a control the artist has to rediscover.
 */
test('reset is dead at the default angle and live once the sun has moved', async () => {
    const panel = await mountPanel(volume(), LightPanel, sunny)
    const reset = (): HTMLElement => panel.control('Reset the sun')
    expect(reset().getAttribute('aria-disabled') ?? reset().getAttribute('disabled')).not.toBe(null)

    await panel.dispatch({type: 'lighting', lighting: {azimuth: 195}})
    expect(reset().getAttribute('disabled')).toBe(null)
    expect(reset().getAttribute('aria-disabled')).not.toBe('true')
    await panel.unmount()
})

test('reset puts all four back', async () => {
    const panel = await mountPanel(volume(), LightPanel, sunny)
    await panel.dispatch({
        type: 'lighting',
        lighting: {azimuth: 195, elevation: 10, sun: 0.1, ambient: 0.9}
    })

    await panel.click('Reset the sun')
    expect(panel.state().lighting).toEqual({...DEFAULT_LIGHTING, on: true})
    await panel.unmount()
})

/**
 * Reset must not close the section it is in.
 *
 * `DEFAULT_LIGHTING.on` is `false`, so spreading the whole default here would turn the sun off and
 * unmount the panel the click landed in — and the switch that would bring it back is four hundred
 * pixels away in the header. That is the bug this test exists for; it was written and caught.
 */
test('reset leaves the sun on', async () => {
    const panel = await mountPanel(volume(), LightPanel, sunny)
    await panel.dispatch({type: 'lighting', lighting: {azimuth: 195}})

    await panel.click('Reset the sun')
    expect(panel.state().lighting.on).toBe(true)
    expect(panel.host.querySelectorAll('[role="slider"]')).toHaveLength(4)
    await panel.unmount()
})

/** Nudged away and nudged back is nothing to reset — the compare is by value, not by identity. */
test('putting a slider back by hand puts the reset button back to sleep', async () => {
    const panel = await mountPanel(volume(), LightPanel, sunny)
    await panel.dispatch({type: 'lighting', lighting: {azimuth: 195}})
    expect(panel.control('Reset the sun').getAttribute('aria-disabled')).not.toBe('true')

    await panel.dispatch({type: 'lighting', lighting: {azimuth: DEFAULT_LIGHTING.azimuth}})
    const reset = panel.control('Reset the sun')
    expect(reset.getAttribute('aria-disabled') ?? reset.getAttribute('disabled')).not.toBe(null)
    await panel.unmount()
})
