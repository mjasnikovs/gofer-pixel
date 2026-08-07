import {expect, test} from 'bun:test'
import {basisFor} from '../render/camera'
import {render} from '../render/raycast'
import {MODE_NORMAL} from '../render/raycast.glsl'
import {voxelAt, type Volume} from '../render/volume'
import type {ViewportPointer} from '../viewport/orbit'
import {readVox} from '../vox/vox-file'
import {initialState, MAX_BRUSH, reduce, type AppState, type Tool} from './state'

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)
const fresh = (): AppState => initialState(volume)

/** The viewport is square here so a pixel is a pixel; nothing in the maths cares which size. */
const SIZE = 64

const at = (
    type: ViewportPointer['type'],
    x: number,
    y: number,
    over: Partial<ViewportPointer> = {}
): {type: 'pointer'; event: ViewportPointer} => ({
    type: 'pointer',
    event: {
        type,
        x,
        y,
        width: SIZE,
        height: SIZE,
        button: 0,
        shift: false,
        alt: false,
        clicks: 1,
        ...over
    }
})

/**
 * A pixel the model is definitely under, found from the renderer's own id map rather than from the
 * picker — so a test of the tools cannot pass by agreeing with the bug it is meant to catch.
 */
const onModel = (state: AppState): {column: number; row: number} => {
    const basis = basisFor(state.orbit.camera, state.volume, SIZE)
    const {id} = render(state.volume, basis, SIZE, SIZE)
    const hits: number[] = []
    for (let i = 0; i < id.length; i += 1) if ((id[i] ?? 0) !== 0) hits.push(i)
    const index = hits[Math.floor(hits.length / 2)] ?? 0
    return {column: index % SIZE, row: Math.floor(index / SIZE)}
}

const occupied = ({data}: Volume): number =>
    data.reduce((count, value) => (value === 0 ? count : count + 1), 0)

const armed = (tool: Tool): AppState => reduce(fresh(), {type: 'tool', tool})

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

test('duplicating copies the selected camera rather than referring to it', () => {
    const state = reduce(reduce(fresh(), {type: 'select', id: 'dir-4'}), {type: 'duplicate'})
    expect(state.cameras).toHaveLength(9)
    expect(state.cameras[8]?.name).toBe('Back copy')
    expect(state.cameras[8]?.camera).toEqual(state.cameras[4]?.camera as never)
    expect(state.selected).toBe(state.cameras[8]?.id)

    // Nothing selected is not "duplicate whatever was last selected"; it is nothing to duplicate.
    const orbited = reduce(state, {
        type: 'orbit',
        event: {type: 'pointerdown', x: 0, y: 0, secondary: false},
        height: 400
    })
    const dragged = reduce(orbited, {
        type: 'orbit',
        event: {type: 'pointermove', x: 40, y: 0},
        height: 400
    })
    expect(reduce(dragged, {type: 'duplicate'})).toBe(dragged)
})

test('the document opens loaded with a colour the model actually uses', () => {
    const state = fresh()
    expect(state.color).toBeGreaterThan(0)
    expect([...state.volume.data]).toContain(state.color)
})

test('the brush size is bounded by the document, not by the stepper', () => {
    const state = fresh()
    expect(reduce(state, {type: 'brush', brush: {size: 99}}).brush.size).toBe(MAX_BRUSH)
    expect(reduce(state, {type: 'brush', brush: {size: 0}}).brush.size).toBe(1)
    // A partial update leaves the rest of the brush alone.
    expect(reduce(state, {type: 'brush', brush: {shape: 'cube'}}).brush.size).toBe(state.brush.size)
})

test('drawing adds voxels, and one stroke is one undo step', () => {
    const state = armed('draw')
    const {column, row} = onModel(state)

    const down = reduce(state, at('down', column, row))
    expect(down.stroke).toBeDefined()
    // A size-2 square brush is four cells, and none of them was occupied before.
    expect(occupied(down.volume)).toBe(occupied(state.volume) + 4)
    expect(down.history.past).toHaveLength(0)

    const up = reduce(down, at('up', column, row))
    expect(up.stroke).toBeUndefined()
    expect(up.history.past).toHaveLength(1)

    const undone = reduce(up, {type: 'undo'})
    expect(undone.volume.data).toEqual(state.volume.data)
    expect(reduce(undone, {type: 'redo'}).volume.data).toEqual(up.volume.data)
})

