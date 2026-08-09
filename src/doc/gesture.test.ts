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
import {
    beginStroke,
    changedAim,
    endStroke,
    forgetAim,
    hoverAt,
    slicedFor,
    visible,
    type Gesture
} from './gesture'

/**
 * The pointer gestures against `Gesture` itself, with no `AppState` anywhere.
 *
 * `state.test.ts` drives all of this through `reduce`, which is the right place for it: what an
 * artist does is dispatch actions. What this file is for is the *interface* — proving that the
 * eighteen fields below are the whole of what a gesture needs, and that a caller with only those
 * fields gets working outlines and working strokes. If a field creeps back in, this stops
 * compiling here rather than being noticed a hundred lines into `reduce`.
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
    losing: 0,
    aim: undefined,
    hover: undefined
})

/** A pixel the model actually covers, so a ray from it hits something. */
const onModel = (state: Gesture): {x: number; y: number} => {
    const basis = basisFor(state.orbit.camera, state.volume, SIZE)
    const {id} = render(state.volume, basis, SIZE, SIZE)
    const hits: number[] = []
    for (let i = 0; i < id.length; i += 1) if ((id[i] ?? 0) !== 0) hits.push(i)
    const index = hits[Math.floor(hits.length / 2)] ?? 0
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
    const up = endStroke(beginStroke(aimed, pointer('down', x, y)))

    expect(occupied(up.volume.data)).toBe(occupied(state.volume.data) + 1)
    expect(up.history.past).toHaveLength(1)
    // Exactly where the outline said, which is the whole reason `hoverAt` shares its branches with
    // `beginStroke` rather than approximating them.
    const [px, py, pz] = promised ?? [-1, -1, -1]
    expect(up.volume.data[px + py * up.volume.sx + pz * up.volume.sx * up.volume.sy]).toBe(1)
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
