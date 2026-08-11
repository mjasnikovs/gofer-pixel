import {expect, test} from 'bun:test'
import {readVox} from '../vox/vox-file'
import {basisFor, createCamera} from '../render/camera'
import {render} from '../render/raycast'
import type {ViewportPointer} from '../viewport/orbit'
import {ISOMETRIC_PITCH} from './cameras'
import {EMPTY_HISTORY} from './history'
import {initialObjects, shownVolume} from './objects'
import type {Volume} from '../render/volume'
import {EMPTY_SELECTION} from './selection'
import {NO_SYMMETRY} from './symmetry'
import {beganSpan, measured} from './measure'
import {
    changedAim,
    forgetAim,
    hoverAt,
    pointerAt,
    slicedFor,
    visible,
    type Gesture
} from './gesture'

/**
 * The pointer gestures against `Gesture` itself, with no `AppState` anywhere.
 *
 * `state.test.ts` drives a lot of this through `reduce`, which is fair: what an artist does is
 * dispatch actions. What this file is for is the *interface* — proving that the eighteen fields
 * below are the whole of what a gesture needs, and that a caller with only those fields gets
 * working outlines and working strokes. If a field creeps back in, this stops compiling here rather
 * than being noticed a hundred lines into `reduce`.
 *
 * The ordering between the gestures is here too, now that `pointerAt` owns it. It used to be forty
 * lines of the reducer, so the only way to ask "can a stroke be re-armed halfway through?" was to
 * build an `AppState`.
 */

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

const SIZE = 64

const fresh = (): Gesture => ({
    volume,
    objects: initialObjects(volume),
    selection: EMPTY_SELECTION,
    orbit: {camera: createCamera(volume, Math.PI / 4, ISOMETRIC_PITCH), gesture: undefined},
    tool: 'draw',
    brush: {size: 1, shape: 'square', figure: 'free'},
    color: 1,
    recent: [1],
    plane: undefined,
    slice: undefined,
    symmetry: NO_SYMMETRY,
    history: EMPTY_HISTORY,
    stroke: undefined,
    drag: undefined,
    band: undefined,
    span: undefined,
    losing: 0,
    aim: undefined,
    hover: undefined
})

/**
 * A pixel the model actually covers, so a ray from it hits something.
 *
 * `through` is how far down the list of covered pixels to take, so a test that needs two of them
 * can ask for two far apart. It is not a screen direction: the list is row-major, and the middle of
 * it landed 13 px from the right edge of a 64 px frame — a drag rightwards from there left the model
 * on its first step and the reading held still, correctly, for the whole test.
 */
const onModel = (state: Gesture, through = 0.5): {x: number; y: number} => {
    const basis = basisFor(state.orbit.camera, state.volume, SIZE)
    const {id} = render(state.volume, basis, SIZE, SIZE)
    const hits: number[] = []
    for (let i = 0; i < id.length; i += 1) if ((id[i] ?? 0) !== 0) hits.push(i)
    const index = hits[Math.floor(hits.length * through)] ?? 0
    return {x: index % SIZE, y: Math.floor(index / SIZE)}
}

const pointer = (
    type: ViewportPointer['type'],
    x: number,
    y: number,
    over: Partial<ViewportPointer> = {}
): ViewportPointer => ({
    type,
    x,
    y,
    width: SIZE,
    height: SIZE,
    button: 0,
    shift: false,
    alt: false,
    ctrl: false,
    clicks: 1,
    ...over
})

const occupied = (data: Uint8Array): number =>
    data.reduce((count, value) => (value === 0 ? count : count + 1), 0)

test('a gesture needs the document and the hand, and nothing else the app happens to hold', () => {
    const state = fresh()
    const {x, y} = onModel(state)

    const aimed = hoverAt({...state, aim: pointer('move', x, y)})
    expect(aimed.hover).toBeDefined()
    expect(aimed.hover?.kind).toBe('write')
    // The outline is the cells the press would write, not an approximation of them.
    expect(aimed.hover?.cells).toHaveLength(1)
})

test('the outline says what the press would do, and the press does it', () => {
    const state = fresh()
    const {x, y} = onModel(state)
    const aimed = hoverAt({...state, aim: pointer('move', x, y)})
    const promised = aimed.hover?.cells[0]

    // Down and up, with no move between: a click, which is the gesture the outline described.
    // Through `pointerAt`, because the ordering between down and up is part of what is claimed.
    const down = pointerAt(aimed, pointer('down', x, y))
    expect(down.took).toBe(true)
    const up = pointerAt(down.state, pointer('up', x, y)).state

    expect(occupied(up.volume.data)).toBe(occupied(state.volume.data) + 1)
    expect(up.history.past).toHaveLength(1)
    // Exactly where the outline said, which is the whole reason `hoverAt` shares its branches with
    // `beginStroke` rather than approximating them.
    const [px, py, pz] = promised ?? [-1, -1, -1]
    expect(up.volume.data[px + py * up.volume.sx + pz * up.volume.sx * up.volume.sy]).toBe(1)
})