test('a drag stays on the layer it started on instead of climbing towards the camera', () => {
    const state = armed('draw')
    const {column, row} = onModel(state)

    let live = reduce(state, at('down', column, row))
    const layer = live.stroke?.layer
    const axis = live.stroke?.axis ?? 0
    for (let step = 1; step <= 6; step += 1) {
        live = reduce(live, at('move', column + step, row + step))
    }
    expect(live.stroke?.layer).toBe(layer as never)

    const done = reduce(live, at('up', column + 6, row + 6))
    const edit = done.history.past[0]
    if (!edit) throw new Error('the drag wrote something')

    // Every cell the drag wrote sits on the one plane, which is the whole claim.
    const {sx, sy} = state.volume
    for (const index of edit.at) {
        const z = Math.floor(index / (sx * sy))
        const rest = index - z * sx * sy
        expect([rest % sx, Math.floor(rest / sx), z][axis]).toBe(layer as never)
    }
    expect(edit.at.length).toBeGreaterThan(4)
})

test('erase takes the voxel under the cursor, and draw puts one in front of it', () => {
    const start = armed('erase')
    const {column, row} = onModel(start)

    const rubbed = reduce(reduce(start, at('down', column, row)), at('up', column, row))
    expect(occupied(rubbed.volume)).toBeLessThan(occupied(start.volume))

    // Same pixel, the other tool: the count goes the other way.
    const drawn = reduce(reduce(armed('draw'), at('down', column, row)), at('up', column, row))
    expect(occupied(drawn.volume)).toBeGreaterThan(occupied(start.volume))
})

test('alt turns draw into paint: the same cell, a different colour', () => {
    const state = reduce(armed('draw'), {type: 'color', color: 200})
    const {column, row} = onModel(state)

    const painted = reduce(
        reduce(state, at('down', column, row, {alt: true})),
        at('up', column, row, {alt: true})
    )
    expect(occupied(painted.volume)).toBe(occupied(state.volume))
    const edit = painted.history.past[0]
    expect([...(edit?.to ?? [])]).toEqual([200, 200, 200, 200])
    expect([...(edit?.from ?? [])].every(value => value !== 0)).toBe(true)
})

test('pick loads the colour under the cursor and writes nothing', () => {
    const state = reduce(armed('pick'), {type: 'color', color: 1})
    const {column, row} = onModel(state)

    const picked = reduce(state, at('down', column, row))
    expect(picked.color).not.toBe(1)
    expect(picked.stroke).toBeUndefined()
    expect(picked.history.past).toHaveLength(0)
    expect(picked.volume).toBe(state.volume)
})

test('fill recolours the region it was clicked on, in one step', () => {
    const state = reduce(armed('fill'), {type: 'color', color: 199})
    const {column, row} = onModel(state)

    const filled = reduce(state, at('down', column, row))
    expect(filled.history.past).toHaveLength(1)
    expect(filled.stroke).toBeUndefined()
    expect(occupied(filled.volume)).toBe(occupied(state.volume))

    const edit = filled.history.past[0]
    expect(edit?.at.length).toBeGreaterThan(10)
    expect([...(edit?.to ?? [])].every(value => value === 199)).toBe(true)
})

test('the camera is still reachable with a writing tool armed', () => {
    const state = armed('draw')
    const {column, row} = onModel(state)

    // Right button orbits.
    const right = reduce(state, at('down', column, row, {button: 2}))
    expect(right.stroke).toBeUndefined()
    expect(right.orbit.gesture?.mode).toBe('orbit')
    const turned = reduce(right, at('move', column + 40, row))
    expect(turned.orbit.camera.yaw).toBeCloseTo(state.orbit.camera.yaw + 0.4, 10)
    expect(turned.volume).toBe(state.volume)

    // Shift-drag pans, on either button.
    const panned = reduce(state, at('down', column, row, {shift: true}))
    expect(panned.orbit.gesture?.mode).toBe('pan')

    // A tool with no pointer behaviour yet leaves the left button to the camera.
    const measuring = reduce(armed('measure'), at('down', column, row))
    expect(measuring.orbit.gesture?.mode).toBe('orbit')
})

