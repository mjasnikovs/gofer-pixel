import {expect, test} from 'bun:test'
import {voxelsFromImage} from '../doc/import'
import {objectCells, shownVolume} from '../doc/objects'
import {SHEET_MAPS} from '../sheet/sheet'
import {basisFor} from '../render/camera'
import {render} from '../render/raycast'
import {MODE_NORMAL} from '../render/raycast.glsl'
import {createVolume, voxelAt, voxelIndex, type Volume} from '../render/volume'
import type {ViewportPointer} from '../viewport/orbit'
import {readVox} from '../vox/vox-file'
import {
    allPresets,
    GHOST_CELLS,
    initialState,
    MAX_BRUSH,
    presetMaps,
    previewVolume,
    reduce,
    TOOLS,
    USES_BRUSH,
    type AppState,
    type Tool
} from './state'

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
        ctrl: false,
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

test('a ring of directions replaces the list rather than appending to it', () => {
    const state = reduce(reduce(fresh(), {type: 'capture'}), {type: 'directions', count: 8})
    expect(state.cameras).toHaveLength(8)
    expect(state.selected).toBe('dir-1')

    // Four takes every other one of the eight, so Front is Front in both and the sheet's rows
    // still line up with a sheet cut the other way.
    const four = reduce(state, {type: 'directions', count: 4})
    expect(four.cameras.map(({name}) => name)).toEqual(['Front', 'Right', 'Back', 'Left'])
    // One pitch and one zoom across the ring, which is what makes the sprites one set.
    expect(new Set(four.cameras.map(({camera}) => camera.pitch)).size).toBe(1)
    expect(new Set(four.cameras.map(({camera}) => camera.zoom)).size).toBe(1)
})

test('aligning turns the view to the nearest stop rather than to a named view', () => {
    const state = reduce(fresh(), {type: 'select', id: 'dir-3'})
    const nudged = reduce(
        reduce(state, {
            type: 'orbit',
            event: {type: 'pointerdown', x: 0, y: 0, secondary: false},
            height: 400
        }),
        {type: 'orbit', event: {type: 'pointermove', x: 8, y: 4}, height: 400}
    )
    expect(nudged.orbit.camera.yaw).not.toBeCloseTo((3 * Math.PI) / 4, 6)

    const aligned = reduce(nudged, {type: 'align'})
    expect(aligned.orbit.camera.yaw).toBeCloseTo((3 * Math.PI) / 4, 10)
    expect(aligned.selected).toBeUndefined()
})

test('snap makes the zoom whole and the pan land on voxels', () => {
    const loose = reduce(fresh(), {type: 'snap', on: false})
    const tight = reduce(fresh(), {type: 'snap', on: true})
    const wheel = {type: 'orbit', event: {type: 'wheel', delta: 40}, height: 400} as const

    expect(Number.isInteger(reduce(loose, wheel).orbit.camera.zoom)).toBe(false)
    expect(Number.isInteger(reduce(tight, wheel).orbit.camera.zoom)).toBe(true)
    // A notch always moves, even when the zoom is already sitting on an integer.
    expect(reduce(tight, wheel).orbit.camera.zoom).toBeGreaterThan(tight.orbit.camera.zoom)

    const pan = (state: AppState): AppState =>
        reduce(
            reduce(state, {
                type: 'orbit',
                event: {type: 'pointerdown', x: 0, y: 0, secondary: true},
                height: 400
            }),
            {type: 'orbit', event: {type: 'pointermove', x: 7, y: 3}, height: 400}
        )
    expect(Number.isInteger(pan(loose).orbit.camera.panX)).toBe(false)
    expect(Number.isInteger(pan(tight).orbit.camera.panX)).toBe(true)
})

