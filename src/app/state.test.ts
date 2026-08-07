import {expect, test} from 'bun:test'
import {MODE_NORMAL} from '../render/raycast.glsl'
import {readVox} from '../vox/vox-file'
import {initialState, reduce, type AppState} from './state'

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)
const fresh = (): AppState => initialState(volume)

test('a new document opens on eight directions, showing the three-quarter one', () => {
    const state = fresh()
    expect(state.cameras).toHaveLength(8)
    expect(state.cameras.map(({name}) => name)[0]).toBe('Front')
    expect(state.cameras[1]?.name).toBe('Front Right')
    expect(state.selected).toBe(state.cameras[1]?.id)
    expect(state.orbit.camera).toBe(state.cameras[1]?.camera as never)
})

test('picking a camera shows it; orbiting away says it is no longer that camera', () => {
    const state = reduce(fresh(), {type: 'select', id: 'dir-2'})
    expect(state.selected).toBe('dir-2')
    expect(state.orbit.camera.yaw).toBeCloseTo(Math.PI / 2, 10)

    const down = reduce(state, {
        type: 'orbit',
        event: {type: 'pointerdown', x: 0, y: 0, secondary: false},
        height: 400
    })
    expect(down.selected).toBe('dir-2')

    const dragged = reduce(down, {
        type: 'orbit',
        event: {type: 'pointermove', x: 40, y: 0},
        height: 400
    })
    expect(dragged.selected).toBeUndefined()
    expect(dragged.orbit.camera.yaw).toBeCloseTo(Math.PI / 2 + 0.4, 10)
})

test('capturing the current view appends a camera and selects it', () => {
    const moved = reduce(
        reduce(fresh(), {
            type: 'orbit',
            event: {type: 'pointerdown', x: 0, y: 0, secondary: false},
            height: 400
        }),
        {type: 'orbit', event: {type: 'pointermove', x: 100, y: 0}, height: 400}
    )
    const state = reduce(moved, {type: 'capture'})

    expect(state.cameras).toHaveLength(9)
    expect(state.cameras[8]?.name).toBe('Camera 1')
    expect(state.cameras[8]?.camera).toEqual(moved.orbit.camera)
    expect(state.selected).toBe(state.cameras[8]?.id)
})

test('deleting a camera drops it and clears the selection only if it was the one', () => {
    const state = reduce(reduce(fresh(), {type: 'select', id: 'dir-3'}), {
        type: 'delete',
        id: 'dir-5'
    })
    expect(state.cameras).toHaveLength(7)
    expect(state.selected).toBe('dir-3')

    const gone = reduce(state, {type: 'delete', id: 'dir-3'})
    expect(gone.selected).toBeUndefined()
    expect(reduce(gone, {type: 'delete', id: 'nope'})).toBe(gone)
})

test('the sheet is baked on demand and thrown away whenever it would go stale', () => {
    const baked = reduce(fresh(), {type: 'bake'})
    expect(baked.sheet?.width).toBe(256)
    expect(baked.sheet?.height).toBe(128)

    expect(reduce(baked, {type: 'delete', id: 'dir-1'}).sheet).toBeUndefined()
    expect(reduce(baked, {type: 'capture'}).sheet).toBeUndefined()
    expect(reduce(baked, {type: 'cell', cell: 32}).sheet).toBeUndefined()
    // Changing which map the *viewport* draws does not invalidate an exported sheet.
    expect(reduce(baked, {type: 'map', map: MODE_NORMAL}).sheet).toBe(baked.sheet)
})

test('create-eight-directions replaces the list rather than appending to it', () => {
    const state = reduce(reduce(fresh(), {type: 'capture'}), {type: 'eight-directions'})
    expect(state.cameras).toHaveLength(8)
    expect(state.selected).toBe('dir-1')
})