test('drawing on empty space lands on the floor of the grid, not nowhere', () => {
    const state = armed('draw')
    const {sx, sy, sz} = state.volume
    const basis = basisFor(state.orbit.camera, state.volume, SIZE)

    // A floor cell the camera can see: projected with the basis directly, so the pixel is chosen
    // without asking the picker, and confirmed empty against the renderer's own id map.
    const {right, up, center, scale} = basis
    const {id} = render(state.volume, basis, SIZE, SIZE)
    const project = (x: number, y: number): {column: number; row: number} => {
        const dx = x + 0.5 - center[0]
        const dy = y + 0.5 - center[1]
        const dz = 0 - center[2]
        const along = right[0] * dx + right[1] * dy + right[2] * dz
        const over = up[0] * dx + up[1] * dy + up[2] * dz
        return {
            column: Math.round(along / scale + SIZE * 0.5 - 0.5),
            row: SIZE - 1 - Math.round(over / scale + SIZE * 0.5 - 0.5)
        }
    }

    let floor: {x: number; y: number; column: number; row: number} | undefined
    for (let y = 0; y < sy && !floor; y += 1) {
        for (let x = 0; x < sx && !floor; x += 1) {
            if (voxelAt(state.volume, x, y, 0) !== 0) continue
            const {column, row} = project(x, y)
            if (column < 0 || row < 0 || column >= SIZE || row >= SIZE) continue
            if ((id[row * SIZE + column] ?? 0) === 0) floor = {x, y, column, row}
        }
    }
    if (!floor) throw new Error('some of the floor is visible from a three-quarter view')
    expect(sz).toBeGreaterThan(0)

    const {column, row} = floor
    const drawn = reduce(reduce(state, at('down', column, row)), at('up', column, row))
    const edit = drawn.history.past[0]
    if (!edit) throw new Error('the click wrote something')
    for (const index of edit.at) expect(Math.floor(index / (sx * sy))).toBe(0)
    expect(voxelAt(drawn.volume, floor.x, floor.y, 0)).toBe(drawn.color)
})

test('undo mid-stroke is ignored rather than tearing the draft in half', () => {
    const state = armed('draw')
    const {column, row} = onModel(state)
    const down = reduce(state, at('down', column, row))
    expect(reduce(down, {type: 'undo'})).toBe(down)
    expect(reduce(down, {type: 'redo'})).toBe(down)
})

test('a stroke throws the baked sheet away, because the model it was baked from has changed', () => {
    const baked = reduce(armed('draw'), {type: 'bake'})
    expect(baked.sheet).toBeDefined()
    const {column, row} = onModel(baked)
    expect(reduce(baked, at('down', column, row)).sheet).toBeUndefined()
})

test('an edit is visible to the picker on the very next event', () => {
    const state = armed('draw')
    const {column, row} = onModel(state)
    const down = reduce(state, at('down', column, row))
    const cell = down.stroke?.at ?? [0, 0, 0]
    expect(voxelAt(down.volume, cell[0], cell[1], cell[2])).toBe(down.color)
})

test('with move armed a click selects, a double-click takes the colour, alt takes the solid', () => {
    const state = armed('move')
    const {column, row} = onModel(state)

    const one = reduce(state, at('down', column, row))
    expect(one.selection.size).toBe(1)
    expect(one.volume).toBe(state.volume)
    expect(one.history.past).toHaveLength(0)

    const twice = reduce(state, at('down', column, row, {clicks: 2}))
    expect(twice.selection.size).toBeGreaterThan(1)

    const solid = reduce(state, at('down', column, row, {alt: true}))
    expect(solid.selection.size).toBeGreaterThanOrEqual(twice.selection.size)

    // Grow reaches into the solid; shrink erodes anything touching air, so on a surface voxel the
    // pair is not a round trip and should not pretend to be.
    const grown = reduce(one, {type: 'grow-selection'})
    expect(grown.selection.size).toBeGreaterThan(1)
    for (const index of one.selection) expect(grown.selection.has(index)).toBe(true)
    expect(reduce(one, {type: 'shrink-selection'}).selection.size).toBe(0)
    expect(reduce(grown, {type: 'clear-selection'}).selection.size).toBe(0)
})

test('a rubber band over air selects the surface under it, and a click on air deselects', () => {
    const state = armed('move')
    const seeded = reduce(state, at('down', onModel(state).column, onModel(state).row))
    expect(seeded.selection.size).toBe(1)

    // Starting on air begins a band rather than throwing the selection away on the way past.
    const down = reduce(seeded, at('down', 0, 0))
    expect(down.band).toBeDefined()
    expect(down.selection).toBe(seeded.selection)

    const dragged = reduce(down, at('move', SIZE - 1, SIZE - 1))
    expect(dragged.band?.x1).toBe(SIZE - 1)

    const released = reduce(dragged, at('up', SIZE - 1, SIZE - 1))
    expect(released.band).toBeUndefined()
    // A band over the whole picture takes every visible voxel, which is more than one.
    expect(released.selection.size).toBeGreaterThan(50)

    // A band that never moved is a click on air, and that means "nothing selected".
    const tapped = reduce(reduce(released, at('down', 0, 0)), at('up', 0, 0))
    expect(tapped.selection.size).toBe(0)
})