/*
 * The ordering, which is the part `pointerAt` exists to own. Every one of these used to need a
 * whole `AppState` and a `reduce` to ask, and two of them were not asked at all.
 */

test('the camera keeps every press a tool did not want', () => {
    const state = fresh()
    const {x, y} = onModel(state)

    // Shift, the middle button and the right button, whatever is armed — otherwise arming Draw
    // would cost the artist the ability to look at what they are drawing.
    expect(pointerAt(state, pointer('down', x, y, {shift: true})).took).toBe(false)
    expect(pointerAt(state, pointer('down', x, y, {button: 1})).took).toBe(false)
    expect(pointerAt(state, pointer('down', x, y, {button: 2})).took).toBe(false)

    // Measure too, which is the tool with the least to lose from swallowing a drag and still may
    // not: its own gesture is the left button, so the camera has to keep the other three.
    const measuring: Gesture = {...state, tool: 'measure'}
    expect(pointerAt(measuring, pointer('down', x, y, {shift: true})).took).toBe(false)
    expect(pointerAt(measuring, pointer('down', x, y, {button: 2})).took).toBe(false)

    // Every one of them still re-aims: an event the camera took is still a sighting of the pointer.
    expect(pointerAt(measuring, pointer('down', x, y, {button: 2})).state.aim).toBeDefined()
})

/*
 * Measure — the one tool with no draft behind it, so nothing but these tests holds it to what it
 * claims. See `doc/measure.ts` for why the size counts both ends and the diagonal does not.
 */

test('a tape spans two voxels, stays up after the button, and reads both ends inclusive', () => {
    const state: Gesture = {...fresh(), tool: 'measure'}
    const {x, y} = onModel(state)

    const down = pointerAt(state, pointer('down', x, y))
    expect(down.took).toBe(true)
    const from = down.state.span?.from
    expect(from).toBeDefined()
    // A press that has not moved is a tape of one voxel, which is one voxel across on every axis.
    expect(down.state.span?.to).toEqual(from ?? [-1, -1, -1])
    expect(measured(down.state.span ?? beganSpan([0, 0, 0])).size).toEqual([1, 1, 1])
    expect(down.state.span?.live).toBe(true)

    // Nothing it does touches the grid or the history — it is the only tool on the rail that reads.
    const up = pointerAt(down.state, pointer('up', x, y)).state
    expect(up.volume).toBe(state.volume)
    expect(up.history.past).toHaveLength(0)
    // And the tape stays: reading it is the gesture, and one that vanished on release would have to
    // be held in the head.
    expect(up.span?.live).toBe(false)
    expect(up.span?.from).toEqual(from ?? [-1, -1, -1])
})

test('a settled tape stops eating the pointer, and a press on air puts it away', () => {
    const state: Gesture = {...fresh(), tool: 'measure'}
    const {x, y} = onModel(state)
    const settled = pointerAt(
        pointerAt(state, pointer('down', x, y)).state,
        pointer('up', x, y)
    ).state
    expect(settled.span).toBeDefined()

    // The move after the release belongs to nobody, so the camera gets it. A tape that went on
    // taking moves would have made the model unturnable for the rest of the session.
    const wandered = pointerAt(settled, pointer('move', x + 4, y + 4))
    expect(wandered.took).toBe(false)
    expect(wandered.state.span).toBe(settled.span)

    // A corner of the frame is air. The same reading `endBand` gives a click on nothing, and the
    // only way to be rid of a tape — a press over the model is a new one, never a clearing.
    const cleared = pointerAt(settled, pointer('down', 0, 0))
    expect(cleared.took).toBe(true)
    expect(cleared.state.span).toBeUndefined()
})

test('the far end follows the cursor and holds still when the ray leaves the model', () => {
    const state: Gesture = {...fresh(), tool: 'measure'}
    const near = onModel(state, 0.1)
    const far = onModel(state, 0.9)
    const down = pointerAt(state, pointer('down', near.x, near.y)).state

    // Somewhere else on the model: both ends are real voxels, so the tape has grown on some axis.
    const dragged = pointerAt(down, pointer('move', far.x, far.y))
    expect(dragged.took).toBe(true)
    const reached = dragged.state.span
    expect(reached?.from).toEqual(down.span?.from ?? [-1, -1, -1])
    expect(measured(reached ?? beganSpan([0, 0, 0])).size).not.toEqual([1, 1, 1])

    // Off the model entirely. It holds where it was rather than collapsing: the silhouette of a
    // voxel model is full of gaps — between legs, through a window — and a reading that snapped
    // through 1 × 1 × 1 at every one of them would flicker for the whole drag.
    const missed = pointerAt(dragged.state, pointer('move', 0, 0))
    expect(missed.took).toBe(true)
    expect(missed.state.span).toBe(reached)
})