test('the invert switch reaches the drag, not just the panel', () => {
    const turn = (state: AppState): number =>
        reduce(
            reduce(state, {
                type: 'orbit',
                event: {type: 'pointerdown', x: 0, y: 0, secondary: false},
                height: 400
            }),
            {type: 'orbit', event: {type: 'pointermove', x: 100, y: 0}, height: 400}
        ).orbit.camera.yaw

    // Against the opening yaw, which is not zero — the two have to be equal and opposite *turns*,
    // not equal and opposite angles.
    const from = fresh().orbit.camera.yaw
    expect(fresh().invert).toBe(false)
    expect(turn(fresh()) - from).toBeCloseTo(1, 10)
    expect(turn(reduce(fresh(), {type: 'invert', on: true})) - from).toBeCloseTo(-1, 10)
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

/**
 * Which tools actually read the brush.
 *
 * The panel greys Size, Shape and Figure out for the other seven, and that claim was made from
 * reading the code. This is the claim measured: the footprint the outline promises is the footprint
 * the press writes, so a tool whose outline does not change when the brush does is a tool the brush
 * does not reach. Fill floods a region, Pick samples one voxel, and the four grab tools work on a
 * selection — none of them has a footprint to widen.
 */
test('the brush reaches Draw and Erase and no other tool', () => {
    const {column, row} = onModel(fresh())
    const footprint = (tool: Tool, size: number): number | undefined => {
        const armedWith = {...armed(tool), brush: {...fresh().brush, size}}
        return reduce(armedWith, at('move', column, row)).hover?.cells.length
    }

    for (const tool of TOOLS) {
        const one = footprint(tool, 1)
        const five = footprint(tool, 5)
        if (USES_BRUSH.has(tool)) {
            expect(one, `${tool} at size 1`).toBe(1)
            expect(five, `${tool} at size 5`).toBe(25)
        } else {
            expect(five, `${tool} must ignore the brush`).toBe(one)
        }
    }

    // Measure is the one tool with no outline at all, because it is not built.
    expect(footprint('measure', 1)).toBeUndefined()
    // And the shape reaches the same two: a round size-5 brush is fewer cells than a square one.
    const round = {
        ...armed('draw'),
        brush: {size: 5, shape: 'circle', figure: 'free'} as const
    }
    expect(reduce(round, at('move', column, row)).hover?.cells.length).toBeLessThan(25)
})

/**
 * Every control in the palette half of the Brush panel, and the fact that none of them is tool-bound.
 *
 * They stay live under all nine tools on purpose — shift-clicking a swatch selects every voxel of a
 * colour, which is most useful with Move armed, and the entry editor, the emissive switch and the
 * lock change the document rather than the next stroke. A dead control in this list would look
 * exactly like a live one, which is why each is asserted to change something.
 */
test('every palette control reaches the document', () => {
    const state = fresh()

    expect(reduce(state, {type: 'color', color: 9}).color).toBe(9)
    expect(
        reduce(state, {type: 'select-color', color: state.color}).selection.size
    ).toBeGreaterThan(0)
    expect(reduce(state, {type: 'replace-color', from: 1, to: 9}).volume).not.toBe(state.volume)
    expect(
        reduce(state, {type: 'emissive', color: state.color, value: 255}).volume.emissive[
            state.color
        ]
    ).toBe(255)
    expect(reduce(state, {type: 'palette-lock', on: true}).paletteLocked).toBe(true)
    expect(reduce(state, {type: 'palette-add'}).color).not.toBe(state.color)

    const recoloured = reduce(state, {type: 'palette-color', color: state.color, css: '#123456'})
    expect([...recoloured.volume.palette]).not.toEqual([...state.volume.palette])

    // The one control that is meant to be inert, and only under the lock.
    const locked = reduce(state, {type: 'palette-lock', on: true})
    const refused = reduce(locked, {type: 'palette-color', color: state.color, css: '#123456'})
    expect([...refused.volume.palette]).toEqual([...locked.volume.palette])

    // The eyedropper button is an arming button, not a fourth kind of colour edit.
    expect(reduce(state, {type: 'tool', tool: 'pick'}).tool).toBe('pick')
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

test('the rotate tool turns what it grabbed, a quarter for every drag of the hand', () => {
    /*
     * A 4 × 3 × 2 bar in the middle of a roomy grid, rather than the car: it is unequal along all
     * three axes, so a quarter turn about *any* of them both changes the model and still fits —
     * which is what lets the test assert a turn happened without knowing which face got grabbed.
     */
    const bar = createVolume(16, 16, 16, volume.palette)
    for (let z = 6; z < 8; z += 1) {
        for (let y = 6; y < 9; y += 1) {
            for (let x = 5; x < 9; x += 1) bar.data[voxelIndex(bar, x, y, z)] = 1
        }
    }
    // One corner knocked out, so the bar is chiral. A solid box turns to the same set of cells
    // whichever way it goes round, and a test on a solid box cannot tell left from right.
    bar.data[voxelIndex(bar, 8, 8, 7)] = 0
    const state = reduce(initialState(bar), {type: 'tool', tool: 'rotate'})
    const {column, row} = onModel(state)

    // The press is Move's press. What differs is what the drag then does with what it took.
    const down = reduce(state, at('down', column, row, {clicks: 2}))
    expect(down.drag?.kind).toBe('turn')
    expect(down.selection.size).toBeGreaterThan(1)
    expect(down.volume).toBe(state.volume)

    // Less than a quarter's worth of hand is not a turn — and must not be a nudge either, which is
    // the whole bug this replaces: Rotate used to slide the voxels sideways like Move.
    const short = reduce(down, at('move', column + 20, row))
    expect(short.volume).toBe(state.volume)
    expect(short.selection).toBe(down.selection)

    const turned = reduce(down, at('move', column + 48, row))
    expect(turned.volume).not.toBe(state.volume)
    // A quarter turn is a bijection: it lands as many voxels as it lifted, or it does not land.
    expect(turned.selection.size).toBe(down.selection.size)
    expect(occupied(turned.volume)).toBe(occupied(state.volume))

    // Replayed from the start of the gesture, so dragging back is not a second turn on the first.
    expect(reduce(turned, at('move', column, row)).volume).toBe(state.volume)

    /*
     * One quarter per drag, however far the hand goes. Counting a quarter per 48 px made a long
     * drag walk through four turns back to the start, which on screen was a flicker between two
     * pictures. Every distance past the threshold has to be the same single turn.
     */
    for (const far of [96, 160, 320]) {
        expect(reduce(down, at('move', column + far, row)).volume.data).toEqual(turned.volume.data)
    }
    // And the other way is the other way, not the same turn again.
    const other = reduce(down, at('move', column - 96, row))
    expect(other.volume.data).not.toEqual(turned.volume.data)
    expect(occupied(other.volume)).toBe(occupied(state.volume))

    const done = reduce(turned, at('up', column + 48, row))
    expect(done.drag).toBeUndefined()
    expect(done.history.past).toHaveLength(1)
})

test('Control adds to the selection instead of replacing it', () => {
    const state = armed('move')
    const {column, row} = onModel(state)

    const one = reduce(state, at('down', column, row))
    expect(one.selection.size).toBe(1)

    // A second pixel that lands on a *different* voxel, found by walking away from the first until
    // the press picks something else. A voxel is several pixels wide at this size, so a fixed
    // offset either hits the same cell or falls off the model depending on the camera.
    let apart = {column, row}
    for (let step = 1; step < 24; step += 1) {
        const spot = {column: column + step, row: row + step}
        const {selection} = reduce(one, at('down', spot.column, spot.row))
        if (selection.size === 1 && !selection.has([...one.selection][0] ?? -1)) {
            apart = spot
            break
        }
    }
    expect(apart.column).not.toBe(column)

    // A plain press somewhere else replaces — which is what every editor does, and what leaves an
    // artist assembling two arms and a head out of separate clicks with no way to do it.
    const elsewhere = reduce(one, at('down', apart.column, apart.row))
    expect(elsewhere.selection.size).toBe(1)
    expect(elsewhere.selection).not.toEqual(one.selection)

    const both = reduce(one, at('down', apart.column, apart.row, {ctrl: true}))
    expect(both.selection.size).toBe(2)
    for (const index of one.selection) expect(both.selection.has(index)).toBe(true)

    // It stacks with the other two: Control-double-click adds a whole colour.
    const plusColour = reduce(both, at('down', column, row, {ctrl: true, clicks: 2}))
    expect(plusColour.selection.size).toBeGreaterThan(both.selection.size)
    for (const index of both.selection) expect(plusColour.selection.has(index)).toBe(true)

    // Control on an empty selection is an ordinary press, not a special case that has to be typed.
    expect(reduce(state, at('down', column, row, {ctrl: true})).selection.size).toBe(1)
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

test('pressing and dragging a voxel carries it, in one gesture and one undo step', () => {
    const state = armed('move')
    const {column, row} = onModel(state)

    const down = reduce(state, at('down', column, row))
    expect(down.drag?.kind).toBe('move')
    expect(down.selection.size).toBe(1)
    expect(down.volume).toBe(state.volume)

    // Far enough across the grabbed face that the cell under the cursor has certainly changed.
    const dragged = reduce(down, at('move', column + 12, row + 6))
    expect(dragged.volume).not.toBe(state.volume)
    expect(occupied(dragged.volume)).toBeLessThanOrEqual(occupied(state.volume))

    const dropped = reduce(dragged, at('up', column + 12, row + 6))
    expect(dropped.drag).toBeUndefined()
    expect(dropped.history.past).toHaveLength(1)
    expect(reduce(dropped, {type: 'undo'}).volume.data).toEqual(state.volume.data)
})

test('a drag is replayed from where it started, not accumulated as it goes', () => {
    const state = armed('move')
    const {column, row} = onModel(state)
    const down = reduce(state, at('down', column, row))

    const wandered = [
        [column + 9, row + 3],
        [column - 4, row + 7],
        [column + 12, row + 6]
    ].reduce((live, [x, y]) => reduce(live, at('move', x ?? 0, y ?? 0)), down)
    const straight = reduce(down, at('move', column + 12, row + 6))

    // Three moves ending where one move ended leave the identical document.
    expect(wandered.volume.data).toEqual(straight.volume.data)
})

test('a press that never moves selects and writes nothing', () => {
    const state = armed('move')
    const {column, row} = onModel(state)
    const tapped = reduce(reduce(state, at('down', column, row)), at('up', column, row))
    expect(tapped.selection.size).toBe(1)
    expect(tapped.history.past).toHaveLength(0)
    expect(tapped.volume.data).toEqual(state.volume.data)
})

test('clone leaves the original where it was and move does not', () => {
    const {column, row} = onModel(armed('move'))
    const drag = (tool: 'move' | 'clone'): AppState => {
        const down = reduce(armed(tool), at('down', column, row))
        return reduce(down, at('move', column + 12, row + 6))
    }

    const cloned = drag('clone')
    const source = cloned.drag?.from ?? [0, 0, 0]
    expect(voxelAt(cloned.volume, source[0], source[1], source[2])).not.toBe(0)
    expect(voxelAt(drag('move').volume, source[0], source[1], source[2])).toBe(0)
})

test('the scale tool pulls the surface under the cursor, and pushing it back is the same drag', () => {
    const state = armed('scale')
    const {column, row} = onModel(state)

    const down = reduce(state, at('down', column, row))
    expect(down.drag?.kind).toBe('extrude')
    expect(down.selection.size).toBeGreaterThan(0)
    // The patch is one connected face, not the whole model.
    expect(down.selection.size).toBeLessThan(occupied(state.volume))

    // Drag until the projection along the normal rounds to at least one whole layer, whichever
    // screen direction that face happens to point in.
    const pulled = [
        at('move', column + 40, row),
        at('move', column - 40, row),
        at('move', column, row + 40),
        at('move', column, row - 40)
    ]
        .map(event => reduce(down, event))
        .find(next => occupied(next.volume) > occupied(state.volume))
    if (!pulled) throw new Error('one of the four directions pulls the face outward')
    expect(pulled.history.past).toHaveLength(0)

    const done = reduce(pulled, at('up', column, row))
    expect(done.history.past).toHaveLength(1)
    expect(reduce(done, {type: 'undo'}).volume.data).toEqual(state.volume.data)
})

test('a figure is redrawn from where the stroke started, not appended to', () => {
    const state = reduce(armed('draw'), {type: 'brush', brush: {figure: 'rect', size: 1}})
    const {column, row} = onModel(state)

    const down = reduce(state, at('down', column, row))
    const big = reduce(down, at('move', column + 28, row + 18))
    const small = reduce(big, at('move', column + 6, row + 4))
    const changed = (next: AppState): number =>
        [...next.volume.data].filter((value, i) => value !== state.volume.data[i]).length

    // Dragging back shrinks the rectangle. An appending stroke could only ever grow.
    expect(changed(small)).toBeLessThan(changed(big))
    // And the small one is exactly what one drag straight to that point would have drawn.
    expect(small.volume.data).toEqual(reduce(down, at('move', column + 6, row + 4)).volume.data)

    const done = reduce(small, at('up', column + 6, row + 4))
    expect(done.history.past).toHaveLength(1)
    expect(reduce(done, {type: 'undo'}).volume.data).toEqual(state.volume.data)
})

test('a plane lock overrides the face under the cursor', () => {
    const free = armed('draw')
    const {column, row} = onModel(free)

    const byFace = reduce(free, at('down', column, row))
    for (const axis of [0, 1, 2] as const) {
        const locked = reduce(reduce(free, {type: 'plane', axis}), at('down', column, row))
        expect(locked.stroke?.axis).toBe(axis)
    }
    // Without a lock it is whichever face the ray came in through, and one of the three is it.
    expect([0, 1, 2]).toContain(byFace.stroke?.axis ?? -1)

    expect(
        reduce(reduce(free, {type: 'plane', axis: 0}), {type: 'plane', axis: undefined}).plane
    ).toBeUndefined()
})

test('copy and paste put the block back one voxel up, selected and ready to drag', () => {
    const picked = reduce(armed('move'), {type: 'select-color'})
    const copied = reduce(picked, {type: 'copy'})
    expect(copied.clipboard?.cells.length).toBe(picked.selection.size)
    expect(copied.volume).toBe(picked.volume)

    const pasted = reduce(copied, {type: 'paste'})
    expect(pasted.history.past).toHaveLength(1)
    expect(pasted.selection.size).toBeGreaterThan(0)
    expect(reduce(pasted, {type: 'undo'}).volume.data).toEqual(picked.volume.data)

    // Every pasted cell is one voxel above a cell that was copied.
    const {sx, sy} = pasted.volume
    for (const index of pasted.selection) {
        expect(copied.selection.has(index - sx * sy)).toBe(true)
    }

    // Nothing on the clipboard is nothing to paste.
    const bare = armed('move')
    expect(reduce(bare, {type: 'paste'})).toBe(bare)
    expect(reduce(bare, {type: 'copy'})).toBe(bare)
})

test('marking a colour emissive lights it in the emission map and nowhere else', () => {
    const state = fresh()
    const glowing = reduce(state, {type: 'emissive', color: state.color, value: 255})

    expect(glowing.volume.emissive[state.color]).toBe(255)
    // A colour is not a cell, so it is not an undo step and the grid is untouched.
    expect(glowing.history.past).toHaveLength(0)
    expect(glowing.volume.data).toBe(state.volume.data)
    // It is a new volume all the same, or nothing downstream would notice.
    expect(glowing.volume).not.toBe(state.volume)
    expect(state.volume.emissive[state.color]).toBe(0)

    const baked = reduce(reduce(glowing, {type: 'preset', preset: 'Every map'}), {type: 'bake'})
    const emission = baked.sheet?.maps.emission ?? new Uint8Array(0)
    let lit = 0
    for (let i = 0; i < emission.length; i += 4) if ((emission[i] ?? 0) > 0) lit += 1
    expect(lit).toBeGreaterThan(0)
})

test('a preset decides which maps get baked, and colour is always one of them', () => {
    const auto = reduce(fresh(), {type: 'bake'})
    expect(Object.keys(auto.sheet?.maps ?? {}).sort()).toEqual(['color', 'normal'])

    const every = reduce(reduce(fresh(), {type: 'preset', preset: 'Every map'}), {type: 'bake'})
    expect(Object.keys(every.sheet?.maps ?? {})).toHaveLength(SHEET_MAPS.length)
})

test('a stroke joins the active object, and a new object is where the next one goes', () => {
    const state = armed('draw')
    expect(state.objects.list).toHaveLength(1)
    expect(state.objects.active).toBe(1)

    const second = reduce(state, {type: 'object', op: {kind: 'add'}})
    expect(second.objects.list).toHaveLength(2)
    expect(second.objects.active).toBe(2)

    const {column, row} = onModel(second)
    const drawn = reduce(reduce(second, at('down', column, row)), at('up', column, row))
    expect(objectCells(drawn.volume, 2).size).toBe(4)
    // Undo takes the ownership back with the voxels.
    expect(objectCells(reduce(drawn, {type: 'undo'}).volume, 2).size).toBe(0)
})

test('hiding an object takes it out of what is drawn, picked and exported', () => {
    const state = reduce(armed('draw'), {type: 'object', op: {kind: 'add'}})
    const {column, row} = onModel(state)
    const drawn = reduce(reduce(state, at('down', column, row)), at('up', column, row))

    const hidden = reduce(drawn, {type: 'object', op: {kind: 'hidden', id: 1, on: true}})
    // The document keeps every voxel; only the picture loses them.
    expect(occupied(hidden.volume)).toBe(occupied(drawn.volume))
    expect(occupied(shownVolume(hidden.volume, hidden.objects))).toBe(4)
    expect(hidden.sheet).toBeUndefined()

    // And a sheet baked while it is hidden holds only what was on screen.
    const baked = reduce(hidden, {type: 'bake'})
    const colour = baked.sheet?.maps.color ?? new Uint8Array(0)
    let opaque = 0
    for (let i = 3; i < colour.length; i += 4) if (colour[i] === 255) opaque += 1
    expect(opaque).toBeGreaterThan(0)
    expect(opaque).toBeLessThan(
        (() => {
            const all = reduce(drawn, {type: 'bake'}).sheet?.maps.color ?? new Uint8Array(0)
            let count = 0
            for (let i = 3; i < all.length; i += 4) if (all[i] === 255) count += 1
            return count
        })()
    )
})

test('a locked object refuses a stroke while the rest of the model takes one', () => {
    const state = armed('draw')
    const {column, row} = onModel(state)
    const locked = reduce(state, {type: 'object', op: {kind: 'locked', id: 1, on: true}})

    // Draw writes into the empty cell in front of a face, and that cell belongs to nobody, so it
    // still lands. Erase aims at the locked voxel itself, and does not.
    const rubbed = reduce(
        reduce(reduce(locked, {type: 'tool', tool: 'erase'}), at('down', column, row)),
        at('up', column, row)
    )
    expect(rubbed.history.past).toHaveLength(0)
    expect(occupied(rubbed.volume)).toBe(occupied(state.volume))
})

test('solo hides everything else, and deleting an object takes its voxels with it', () => {
    const state = reduce(armed('draw'), {type: 'object', op: {kind: 'add'}})
    const soloed = reduce(state, {type: 'object', op: {kind: 'solo', id: 2}})
    expect(occupied(shownVolume(soloed.volume, soloed.objects))).toBe(0)
    expect(reduce(soloed, {type: 'object', op: {kind: 'solo', id: 2}}).objects.solo).toBeUndefined()

    const gone = reduce(state, {type: 'object', op: {kind: 'remove', id: 1}})
    expect(gone.objects.list).toHaveLength(1)
    expect(occupied(gone.volume)).toBe(0)
    expect(gone.history.past).toHaveLength(1)
    expect(reduce(gone, {type: 'undo'}).volume.data).toEqual(state.volume.data)
})

test('alt-click takes the whole named object, not just what happens to touch', () => {
    const state = reduce(armed('move'), {type: 'object', op: {kind: 'add'}})
    const {column, row} = onModel(state)
    const picked = reduce(state, at('down', column, row, {alt: true}))
    // Object 1 is the whole car, including the wheels that do not touch the body.
    expect(picked.selection.size).toBe(occupied(state.volume))
})

test('focus fills the frame with the active object and leaves the angle alone', () => {
    const state = fresh()
    const before = state.orbit.camera
    const focused = reduce(state, {type: 'focus'})

    expect(focused.orbit.camera.yaw).toBe(before.yaw)
    expect(focused.orbit.camera.pitch).toBe(before.pitch)
    expect(focused.orbit.camera.zoom).toBeLessThan(before.zoom)
    // No longer any stored camera, because the view is not one of them any more.
    expect(focused.selected).toBeUndefined()

    // An empty object has no box, so there is nothing to focus on and nothing changes.
    const empty = reduce(state, {type: 'object', op: {kind: 'add'}})
    expect(reduce(empty, {type: 'focus'})).toBe(empty)
})

test('the loaded colour is remembered, by the swatch grid and by the eyedropper alike', () => {
    const state = fresh()
    expect(state.recent).toEqual([state.color])

    const twice = reduce(reduce(state, {type: 'color', color: 40}), {type: 'color', color: 12})
    expect(twice.recent).toEqual([12, 40, state.color])

    // Picking a colour off the model is loading it, so it lands in the same list.
    const {column, row} = onModel(state)
    const picked = reduce(armed('pick'), at('down', column, row))
    expect(picked.recent[0]).toBe(picked.color)
})

test('editing a palette entry changes what a colour is; replacing one moves voxels', () => {
    const state = fresh()
    const before = state.volume.data.slice()

    const edited = reduce(state, {type: 'palette-color', color: state.color, css: '#123456'})
    expect([...edited.volume.palette.subarray(state.color * 4, state.color * 4 + 3)]).toEqual([
        0x12, 0x34, 0x56
    ])
    // Not a cell changed, so not an undo step — the same rule as the emissive flag.
    expect(edited.volume.data).toEqual(before)
    expect(edited.history.past).toHaveLength(0)
    expect(edited.sheet).toBeUndefined()

    const replaced = reduce(state, {type: 'replace-color', from: state.color, to: 200})
    expect(replaced.history.past).toHaveLength(1)
    expect(replaced.color).toBe(200)
    expect(occupied(replaced.volume)).toBe(occupied(state.volume))
    expect(reduce(replaced, {type: 'undo'}).volume.data).toEqual(before)
    // Replacing a colour nothing uses changes nothing at all.
    expect(reduce(state, {type: 'replace-color', from: 199, to: 200})).toBe(state)
})

test('a locked palette refuses every change to what a colour is, and no change to the model', () => {
    const state = reduce(fresh(), {type: 'palette-lock', on: true})

    expect(reduce(state, {type: 'palette-color', color: 1, css: '#ffffff'})).toBe(state)
    expect(reduce(state, {type: 'palette-add'})).toBe(state)
    expect(reduce(state, {type: 'palette-load', text: 'ff0000\n'})).toBe(state)

    // Replacing a colour moves voxels between entries; it does not change an entry, so it stands.
    expect(
        reduce(state, {type: 'replace-color', from: state.color, to: 200}).history.past
    ).toHaveLength(1)
})

test('adding a colour loads the first slot the model is not already using', () => {
    const state = fresh()
    const added = reduce(state, {type: 'palette-add'})
    expect(added.color).toBeGreaterThan(0)
    expect([...state.volume.data]).not.toContain(added.color)
    expect(added.recent[0]).toBe(added.color)
})

test('loading a palette replaces the colours and leaves every voxel where it was', () => {
    const state = fresh()
    const loaded = reduce(state, {type: 'palette-load', text: 'ff0000\n00ff00\n0000ff\n'})
    expect([...loaded.volume.palette.subarray(4, 8)]).toEqual([255, 0, 0, 255])
    expect([...loaded.volume.palette.subarray(12, 16)]).toEqual([0, 0, 255, 255])
    expect(loaded.volume.data).toBe(state.volume.data)
    expect(loaded.sheet).toBeUndefined()
})

test('dragging a view along the strip reorders the sheet it packs', () => {
    const state = fresh()
    const names = (next: AppState): string[] => next.cameras.map(({name}) => name)

    const held = reduce(state, {type: 'drag-camera', id: 'dir-0'})
    expect(held.dragging).toBe('dir-0')

    const moved = reduce(held, {type: 'reorder-camera', id: 'dir-0', to: 2})
    expect(names(moved).slice(0, 3)).toEqual(['Front Right', 'Right', 'Front'])
    // The bake is laid out in list order, so a reorder is a different sheet.
    expect(
        reduce(reduce(state, {type: 'bake'}), {type: 'reorder-camera', id: 'dir-0', to: 2}).sheet
    ).toBeUndefined()

    // Dropping it where it already is changes nothing at all.
    expect(reduce(moved, {type: 'reorder-camera', id: 'dir-0', to: 2})).toBe(moved)
    expect(reduce(moved, {type: 'reorder-camera', id: 'nope', to: 0})).toBe(moved)
})

test('padding changes the sheet it is baked into and nothing else', () => {
    const tight = reduce(reduce(fresh(), {type: 'preset', preset: 'Every map'}), {type: 'bake'})
    const loose = reduce(
        reduce(reduce(fresh(), {type: 'preset', preset: 'Every map'}), {
            type: 'padding',
            padding: 2
        }),
        {type: 'bake'}
    )
    expect(loose.sheet?.width).toBeGreaterThan(tight.sheet?.width ?? 0)
    expect(loose.sheet?.cell).toBe(tight.sheet?.cell as never)
    expect(reduce(tight, {type: 'padding', padding: 1}).sheet).toBeUndefined()

    // Collision bounds are a fact about the JSON, so the baked sheet is still good.
    expect(reduce(tight, {type: 'bounds', on: true}).sheet).toBe(tight.sheet)
})

test('a saved preset joins the list and can be taken back out of it', () => {
    const state = fresh()
    const saved = reduce(state, {type: 'save-preset', name: 'My rig', maps: ['color', 'ao']})
    expect(saved.preset).toBe('My rig')
    expect(allPresets(saved).map(entry => entry.name)).toContain('My rig')
    expect(presetMaps(saved, 'My rig')).toEqual(['color', 'ao'])
    expect(Object.keys(reduce(saved, {type: 'bake'}).sheet?.maps ?? {}).sort()).toEqual([
        'ao',
        'color'
    ])

    // A built-in name is not available, and a blank one is not a name.
    expect(reduce(state, {type: 'save-preset', name: 'Every map', maps: ['color']})).toBe(state)
    expect(reduce(state, {type: 'save-preset', name: '  ', maps: ['color']})).toBe(state)

    // Saving the same name twice replaces rather than doubling.
    const again = reduce(saved, {type: 'save-preset', name: 'My rig', maps: ['color']})
    expect(again.presets).toHaveLength(1)

    const dropped = reduce(again, {type: 'drop-preset', name: 'My rig'})
    expect(dropped.presets).toHaveLength(0)
    expect(dropped.preset).toBe('Sprite Sheet (Auto)')
    expect(reduce(dropped, {type: 'drop-preset', name: 'My rig'})).toBe(dropped)
})

test('one reference per plane, and a locked one refuses to be dimmed or dropped', () => {
    const state = fresh()
    const front = reduce(state, {type: 'reference', plane: 1, url: 'data:image/png;base64,AA'})
    expect(front.references).toHaveLength(1)
    expect(front.references[0]?.opacity).toBe(0.5)

    // A second front view replaces the first rather than stacking on it.
    const again = reduce(front, {type: 'reference', plane: 1, url: 'data:image/png;base64,BB'})
    expect(again.references).toHaveLength(1)
    expect(again.references[0]?.url).toBe('data:image/png;base64,BB')

    const both = reduce(again, {type: 'reference', plane: 2, url: 'data:image/png;base64,CC'})
    expect(both.references).toHaveLength(2)

    const dimmer = reduce(both, {type: 'reference-opacity', plane: 1, opacity: 0.2})
    expect(dimmer.references.find(entry => entry.plane === 1)?.opacity).toBe(0.2)
    // Opacity is a fraction, whatever the stepper asks for.
    expect(
        reduce(both, {type: 'reference-opacity', plane: 1, opacity: 9}).references[0]?.opacity
    ).toBe(1)

    const locked = reduce(both, {type: 'reference-lock', plane: 1, on: true})
    expect(
        reduce(locked, {type: 'reference-opacity', plane: 1, opacity: 0.1}).references[0]?.opacity
    ).toBe(0.5)
    expect(reduce(locked, {type: 'reference-drop', plane: 1}).references).toHaveLength(2)
    expect(reduce(both, {type: 'reference-drop', plane: 1}).references).toHaveLength(1)
})

test('importing a PNG opens it as a document and keeps the references and presets', () => {
    const saved = reduce(
        reduce(fresh(), {type: 'reference', plane: 1, url: 'data:image/png;base64,AA'}),
        {type: 'save-preset', name: 'Mine', maps: ['color']}
    )
    const {volume: built} = voxelsFromImage(
        Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]),
        2,
        1,
        3
    )

    const opened = reduce(saved, {type: 'import-image', volume: built, name: 'hero.png'})
    // The cells are the image's, byte for byte — the import is what decides what a voxel is.
    expect(opened.volume.data).toBe(built.data)
    expect([opened.volume.sx, opened.volume.sy, opened.volume.sz]).toEqual([2, 3, 1])
    // The palette is not: a PNG brings as many colours as it had, and the rest of the 255 slots come
    // up as the default palette rather than as 253 blanks. The image's own two are untouched.
    expect([...opened.volume.palette.subarray(4, 12)]).toEqual([255, 0, 0, 255, 0, 0, 255, 255])
    expect([...opened.volume.palette.subarray(12, 16)]).toEqual([0, 0, 0, 255])
    // A new document: its own cameras, its own history, its own objects.
    expect(opened.history.past).toHaveLength(0)
    expect(opened.objects.list).toHaveLength(1)
    expect(opened.cameras).toHaveLength(8)
    // But the artist's own settings are theirs, not the file's.
    expect(opened.references).toHaveLength(1)
    expect(opened.presets).toHaveLength(1)
})

test('slice mode opens on the middle layer, walks with the wheel, and leaves with the plane', () => {
    const state = fresh()
    expect(state.slice).toBeUndefined()

    // A slice needs a plane to be a slice of, so switching it on locks XY if nothing was locked.
    const sliced = reduce(state, {type: 'slice', on: true})
    expect(sliced.plane).toBe(2)
    expect(sliced.slice).toBe(Math.floor(state.volume.sz / 2))

    // The wheel walks through depth rather than zooming, which is the whole of §6's second bullet.
    const wheel = {type: 'orbit', event: {type: 'wheel', delta: 40}, height: 400} as const
    const deeper = reduce(sliced, wheel)
    expect(deeper.slice).toBe((sliced.slice ?? 0) + 1)
    expect(deeper.orbit.camera.zoom).toBe(sliced.orbit.camera.zoom)
    // And it stops at the end rather than wrapping round to the other side of the model.
    let walked = deeper
    for (let i = 0; i < 20; i += 1) walked = reduce(walked, wheel)
    expect(walked.slice).toBe(state.volume.sz - 1)

    // Zoom is still on the wheel when the mode is off.
    expect(reduce(state, wheel).orbit.camera.zoom).not.toBe(state.orbit.camera.zoom)

    expect(reduce(sliced, {type: 'slice', on: false}).slice).toBeUndefined()
    expect(reduce(sliced, {type: 'plane', axis: undefined}).slice).toBeUndefined()
    expect(reduce(state, {type: 'slice-step', delta: 1})).toBe(state)
})

test('a stroke in slice mode lands on the slice, not on whatever the ray hit', () => {
    const state = reduce(reduce(armed('draw'), {type: 'plane', axis: 2}), {type: 'slice', on: true})
    const {column, row} = onModel(state)
    const down = reduce(state, at('down', column, row))

    expect(down.stroke?.axis).toBe(2)
    expect(down.stroke?.layer).toBe(state.slice as never)
    // Every cell it wrote is on that one layer.
    const {sx, sy} = state.volume
    const done = reduce(down, at('up', column, row))
    for (const index of done.history.past[0]?.at ?? []) {
        expect(Math.floor(index / (sx * sy))).toBe(state.slice as never)
    }
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

test('the outline names the cells the click is about to write, not an approximation of them', () => {
    const state = armed('draw')
    const {column, row} = onModel(state)

    const aimed = reduce(state, at('move', column, row))
    const hover = aimed.hover
    if (!hover) throw new Error('the pointer is over the model')
    expect(hover.blocked).toBe(false)

    // The same pixel, pressed. What was outlined has to be exactly what was written — a preview
    // that is merely close is a preview the artist learns to distrust.
    const drawn = reduce(reduce(aimed, at('down', column, row)), at('up', column, row))
    const edit = drawn.history.past[0]
    if (!edit) throw new Error('the click wrote something')
    const outlined = new Set(hover.cells.map(([x, y, z]) => voxelIndex(state.volume, x, y, z)))
    expect(new Set(edit.at)).toEqual(outlined)
})

test('a click that would write nothing says so before the press, not after', () => {
    // The `+y` face of `car.vox` is flush with the grid, so Draw there aims at a cell that does not
    // exist and the press is silent. That silence is what `blocked` is for.
    const state = reduce(armed('draw'), {type: 'select', id: fresh().cameras[0]?.id ?? ''})
    const basis = basisFor(state.orbit.camera, state.volume, SIZE)
    const {id} = render(state.volume, basis, SIZE, SIZE)

    let silent: {column: number; row: number} | undefined
    let live: {column: number; row: number} | undefined
    for (let index = 0; index < id.length && !(silent && live); index += 1) {
        if ((id[index] ?? 0) === 0) continue
        const spot = {column: index % SIZE, row: Math.floor(index / SIZE)}
        const done = reduce(
            reduce(state, at('down', spot.column, spot.row)),
            at('up', spot.column, spot.row)
        )
        if (done.history.past.length === 0) silent ??= spot
        else live ??= spot
    }
    if (!silent || !live) throw new Error('the model has both kinds of pixel from the front')

    expect(reduce(state, at('move', silent.column, silent.row)).hover?.blocked).toBe(true)
    expect(reduce(state, at('move', live.column, live.row)).hover?.blocked).toBe(false)
})

test('the outline re-aims when the brush changes, without the mouse moving', () => {
    const state = armed('draw')
    const {column, row} = onModel(state)
    const aimed = reduce(state, at('move', column, row))
    expect(aimed.hover?.cells).toHaveLength(4)

    // Nothing but the brush changed, and the outline is already the new footprint.
    const bigger = reduce(aimed, {type: 'brush', brush: {size: 3}})
    expect(bigger.hover?.cells).toHaveLength(9)

    // Arming a tool that is not about the brush re-aims too, and the answer stops being a footprint:
    // Move takes hold of the one voxel under the cursor, whatever the brush is set to.
    const grabbing = reduce(bigger, {type: 'tool', tool: 'move'})
    expect(grabbing.hover?.kind).toBe('grab')
    expect(grabbing.hover?.cells).toHaveLength(1)
})

test('nothing is outlined while a gesture owns the pointer, or once it has left', () => {
    const state = armed('draw')
    const {column, row} = onModel(state)
    const aimed = reduce(state, at('move', column, row))
    expect(aimed.hover).toBeDefined()

    // Mid-stroke the voxels themselves are the preview.
    expect(reduce(aimed, at('down', column, row)).hover).toBeUndefined()
    // Mid-orbit the picture is still moving.
    expect(reduce(aimed, at('down', column, row, {button: 2})).hover).toBeUndefined()
    expect(reduce(aimed, {type: 'unaim'}).hover).toBeUndefined()
    expect(reduce(aimed, {type: 'unaim'}).aim).toBeUndefined()
})

test('draw and erase outline the same plane: the face the ray struck', () => {
    const {column, row} = onModel(armed('draw'))

    // Draw aims at the empty cell in front of the surface, Erase at the voxel behind it. They are
    // one voxel apart and the outline belongs on the surface between them, for both.
    const drawing = reduce(armed('draw'), at('move', column, row)).hover
    const erasing = reduce(armed('erase'), at('move', column, row)).hover
    if (!drawing || !erasing) throw new Error('the pointer is over the model')
    expect(drawing.face).toBe(erasing.face)
    expect(drawing.surface).toBe(erasing.surface)

    // And the plane really is the boundary: the two cells sit on either side of it.
    const axis =
        drawing.face === 1 || drawing.face === 2 ? 0
        : drawing.face <= 4 ? 1
        : 2
    const near = Math.min(drawing.cell[axis], erasing.cell[axis])
    expect(drawing.surface).toBe(near + 1)
})

test('with erase armed the viewport is handed the hole, and every other tool the model', () => {
    const state = armed('erase')
    const {column, row} = onModel(state)
    const aimed = reduce(state, at('move', column, row))
    const hover = aimed.hover
    if (!hover) throw new Error('the pointer is over the model')

    // The preview is the document minus exactly the cells the press would clear, and the document
    // itself is untouched — nothing here is an edit.
    const preview = previewVolume(aimed, aimed.volume)
    expect(occupied(preview)).toBe(occupied(aimed.volume) - hover.cells.length)
    for (const [x, y, z] of hover.cells) expect(voxelAt(preview, x, y, z)).toBe(0)
    expect(occupied(aimed.volume)).toBe(occupied(state.volume))

    // Draw proposes voxels that are not there yet, so the render must not show them as though they
    // were: the overlay says what is coming, and the grid handed to the viewport is the real one.
    const drawing = reduce(armed('draw'), at('move', column, row))
    expect(previewVolume(drawing, drawing.volume)).toBe(drawing.volume)
    expect(previewVolume(reduce(aimed, {type: 'unaim'}), aimed.volume)).toBe(aimed.volume)

    // Sampling and grabbing change no voxels at all, so neither may touch the grid either.
    for (const tool of ['pick', 'move', 'rotate', 'scale', 'clone'] as const) {
        const idle = reduce(armed(tool), at('move', column, row))
        expect(idle.hover).toBeDefined()
        expect(previewVolume(idle, idle.volume)).toBe(idle.volume)
    }
})

test('every tool that does something says what, before the press', () => {
    const live: readonly Tool[] = [
        'draw',
        'erase',
        'fill',
        'pick',
        'move',
        'rotate',
        'scale',
        'clone'
    ]
    const {column, row} = onModel(fresh())

    for (const tool of live) {
        const aimed = reduce(armed(tool), at('move', column, row))
        const hover = aimed.hover
        if (!hover) throw new Error(`${tool} has an answer with the pointer on the model`)
        // Either the cells to draw one cube each for, or a box standing in for too many of them.
        expect(hover.cells.length > 0 || hover.bounds !== undefined).toBe(true)
        expect(hover.blocked).toBe(false)
    }

    // Measure is not built, and a preview of a gesture that does not exist is the worst lie of all.
    expect(reduce(armed('measure'), at('move', column, row)).hover).toBeUndefined()
})

test('the five kinds say what happens to the voxels, not which button is lit', () => {
    const {column, row} = onModel(fresh())
    const kindOf = (tool: Tool): string | undefined =>
        reduce(armed(tool), at('move', column, row)).hover?.kind

    expect(kindOf('draw')).toBe('write')
    expect(kindOf('erase')).toBe('clear')
    expect(kindOf('fill')).toBe('recolour')
    expect(kindOf('pick')).toBe('sample')
    // Four tools, one promise: these voxels are about to be taken hold of.
    for (const tool of ['move', 'rotate', 'scale', 'clone'] as const)
        expect(kindOf(tool)).toBe('grab')
})

test('Fill outlines the region it floods, and the viewport is handed the new paint', () => {
    const state = armed('fill')
    const {column, row} = onModel(state)
    const aimed = reduce(state, at('move', column, row))
    const hover = aimed.hover
    if (!hover?.region) throw new Error('the pointer is over the model')

    // More than the one cell the ray landed on: the whole point is that a flood is not a footprint.
    expect(hover.region.size).toBeGreaterThan(1)

    // Exactly the cells the press recolours — not an approximation of them.
    const filled = reduce(reduce(aimed, at('down', column, row)), at('up', column, row))
    const edit = filled.history.past[0]
    if (!edit) throw new Error('the press wrote something')
    expect(new Set(edit.at)).toEqual(new Set(hover.region))

    // And the render is showing the answer, because a recolour cannot be drawn over: every one of
    // those cells already carries the new paint before the button goes down.
    const preview = previewVolume(aimed, aimed.volume)
    expect(preview).not.toBe(aimed.volume)
    for (const index of hover.region) expect(preview.data[index]).toBe(aimed.color)
    expect(occupied(preview)).toBe(occupied(aimed.volume))
})

test('Pick proposes the colour it would take, not the one already loaded', () => {
    const state = armed('pick')
    const {column, row} = onModel(state)
    const aimed = reduce(state, at('move', column, row))
    const hover = aimed.hover
    if (!hover) throw new Error('the pointer is over the model')

    // The paint on the proposal is what the press loads. Drawing the *current* colour there would
    // say "this goes here", and Pick puts nothing anywhere.
    const picked = reduce(reduce(aimed, at('down', column, row)), at('up', column, row))
    expect(hover.paint).toBe(picked.color)
    expect(hover.paint).not.toBe(state.color)

    // Aim at it again with that colour loaded and the press would do nothing, which is `blocked`.
    expect(reduce(picked, at('move', column, row)).hover?.blocked).toBe(true)
})

test('the grab tools outline what the press would take hold of', () => {
    const {column, row} = onModel(fresh())

    for (const tool of ['move', 'rotate', 'scale', 'clone'] as const) {
        const aimed = reduce(armed(tool), at('move', column, row))
        const hover = aimed.hover
        if (!hover?.region) throw new Error(`${tool} has an answer with the pointer on the model`)

        // The press, and the selection it leaves behind. Outlined has to be exactly selected.
        const pressed = reduce(aimed, at('down', column, row))
        expect(pressed.selection).toEqual(hover.region)
    }
})

test('a footprint too large to draw arrives as a box instead', () => {
    // Alt with a grab tool takes the whole object, which on `car.vox` is 478 voxels — just under the
    // cap, so it still comes through cell by cell and the cap is not firing by accident.
    const {column, row} = onModel(fresh())
    const grabbed = reduce(armed('move'), {
        type: 'pointer',
        event: {...at('move', column, row).event, alt: true}
    })
    expect(grabbed.hover?.region?.size).toBeGreaterThan(1)
    expect(grabbed.hover?.cells.length).toBe(grabbed.hover?.region?.size)

    /*
     * A solid block of one paint, which is what a fill cannot be allowed to draw a wireframe of. The
     * region is still the whole truth and the box still says where it is; only the per-cell list —
     * the one thing that costs 10 µs a cell to draw — is dropped.
     */
    const block = createVolume(12, 12, 12, volume.palette)
    block.data.fill(1)
    const big = initialState(block)
    const spot = onModel(big)
    const hover = reduce(
        reduce(big, {type: 'tool', tool: 'fill'}),
        at('move', spot.column, spot.row)
    ).hover
    if (!hover) throw new Error('the pointer is over the block')
    expect(hover.region?.size).toBe(12 * 12 * 12)
    expect(hover.region?.size).toBeGreaterThan(GHOST_CELLS)
    expect(hover.cells).toHaveLength(0)
    expect(hover.bounds).toEqual({min: [0, 0, 0], max: [11, 11, 11]})
})

/**
 * The warning a drag owes the artist.
 *
 * Move overwrites whatever it lands on and pushes off the grid whatever will not fit, and until
 * this existed nothing said so: the voxels were gone from the picture before there was anything to
 * notice. `losing` is live while the drag is, so the bar can say it *before* the button comes up,
 * which is the only moment the artist can still call it off.
 *
 * The assertion is the whole contract and not a sample of it: for a move, the number has to be the
 * difference the drop makes to how many voxels the model has. Swept over fifteen offsets, because
 * the two ways to lose one — eaten by an occupied cell, carried off the edge — sit at different
 * distances and either alone would pass a single-point test.
 */
test('a drag says how many voxels its landing would destroy, while it can still be called off', () => {
    const state = armed('move')
    const {column, row} = onModel(state)
    const before = occupied(state.volume)
    expect(state.losing).toBe(0)

    const down = reduce(state, at('down', column, row))
    expect(down.selection.size).toBe(1)
    expect(down.losing).toBe(0)

    const offsets = [
        [1, 0],
        [2, 0],
        [3, 0],
        [4, 0],
        [-1, 0],
        [-2, 0],
        [-3, 0],
        [0, 1],
        [0, 2],
        [0, 3],
        [0, -1],
        [0, -2],
        [0, -3],
        [2, 2],
        [-2, -2]
    ] as const

    let sawALoss = false
    for (const [dx, dy] of offsets) {
        const landed = reduce(down, at('move', column + dx, row + dy))
        const lost = before - occupied(landed.volume)
        expect(landed.losing, `drag (${String(dx)}, ${String(dy)})`).toBe(lost)
        if (lost > 0) sawALoss = true
    }
    // A test where nothing is ever lost proves only that zero equals zero.
    expect(sawALoss).toBe(true)

    // The gesture ends and the warning goes with it: it was about a drop, not about the document.
    expect(reduce(down, at('up', column, row)).losing).toBe(0)
})