test('selecting by colour takes the loaded colour unless told another', () => {
    const state = armed('move')
    const mine = reduce(state, {type: 'select-color'})
    expect(mine.selection.size).toBeGreaterThan(0)
    for (const index of mine.selection) expect(state.volume.data[index]).toBe(state.color)

    expect(reduce(state, {type: 'select-color', color: 0}).selection.size).toBe(0)
})

test('a transform is one undo step and throws the stale sheet away', () => {
    const picked = reduce(armed('move'), {type: 'select-color'})
    expect(picked.selection.size).toBeGreaterThan(0)
    const baked = reduce(picked, {type: 'bake'})

    const painted = reduce(baked, {type: 'transform', op: {kind: 'paint', color: 200}})
    expect(painted.history.past).toHaveLength(1)
    expect(painted.sheet).toBeUndefined()
    expect(painted.volume).not.toBe(baked.volume)
    expect(painted.selection.size).toBe(picked.selection.size)
    expect(occupied(painted.volume)).toBe(occupied(baked.volume))
    expect(reduce(painted, {type: 'undo'}).volume.data).toEqual(baked.volume.data)

    // A quarter turn about z would swing the car's 16-voxel length into a 10-voxel width, and half
    // of it would fall off the grid. That is refused whole rather than half-done.
    expect(reduce(picked, {type: 'transform', op: {kind: 'rotate', axis: 2}})).toBe(picked)

    // Nothing selected is nothing to transform, not a transform of everything.
    const empty = reduce(picked, {type: 'clear-selection'})
    expect(reduce(empty, {type: 'transform', op: {kind: 'delete'}})).toBe(empty)
})

test('a nudge that would push the selection off the grid is refused whole', () => {
    const state = reduce(armed('move'), {type: 'select-color'})
    const {sx} = state.volume

    // Far enough to guarantee the far side of the model leaves the grid.
    const refused = reduce(state, {type: 'transform', op: {kind: 'move', delta: [sx, 0, 0]}})
    expect(refused).toBe(state)

    const nudged = reduce(state, {type: 'transform', op: {kind: 'move', delta: [0, 0, 1]}})
    expect(occupied(nudged.volume)).toBe(occupied(state.volume))
})

test('symmetry writes both halves in one stroke, and undoes as one', () => {
    const plain = armed('draw')
    const mirrored = reduce(plain, {type: 'symmetry', axis: 'x', on: true})
    const {column, row} = onModel(plain)

    const one = reduce(reduce(plain, at('down', column, row)), at('up', column, row))
    const two = reduce(reduce(mirrored, at('down', column, row)), at('up', column, row))

    // Same click, twice the voxels, still one entry in the history.
    expect(occupied(two.volume) - occupied(plain.volume)).toBe(
        2 * (occupied(one.volume) - occupied(plain.volume))
    )
    expect(two.history.past).toHaveLength(1)
    expect(reduce(two, {type: 'undo'}).volume.data).toEqual(plain.volume.data)

    // Every voxel the mirrored stroke added has a partner across the middle of the grid.
    const {sx, sy} = two.volume
    const edit = two.history.past[0]
    for (const index of edit?.at ?? []) {
        const z = Math.floor(index / (sx * sy))
        const rest = index - z * sx * sy
        const x = rest % sx
        const y = Math.floor(rest / sx)
        expect(voxelAt(two.volume, sx - 1 - x, y, z)).toBe(voxelAt(two.volume, x, y, z))
    }
})

test('radial symmetry is refused on a grid it would not be exact on', () => {
    const state = armed('draw')
    const square = state.volume.sx === state.volume.sy
    const asked = reduce(state, {type: 'symmetry', axis: 'radial', on: true})
    expect(asked.symmetry.radial).toBe(square)
})

test('the chrome settings move without touching the render or the sheet', () => {
    const baked = reduce(fresh(), {type: 'bake'})
    const after = reduce(
        reduce(reduce(baked, {type: 'tool', tool: 'move'}), {type: 'grid', on: false}),
        {type: 'workspace', workspace: 'render'}
    )
    expect(after.tool).toBe('move')
    expect(after.grid).toBe(false)
    expect(after.workspace).toBe('render')
    expect(after.sheet).toBe(baked.sheet)
    expect(after.orbit).toBe(baked.orbit)
})