test('the tape outlines the voxel a press would grab, and never blocks', () => {
    const state: Gesture = {...fresh(), tool: 'measure'}
    const {x, y} = onModel(state)
    const aimed = hoverAt({...state, aim: pointer('move', x, y)})

    // Its own kind, because a measurement proposes no paint — see `HoverKind`.
    expect(aimed.hover?.kind).toBe('gauge')
    expect(aimed.hover?.paint).toBeUndefined()
    // A lock is about what may be written and this writes nothing, so there is no silent press.
    expect(aimed.hover?.blocked).toBeUndefined()

    // The voxel the ray struck, and the press takes that same one. Measure is like Erase in this:
    // the empty cell in front of a face is not part of the model and not worth measuring.
    const cell = aimed.hover?.cells[0]
    expect(aimed.hover?.cells).toHaveLength(1)
    expect(pointerAt(aimed, pointer('down', x, y)).state.span?.from).toEqual(cell ?? [-1, -1, -1])

    // And a gesture in progress owns the pointer, so the outline gets out of the way while it runs.
    const live = pointerAt(aimed, pointer('down', x, y)).state
    expect(hoverAt(live).hover).toBeUndefined()
})

test('a stroke in progress owns the pointer, and cannot be re-armed halfway through', () => {
    const state = fresh()
    const {x, y} = onModel(state)
    const down = pointerAt(state, pointer('down', x, y)).state
    expect(down.stroke).toBeDefined()

    // Arming a grab tool mid-stroke must not turn the rest of the drag into a selection: the three
    // in-progress checks come before the tool is looked at.
    const switched: Gesture = {...down, tool: 'move'}
    const moved = pointerAt(switched, pointer('move', x + 2, y + 2))
    expect(moved.took).toBe(true)
    expect(moved.state.stroke).toBeDefined()
    expect(moved.state.band).toBeUndefined()

    const up = pointerAt(moved.state, pointer('up', x + 2, y + 2)).state
    expect(up.stroke).toBeUndefined()
    expect(up.history.past).toHaveLength(1)
})

/**
 * The transition that had no owner. `beginSelect` puts the viewport's size on the band and
 * `endBand` projects the corners back through a basis built from it, but the step between them was
 * an inline spread in the reducer that wrote `x1`/`y1` and nothing else — so a band sampled across
 * a resize described a rectangle that was never on screen.
 */
test('a rubber band carries the viewport it is being dragged in, not just its corner', () => {
    const state: Gesture = {...fresh(), tool: 'move'}
    // A corner of the frame: no model there, so the press starts a band rather than a grab.
    const down = pointerAt(state, pointer('down', 0, 0)).state
    expect(down.band).toBeDefined()

    const wider = pointerAt(down, pointer('move', 20, 20, {width: 128, height: 128}))
    expect(wider.state.band?.x1).toBe(20)
    expect(wider.state.band?.width).toBe(128)
    expect(wider.state.band?.height).toBe(128)

    const up = pointerAt(wider.state, pointer('up', 20, 20, {width: 128, height: 128}))
    expect(up.state.band).toBeUndefined()
})

test('changing the tool re-aims without the mouse moving', () => {
    const state = fresh()
    const {x, y} = onModel(state)
    const aimed = hoverAt({...state, aim: pointer('move', x, y)})

    // Nothing about the pointer has changed and the answer has to, because Erase takes the voxel
    // the ray struck rather than the empty cell in front of it.
    const erasing: Gesture = {...aimed, tool: 'erase'}
    expect(changedAim(aimed, erasing)).toBe(true)
    expect(hoverAt(erasing).hover?.kind).toBe('clear')

    // The grid switches and the export settings are not here to change, which is the point of the
    // interface being eighteen fields: a gesture cannot be re-aimed by something it cannot see.
    expect(changedAim(aimed, {...aimed})).toBe(false)
})

test('the hover cache belongs to this module and can be emptied', () => {
    const state: Gesture = {...fresh(), tool: 'fill'}
    const {x, y} = onModel(state)

    const first = hoverAt({...state, aim: pointer('move', x, y)})
    expect(first.hover?.region?.size).toBeGreaterThan(0)

    // The same answer after the cache is dropped: it is a cache, not a source of truth. Before this
    // was exported it was a module-level `let` that outlived whichever test filled it.
    const cached = first.hover?.region?.size ?? 0
    forgetAim()
    const again = hoverAt({...state, aim: pointer('move', x, y)})
    expect(again.hover?.region?.size).toBe(cached)
})

/*
 * `visible` is `slicedFor` over `shownVolume`, and the split is what lets `App.tsx` memoise the two
 * halves against different things without spelling either of them a second time. The app used to
 * spell the first half on its own and draw from that, so in slice mode the picture was the whole
 * model while the pointer and the bake used this.
 */
test('the grid the artist sees is the grid a click lands on, in slice mode too', () => {
    const state = fresh()
    const filled = (grid: Volume): number => grid.data.reduce((n, v) => (v === 0 ? n : n + 1), 0)

    expect(visible(state)).toBe(state.volume)

    const sliced: Gesture = {...state, plane: 2, slice: Math.floor(state.volume.sz / 2)}
    const seen = visible(sliced)
    expect(seen).not.toBe(sliced.volume)
    expect(filled(seen)).toBeLessThan(filled(state.volume))

    // And the two entry points agree, because one is written in terms of the other.
    expect(slicedFor(sliced, shownVolume(sliced.volume, sliced.objects)).data).toEqual(seen.data)
})
