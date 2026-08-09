import {expect, test} from 'bun:test'
import {mountPanel, type Panel} from '../../test/panel'
import {basisFor} from '../render/camera'
import {render} from '../render/raycast'
import {createVolume} from '../render/volume'
import {shownVolume} from '../doc/objects'
import {readVox} from '../vox/vox-file'
import type {ViewportPointer} from '../viewport/orbit'
import {Stage} from './Stage'
import {slicedFor} from './state'

/**
 * The stage over the real reducer — see `test/panel.tsx`.
 *
 * Everything here used to need a whole window, because the two derivations under test lived in
 * `App.tsx` as local `const`s: the box round the selection, and the name of the locked object the
 * hint bar reports. Neither was reachable without mounting fourteen other panels, and the second
 * had no test at all.
 *
 * The viewport is in this tree and gets no GL context here, which is the point — the eight things
 * drawn over it are SVG and the CPU raycaster, and none of them is downstream of a GPU.
 */

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

const SIZE = 64

const open = (
    grid = volume,
    start: Parameters<typeof mountPanel>[2] = state => state
): Promise<Panel> =>
    mountPanel(
        grid,
        ({state, dispatch}) => (
            <Stage
                state={state}
                dispatch={dispatch}
                volume={slicedFor(state, shownVolume(state.volume, state.objects))}
                onPicture={() => undefined}
            />
        ),
        start
    )

/** A pixel the model actually covers, so a ray from it hits something. */
const onModel = (panel: Panel): ViewportPointer => {
    const state = panel.state()
    const basis = basisFor(state.orbit.camera, state.volume, SIZE)
    const {id} = render(state.volume, basis, SIZE, SIZE)
    const hits: number[] = []
    for (let i = 0; i < id.length; i += 1) if ((id[i] ?? 0) !== 0) hits.push(i)
    const index = hits[Math.floor(hits.length / 2)] ?? 0
    return {
        type: 'move',
        x: index % SIZE,
        y: Math.floor(index / SIZE),
        width: SIZE,
        height: SIZE,
        button: 0,
        shift: false,
        alt: false,
        ctrl: false,
        clicks: 1
    }
}

const hint = (panel: Panel): string => panel.host.querySelector('.hints')?.textContent ?? ''

/*
 * The selection bar — `FEATURESET.md` §4 and §39. Nine transforms, a duplicate and a delete, and
 * they exist only while something is selected. This was a whole-window mount.
 */
test('the selection bar appears with a selection and its transforms reach the document', async () => {
    /*
     * A lopsided little model rather than the car: a transform is only visible if the thing being
     * transformed is asymmetric, and a rotate that would push the selection off the grid is refused
     * whole — so this is a shape with room to turn in.
     */
    const grid = createVolume(8, 8, 8, volume.palette)
    for (let x = 0; x < 3; x += 1) grid.data[x + 8 * (3 + 8 * 3)] = 1
    grid.data[1 + 8 * (4 + 8 * 3)] = 1

    const panel = await open(grid)
    const bar = (): Element | null =>
        panel.host.querySelector('[role="toolbar"][aria-label="Selection"]')

    expect(bar()).toBeNull()

    await panel.dispatch({type: 'select-color', color: 1})
    expect(bar()).not.toBeNull()
    expect(bar()?.textContent).toContain('4 voxels')

    // Each of the three families moves the voxels somewhere the last two did not.
    const shapes = new Set<string>()
    for (const label of ['Rotate 90° about Z', 'Flip X', 'Mirror across Y']) {
        await panel.click(label)
        shapes.add(panel.state().volume.data.join(''))
    }
    expect(shapes.size).toBe(3)

    const before = panel.state().volume.data.filter(Boolean).length
    await panel.click('Duplicate one voxel up')
    expect(panel.state().volume.data.filter(Boolean).length).toBeGreaterThan(before)

    await panel.click('Delete selected voxels')
    expect(panel.state().selection.size).toBe(0)
    expect(bar()).toBeNull()

    // And with something chosen again, Deselect takes the bar back off the viewport.
    await panel.dispatch({type: 'select-color', color: 1})
    await panel.click('Deselect')
    expect(bar()).toBeNull()

    await panel.unmount()
})

/*
 * The one derivation that had no test anywhere: `hover.blocked` names an object *id*, and the hint
 * bar wants the name. It was four lines in `App.tsx` between a memo and some JSX, so the only way
 * to ask it was to mount a window, lock an object and read a bar out of it.
 */
test('a press that a lock would swallow names the object standing in the way', async () => {
    const panel = await open()

    // Erase, because Draw writes into the empty cell in *front* of the face and nothing owns air.
    // The lock is about the voxel under the cursor, so the tool has to be one that means that one.
    await panel.dispatch({type: 'tool', tool: 'erase'})
    await panel.dispatch({type: 'pointer', event: onModel(panel)})
    expect(panel.state().hover?.blocked).toBeUndefined()

    // Lock the object that owns every voxel of this model, and aim at it again.
    const {active} = panel.state().objects
    await panel.dispatch({type: 'object', op: {kind: 'locked', id: active, on: true}})
    await panel.dispatch({type: 'pointer', event: onModel(panel)})

    expect(panel.state().hover?.blocked?.reason).toBe('locked')
    // The name, not the id — which is the whole of what this seam moved.
    const name = panel.state().objects.list[0]?.name ?? ''
    expect(name).not.toBe('')
    expect(hint(panel)).toContain(name)

    await panel.unmount()
})
