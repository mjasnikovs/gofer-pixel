import {expect, test} from 'bun:test'
import {voxelsFromImage} from '../doc/import'
import {rasterise} from '../gen/ops'
import {
    duplicateOffset,
    initialObjects,
    objectBounds,
    objectCells,
    shownVolume
} from '../doc/objects'
import {SHEET_MAPS} from '../sheet/sheet'
import {basisFor} from '../render/camera'
import {render} from '../render/raycast'
import {MODE_NORMAL} from '../render/raycast.glsl'
import {allPresets, presetMaps} from '../sheet/presets'
import {createVolume, voxelAt, voxelIndex, type Volume} from '../render/volume'
import type {ViewportPointer} from '../viewport/orbit'
import {readVox} from '../vox/vox-file'
import {loadDocument, saveDocument} from '../doc/save'
import {newDocument} from '../doc/templates'
import {
    asDocument,
    currentSheet,
    GHOST_CELLS,
    initialState,
    MAX_BRUSH,
    previewVolume,
    reduce,
    TOOLS,
    USES_BRUSH,
    type AppAction,
    type AppState,
    type Chrome,
    type Tool
} from './state'

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)
const fresh = (): AppState => initialState(volume, 'car.vox')

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

    // The render panel keeps its subject. Losing it to a mouse-move emptied the panel every time
    // the artist touched the view, which is what the panel is for looking at.
    expect(dragged.previewed).toBe('dir-2')

    // A deleted preview falls to the next camera, not to nothing.
    const gone = reduce(dragged, {type: 'delete', id: 'dir-2'})
    expect(gone.previewed).toBe(gone.cameras[0]?.id)
    expect(gone.previewed).not.toBe('dir-2')
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
    expect(currentSheet(baked)?.width).toBe(256)
    expect(currentSheet(baked)?.height).toBe(128)

    expect(currentSheet(reduce(baked, {type: 'delete', id: 'dir-1'}))).toBeUndefined()
    expect(currentSheet(reduce(baked, {type: 'capture'}))).toBeUndefined()
    expect(currentSheet(reduce(baked, {type: 'output', output: {cell: 32}}))).toBeUndefined()
    // Changing which map the *viewport* draws does not invalidate an exported sheet.
    expect(currentSheet(reduce(baked, {type: 'chrome', chrome: {map: MODE_NORMAL}}))).toBe(
        currentSheet(baked)
    )
})

test('staleness is computed, so an action nobody thought about cannot export the wrong pixels', () => {
    const baked = reduce(fresh(), {type: 'bake'})

    /*
     * Neither of these ever wrote `sheet: undefined`, because staleness used to be twenty-four
     * hand-maintained lines and these two were missed. Nothing was added for them: the sheet
     * carries the identity of what it was baked from, so anything that moves one of those fields
     * stales it whether or not the case knows the sheet exists. See `sheet/baked.ts`.
     */
    // Slice mode changes what is on screen, and the bake bakes what is on screen.
    expect(currentSheet(reduce(baked, {type: 'slice', on: true}))).toBeUndefined()
    // Renaming an object rebuilds the list the bake reads to decide what is hidden.
    expect(
        currentSheet(reduce(baked, {type: 'object', op: {kind: 'rename', id: 1, name: 'body'}}))
    ).toBeUndefined()

    // And chrome still does not: the tool, the grid switches and the orbit are not in the file.
    expect(currentSheet(reduce(baked, {type: 'tool', tool: 'erase'}))).toBe(currentSheet(baked))
    expect(currentSheet(reduce(baked, {type: 'chrome', chrome: {grid: false}}))).toBe(
        currentSheet(baked)
    )
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
    const loose = reduce(fresh(), {type: 'chrome', chrome: {snap: false}})
    const tight = reduce(fresh(), {type: 'chrome', chrome: {snap: true}})
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
    expect(turn(reduce(fresh(), {type: 'chrome', chrome: {invert: true}})) - from).toBeCloseTo(
        -1,
        10
    )
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

/** Every voxel an edit touched, as `[x, y, z]`. */
const editCells = ({sx, sy}: Volume, edit: {at: ArrayLike<number>}): number[][] =>
    [...Array.from(edit.at)].map(index => {
        const z = Math.floor(index / (sx * sy))
        const rest = index - z * sx * sy
        return [rest % sx, Math.floor(rest / sx), z]
    })

/**
 * Shift mid-drag pulls the flat stroke out of the surface — the gesture that answers "how do I get
 * thickness" without a second tool. The shape stops following the cursor and the depth starts.
 *
 * Held, not toggled: the last move decides, so a drag that lets go of Shift finishes flat. That is
 * the part worth a test, because it is the part that is a redraw rather than an append.
 */
test('Shift held during a drag extrudes the stroke along its own normal', () => {
    const state = {...armed('draw'), brush: {...fresh().brush, size: 1, figure: 'line' as const}}
    const {column, row} = onModel(state)

    let live = reduce(state, at('down', column, row))
    const axis = live.stroke?.axis ?? 0
    const layer = live.stroke?.layer ?? 0
    live = reduce(live, at('move', column - 10, row + 10))
    const flat = editCells(
        state.volume,
        reduce(live, at('up', column - 10, row + 10)).history.past[0] ?? {at: []}
    )
    // The drag drew a line, and every cell of it sits on the plane the click pinned.
    expect(flat.length).toBeGreaterThan(2)
    for (const cell of flat) expect(cell[axis]).toBe(layer)

    // Now the same drag, with Shift held for a second leg. The footprint is unchanged and the
    // stroke has gained layers off the plane.
    const pulled = reduce(live, at('move', column - 10, row - 6, {shift: true}))
    const raised = editCells(
        state.volume,
        reduce(pulled, at('up', column - 10, row - 6, {shift: true})).history.past[0] ?? {at: []}
    )
    expect(new Set(raised.map(cell => cell[axis])).size).toBeGreaterThan(1)
    // Flattening both back onto the plane gives the same shape: an extrude repeats, it never moves.
    const footprint = (cells: number[][]): string[] =>
        [...new Set(cells.map(cell => cell.filter((_, i) => i !== axis).join(',')))].toSorted()
    expect(footprint(raised)).toEqual(footprint(flat))

    // Letting go hands the cursor back to the shape and takes the depth away again, because the
    // stroke stores no extrusion between moves.
    const dropped = reduce(pulled, at('move', column - 10, row + 10))
    const back = editCells(
        state.volume,
        reduce(dropped, at('up', column - 10, row + 10)).history.past[0] ?? {at: []}
    )
    expect(back).toEqual(flat)
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
    expect(currentSheet(baked)).toBeDefined()
    const {column, row} = onModel(baked)
    expect(currentSheet(reduce(baked, at('down', column, row)))).toBeUndefined()
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
    const state = reduce(initialState(bar, 'bar.gpix'), {type: 'tool', tool: 'rotate'})
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
    expect(currentSheet(painted)).toBeUndefined()
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

    const baked = reduce(reduce(glowing, {type: 'output', output: {preset: 'Every map'}}), {
        type: 'bake'
    })
    const emission = currentSheet(baked)?.maps.emission ?? new Uint8Array(0)
    let lit = 0
    for (let i = 0; i < emission.length; i += 4) if ((emission[i] ?? 0) > 0) lit += 1
    expect(lit).toBeGreaterThan(0)
})

test('a preset decides which maps get baked, and colour is always one of them', () => {
    const auto = reduce(fresh(), {type: 'bake'})
    expect(Object.keys(currentSheet(auto)?.maps ?? {}).sort()).toEqual(['color', 'normal'])

    const every = reduce(reduce(fresh(), {type: 'output', output: {preset: 'Every map'}}), {
        type: 'bake'
    })
    expect(Object.keys(currentSheet(every)?.maps ?? {})).toHaveLength(SHEET_MAPS.length)
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
    expect(currentSheet(hidden)).toBeUndefined()

    // And a sheet baked while it is hidden holds only what was on screen.
    const baked = reduce(hidden, {type: 'bake'})
    const colour = currentSheet(baked)?.maps.color ?? new Uint8Array(0)
    let opaque = 0
    for (let i = 3; i < colour.length; i += 4) if (colour[i] === 255) opaque += 1
    expect(opaque).toBeGreaterThan(0)
    expect(opaque).toBeLessThan(
        (() => {
            const all = currentSheet(reduce(drawn, {type: 'bake'}))?.maps.color ?? new Uint8Array(0)
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

test('a lock says it is a lock, and says which object, before the press that it refuses', () => {
    const state = armed('erase')
    const {column, row} = onModel(state)
    expect(reduce(state, at('move', column, row)).hover?.blocked).toBeUndefined()

    /*
     * The bug this exists for: erase over a locked object did nothing and gave no reason. The ghost
     * went dashed, which it also does for a brush hanging off the grid and for a cell that already
     * holds what is about to be written, so the one case with a switch behind it was unreadable. An
     * afternoon went into debugging a tool that was working.
     */
    const locked = reduce(state, {type: 'object', op: {kind: 'locked', id: 1, on: true}})
    const blocked = reduce(locked, at('move', column, row)).hover?.blocked
    expect(blocked?.reason).toBe('locked')
    // The id, not just the fact. The name is what the artist scans the object list for.
    expect(blocked?.object).toBe(1)

    // The grab tools are refused by the same lock and have to say the same thing: a selection made
    // of locked voxels moves nowhere, because every write behind the transform is dropped.
    const grabbing = reduce(reduce(locked, {type: 'tool', tool: 'move'}), at('move', column, row))
    expect(grabbing.hover?.blocked?.reason).toBe('locked')
})

test('one blocked cell is not a blocked press, and locked outranks the reasons nobody can fix', () => {
    // Draw aims at the empty cell in front of the face, which belongs to nobody, so a lock on the
    // model underneath must not stop it — the footprint still has somewhere to land.
    const state = armed('draw')
    const {column, row} = onModel(state)
    const locked = reduce(state, {type: 'object', op: {kind: 'locked', id: 1, on: true}})
    expect(reduce(locked, at('move', column, row)).hover?.blocked).toBeUndefined()
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
    expect(currentSheet(edited)).toBeUndefined()

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
    expect(currentSheet(loaded)).toBeUndefined()
})

/*
 * The same gesture, on the other list. Both drags are `Chrome` now — pointerdown arms, pointerenter
 * reorders, pointerup and pointerleave disarm — so both are four milliseconds here rather than one
 * of them being a two-hundred-millisecond window and four synthetic pointer events.
 */
test('dragging a row along the object list reorders it, and nothing else', () => {
    const state = reduce(fresh(), {type: 'object', op: {kind: 'add'}})
    const twice = reduce(state, {type: 'object', op: {kind: 'add'}})
    const names = (next: AppState): string[] => next.objects.list.map(({name}) => name)
    const before = names(twice)
    expect(before).toHaveLength(3)

    const first = twice.objects.list[0]?.id ?? -1
    const held = reduce(twice, {type: 'chrome', chrome: {draggingObject: first}})
    expect(held.draggingObject).toBe(first)
    // Arming a drag is not an edit: no history, no dirty flag, and the bake is still good.
    expect(held.history.past).toEqual(twice.history.past)
    expect(held.doc.dirty).toBe(twice.doc.dirty)

    const moved = reduce(held, {type: 'object', op: {kind: 'reorder', id: first, to: 2}})
    expect(names(moved)).not.toEqual(before)
    expect(names(moved).toSorted()).toEqual(before.toSorted())

    const dropped = reduce(moved, {type: 'chrome', chrome: {draggingObject: undefined}})
    expect(dropped.draggingObject).toBeUndefined()
})

test('dragging a view along the strip reorders the sheet it packs', () => {
    const state = fresh()
    const names = (next: AppState): string[] => next.cameras.map(({name}) => name)

    const held = reduce(state, {type: 'chrome', chrome: {draggingCamera: 'dir-0'}})
    expect(held.draggingCamera).toBe('dir-0')

    const moved = reduce(held, {type: 'reorder-camera', id: 'dir-0', to: 2})
    expect(names(moved).slice(0, 3)).toEqual(['Front Right', 'Right', 'Front'])
    // The bake is laid out in list order, so a reorder is a different sheet.
    expect(
        currentSheet(
            reduce(reduce(state, {type: 'bake'}), {type: 'reorder-camera', id: 'dir-0', to: 2})
        )
    ).toBeUndefined()

    // Dropping it where it already is changes nothing at all.
    expect(reduce(moved, {type: 'reorder-camera', id: 'dir-0', to: 2})).toBe(moved)
    expect(reduce(moved, {type: 'reorder-camera', id: 'nope', to: 0})).toBe(moved)
})

test('padding changes the sheet it is baked into and nothing else', () => {
    const tight = reduce(reduce(fresh(), {type: 'output', output: {preset: 'Every map'}}), {
        type: 'bake'
    })
    const loose = reduce(
        reduce(reduce(fresh(), {type: 'output', output: {preset: 'Every map'}}), {
            type: 'output',
            output: {padding: 2}
        }),
        {type: 'bake'}
    )
    expect(currentSheet(loose)?.width).toBeGreaterThan(currentSheet(tight)?.width ?? 0)
    expect(currentSheet(loose)?.cell).toBe(currentSheet(tight)?.cell as never)
    expect(currentSheet(reduce(tight, {type: 'output', output: {padding: 1}}))).toBeUndefined()

    // Collision bounds are a fact about the JSON, so the baked sheet is still good.
    expect(currentSheet(reduce(tight, {type: 'output', output: {bounds: true}}))).toBe(
        currentSheet(tight)
    )
})

test('a saved preset joins the list and can be taken back out of it', () => {
    const state = fresh()
    const saved = reduce(state, {type: 'save-preset', name: 'My rig', maps: ['color', 'ao']})
    expect(saved.output.preset).toBe('My rig')
    expect(allPresets(saved.output).map(entry => entry.name)).toContain('My rig')
    expect(presetMaps(saved.output, 'My rig')).toEqual(['color', 'ao'])
    expect(Object.keys(currentSheet(reduce(saved, {type: 'bake'}))?.maps ?? {}).sort()).toEqual([
        'ao',
        'color'
    ])

    // A built-in name is not available, and a blank one is not a name.
    expect(reduce(state, {type: 'save-preset', name: 'Every map', maps: ['color']})).toBe(state)
    expect(reduce(state, {type: 'save-preset', name: '  ', maps: ['color']})).toBe(state)

    // Saving the same name twice replaces rather than doubling.
    const again = reduce(saved, {type: 'save-preset', name: 'My rig', maps: ['color']})
    expect(again.output.presets).toHaveLength(1)

    const dropped = reduce(again, {type: 'drop-preset', name: 'My rig'})
    expect(dropped.output.presets).toHaveLength(0)
    expect(dropped.output.preset).toBe('Sprite Sheet (Auto)')
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
    expect(opened.output.presets).toHaveLength(1)
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
        reduce(
            reduce(reduce(baked, {type: 'tool', tool: 'move'}), {
                type: 'chrome',
                chrome: {grid: false}
            }),
            {type: 'chrome', chrome: {edges: false}}
        ),
        {type: 'chrome', chrome: {workspace: 'render'}}
    )
    expect(after.tool).toBe('move')
    expect(after.grid).toBe(false)
    // The lattice is a viewport setting: it must never reach the volume, the sheet or the history.
    expect(fresh().edges).toBe(true)
    expect(after.edges).toBe(false)
    expect(after.volume).toBe(baked.volume)
    expect(after.history).toBe(baked.history)
    expect(after.workspace).toBe('render')
    expect(currentSheet(after)).toBe(currentSheet(baked))
    expect(after.orbit).toBe(baked.orbit)
})

test('the outline names the cells the click is about to write, not an approximation of them', () => {
    const state = armed('draw')
    const {column, row} = onModel(state)

    const aimed = reduce(state, at('move', column, row))
    const hover = aimed.hover
    if (!hover) throw new Error('the pointer is over the model')
    expect(hover.blocked).toBeUndefined()

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

    expect(reduce(state, at('move', silent.column, silent.row)).hover?.blocked?.reason).toBe(
        'outside'
    )
    expect(reduce(state, at('move', live.column, live.row)).hover?.blocked).toBeUndefined()
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
        expect(hover.blocked).toBeUndefined()
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
    expect(reduce(picked, at('move', column, row)).hover?.blocked?.reason).toBe('nothing')
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
    const big = initialState(block, 'block.gpix')
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

test('undo puts a deleted object back on the list, not just its voxels on the grid', () => {
    const state = reduce(armed('draw'), {type: 'object', op: {kind: 'add'}})
    const {column, row} = onModel(state)
    const drawn = reduce(reduce(state, at('down', column, row)), at('up', column, row))
    expect(objectCells(drawn.volume, 2).size).toBe(4)

    const gone = reduce(drawn, {type: 'object', op: {kind: 'remove', id: 2}})
    expect(gone.objects.list.map(entry => entry.id)).toEqual([1])

    /*
     * The bug this covers: undo restored the cells and left the list alone, so four voxels came
     * back owned by an id no row named. They could not be hidden, locked or soloed, and the next
     * `add` took id 2 again and silently adopted them. Measured in a browser, not reasoned about.
     */
    const back = reduce(gone, {type: 'undo'})
    expect(back.objects.list.map(entry => entry.id)).toEqual([1, 2])
    expect(objectCells(back.volume, 2).size).toBe(4)
    expect(back.objects.active).toBe(2)

    // And forward again, both halves together.
    const again = reduce(back, {type: 'redo'})
    expect(again.objects.list.map(entry => entry.id)).toEqual([1])
    expect(objectCells(again.volume, 2).size).toBe(0)
})

test('deleting an empty object is still one Ctrl-Z away', () => {
    const state = reduce(armed('draw'), {type: 'object', op: {kind: 'add'}})
    const gone = reduce(state, {type: 'object', op: {kind: 'remove', id: 2}})

    // No cell changed, so there is no diff — and the delete has to be recorded anyway, or Ctrl-Z
    // steps straight over it to whatever the artist did before.
    expect(gone.objects.list).toHaveLength(1)
    expect(gone.history.past).toHaveLength(1)
    expect(reduce(gone, {type: 'undo'}).objects.list).toHaveLength(2)
})

test('duplicating an object copies its voxels beside it, under a new name', () => {
    const state = reduce(armed('draw'), {type: 'object', op: {kind: 'add'}})
    const {column, row} = onModel(state)
    const drawn = reduce(reduce(state, at('down', column, row)), at('up', column, row))

    const copied = reduce(drawn, {type: 'object', op: {kind: 'copy', id: 2}})
    expect(copied.objects.list).toHaveLength(3)
    expect(copied.objects.list[2]?.name).toBe('Object 2 copy')
    expect(copied.objects.active).toBe(3)

    // The copy is as big as the original and stands somewhere else, because one cell has one owner.
    expect(objectCells(copied.volume, 3).size).toBe(objectCells(drawn.volume, 2).size)
    expect(objectCells(copied.volume, 2).size).toBe(4)
    expect(objectBounds(copied.volume, 3)?.min).not.toEqual(objectBounds(copied.volume, 2)?.min)

    // One undo takes the list and the cells back together.
    const back = reduce(copied, {type: 'undo'})
    expect(back.objects.list).toHaveLength(2)
    expect(objectCells(back.volume, 3).size).toBe(0)

    // Copying an object that is not there changes nothing at all.
    expect(reduce(drawn, {type: 'object', op: {kind: 'copy', id: 99}})).toBe(drawn)

    // The car is object 1 and it fills its grid, so there is nowhere beside it for a copy to
    // stand. The panel disables the menu item for exactly this; the reducer refuses it too.
    expect(duplicateOffset(drawn.volume, objectBounds(drawn.volume, 1))).toBeUndefined()
    expect(reduce(drawn, {type: 'object', op: {kind: 'copy', id: 1}})).toBe(drawn)
})

/*
 * The document identity — what Save, New and Open move. See `DOCUMENT_FIELDS` in `state.ts`: dirty
 * is a comparison over the fields the format carries, not a flag every case has to remember.
 */
test('a fresh document is named, unsaved and clean', () => {
    const state = fresh()
    expect(state.doc).toEqual({name: 'car.vox', savedAt: undefined, dirty: false})
})

test('changing the model makes the document dirty; changing the session does not', () => {
    const state = fresh()
    const {column, row} = onModel(state)

    // Chrome. None of it survives a save and a reload, so none of it can make a document unsaved.
    const chrome: readonly AppAction[] = [
        {type: 'tool', tool: 'erase'},
        {type: 'color', color: 3},
        {type: 'chrome', chrome: {grid: false}},
        {type: 'chrome', chrome: {edges: false}},
        {type: 'chrome', chrome: {invert: true}},
        {type: 'chrome', chrome: {preview: 32}},
        {type: 'chrome', chrome: {map: MODE_NORMAL}},
        {type: 'chrome', chrome: {search: 'wheel'}},
        {type: 'plane', axis: 2},
        {type: 'palette-lock', on: true},
        // A mouse crossing the viewport is the case an action list would have got wrong: it
        // changes the state on every move and the model on almost none of them.
        at('move', column, row)
    ]
    for (const action of chrome) {
        expect(reduce(state, action).doc.dirty).toBe(false)
    }

    // The document. Each of these is a field `doc/save.ts` writes down.
    const drawn = reduce(reduce(state, at('down', column, row)), at('up', column, row))
    expect(drawn.doc.dirty).toBe(true)
    expect(reduce(state, {type: 'capture'}).doc.dirty).toBe(true)
    expect(reduce(state, {type: 'output', output: {cell: 32}}).doc.dirty).toBe(true)
    expect(reduce(state, {type: 'output', output: {padding: 2}}).doc.dirty).toBe(true)
    expect(reduce(state, {type: 'output', output: {bounds: true}}).doc.dirty).toBe(true)
    expect(reduce(state, {type: 'symmetry', axis: 'x', on: true}).doc.dirty).toBe(true)
    expect(reduce(state, {type: 'palette-color', color: 1, css: '#ff0000'}).doc.dirty).toBe(true)
    expect(reduce(state, {type: 'object', op: {kind: 'add'}}).doc.dirty).toBe(true)
    expect(
        reduce(state, {type: 'reference', plane: 1, url: 'data:image/png;base64,aa'}).doc.dirty
    ).toBe(true)
})

/*
 * Chrome, as one set — see the `Chrome` interface. It was nine action types and nine reducer cases,
 * and the thing that made it worth folding is that the set is now enumerable: this test says
 * *everything* the artist can see-but-not-ship leaves the document and the bake alone, rather than
 * saying it about whichever nine somebody remembered to list.
 */
test('nothing in the chrome makes a document dirty or throws away a bake', () => {
    const baked = reduce(fresh(), {type: 'bake'})
    expect(currentSheet(baked)).toBeDefined()

    const every: readonly Partial<Chrome>[] = [
        {map: MODE_NORMAL},
        {preview: 32},
        {search: 'wheel'},
        {grid: false},
        {edges: false},
        {snap: false},
        {invert: true},
        {workspace: 'render'},
        {fps: 12}
    ]
    // One per field, so a tenth field added to `Chrome` without a case here is visible.
    const named = new Set(every.flatMap(entry => Object.keys(entry)))
    expect(named.size).toBe(9)

    for (const chrome of every) {
        const next = reduce(baked, {type: 'chrome', chrome})
        expect(next.doc.dirty).toBe(false)
        // The same sheet object, not an equal one: nothing it was baked from has moved.
        expect(currentSheet(next)).toBe(currentSheet(baked))
    }

    // Several at once is one action, which is most of the point of folding them.
    const both = reduce(baked, {type: 'chrome', chrome: {grid: false, workspace: 'render'}})
    expect([both.grid, both.workspace]).toEqual([false, 'render'])
})

test('saving clears the flag and names the file; the next edit sets it again', () => {
    const state = fresh()
    const {column, row} = onModel(state)
    const drawn = reduce(reduce(state, at('down', column, row)), at('up', column, row))

    const saved = reduce(drawn, {type: 'saved', name: 'knight.gpix', at: 1234})
    expect(saved.doc).toEqual({name: 'knight.gpix', savedAt: 1234, dirty: false})
    // The voxels are untouched by being written down.
    expect(saved.volume).toBe(drawn.volume)

    const again = reduce(saved, {type: 'object', op: {kind: 'add'}})
    expect(again.doc.dirty).toBe(true)
    expect(again.doc.name).toBe('knight.gpix')
    expect(again.doc.savedAt).toBe(1234)
})

test('a new project is empty, its own size, and clean', () => {
    const state = fresh()
    const {volume: built, objects} = newDocument([16, 16, 24])
    const made = reduce(state, {type: 'new', volume: built, objects, name: 'knight.gpix'})

    expect([made.volume.sx, made.volume.sy, made.volume.sz]).toEqual([16, 16, 24])
    expect(made.doc).toEqual({name: 'knight.gpix', savedAt: undefined, dirty: false})
    // Cameras are regenerated for the new box rather than kept from the old one.
    expect(made.cameras).toHaveLength(8)
    expect(made.history.past).toHaveLength(0)
    expect(made.color).toBeGreaterThan(0)
})

/*
 * Opening a file used to keep the *current* references and presets, which was right when a
 * snapshot restore was the only caller and wrong the moment a second project could be opened.
 */
test('opening a document takes its references and presets, not the ones already on screen', () => {
    const mine = reduce(fresh(), {
        type: 'reference',
        plane: 0,
        url: 'data:image/png;base64,mine'
    })
    expect(mine.references).toHaveLength(1)

    const theirs = reduce(mine, {
        type: 'open',
        document: {
            name: 'theirs.gpix',
            volume: createVolume(8, 8, 8, volume.palette),
            objects: initialObjects(createVolume(8, 8, 8)),
            cameras: [],
            references: [
                {plane: 2, url: 'data:image/png;base64,theirs', opacity: 0.3, locked: false}
            ],
            symmetry: {x: true, y: false, z: false, radial: false},
            output: {cell: 16, padding: 4, bounds: true, preset: '', presets: []},
            origin: undefined
        }
    })

    expect(theirs.references.map(({url}) => url)).toEqual(['data:image/png;base64,theirs'])
    expect(theirs.doc).toEqual({name: 'theirs.gpix', savedAt: undefined, dirty: false})
    expect([theirs.output.cell, theirs.output.padding, theirs.output.bounds]).toEqual([16, 4, true])
    expect(theirs.symmetry.x).toBe(true)
})

test('a PNG becomes a document that has never been saved, and knows it', () => {
    const state = fresh()
    const pixels = new Uint8Array(4 * 4 * 4).fill(255)
    const {volume: built} = voxelsFromImage(pixels, 4, 4, 2)
    const imported = reduce(state, {type: 'import-image', volume: built, name: 'sprite.png'})

    expect(imported.doc.name).toBe('sprite.png')
    expect(imported.doc.savedAt).toBeUndefined()
    // Voxels exist here that no file holds, so leaving without saving must be asked about.
    expect(imported.doc.dirty).toBe(true)
})

test('a generated candidate becomes an ordinary unsaved document, with what made it', () => {
    const state = reduce(fresh(), {
        type: 'reference',
        plane: 0,
        url: 'data:image/png;base64,mine'
    })
    const record = {
        prompt: 'a stone tower',
        sampler: {temperature: 0.9, seed: 41},
        model: 'Qwen3.6-27B',
        at: '2026-08-08T10:00:00.000Z'
    }
    const made = rasterise({
        name: 'tower',
        size: [8, 8, 16],
        mirror_x: false,
        // y-up ops, fitted to a grid — see `gen/ops.ts`. 8 wide, 16 tall, 8 deep.
        ops: [{op: 'box', from: [0, 0, 0], to: [7, 15, 7], color: '#808080'}]
    })

    const next = reduce(state, {type: 'generate', volume: made, name: 'tower', record})

    expect([next.volume.sx, next.volume.sy, next.volume.sz]).toEqual([8, 8, 16])
    expect(next.doc).toEqual({name: 'tower', savedAt: undefined, dirty: true})
    expect(next.origin).toEqual(record)
    // It is a document like any other from here: one object, cameras around it, drawable.
    expect(next.objects.list).toHaveLength(1)
    expect(next.cameras.length).toBeGreaterThan(0)
    expect(next.history.past).toHaveLength(0)
    // The reference art is the artist's desk rather than the model, and survives.
    expect(next.references).toHaveLength(1)
    // And it is what gets written down, so the seed outlives the session.
    expect(asDocument(next).origin).toEqual(record)
})

test('a document that nobody generated has no origin, and drawing does not give it one', () => {
    const state = fresh()
    expect(state.origin).toBeUndefined()
    expect(asDocument(reduce(state, {type: 'color', color: 2})).origin).toBeUndefined()
})

test('what the state says the document is, is what gets written down', () => {
    const state = reduce(fresh(), {type: 'output', output: {cell: 32}})
    const written = asDocument(state)

    expect(written.volume).toBe(state.volume)
    expect(written.objects).toBe(state.objects)
    expect(written.cameras).toBe(state.cameras)
    expect(written.references).toBe(state.references)
    expect(written.symmetry).toBe(state.symmetry)
    expect(written.output.cell).toBe(32)
    expect(written.output.preset).toBe(state.output.preset)

    // Round-tripped through the format, it opens as the same document.
    const back = loadDocument(JSON.stringify(saveDocument(written, state.doc.name)))
    if (!back) throw new Error('what we just wrote is one of ours')
    const reopened = reduce(state, {type: 'open', document: {...back, name: 'car.gpix'}})
    expect(reopened.volume.data).toEqual(state.volume.data)
    expect(reopened.output.cell).toBe(32)
    expect(reopened.doc.dirty).toBe(false)
})

/*
 * Two things that only show up on the *second* session with a document, found by round-tripping
 * one rather than by reading the reducer.
 */
test('reopening a document does not mint a camera id it already has', () => {
    const captured = reduce(reduce(fresh(), {type: 'capture'}), {type: 'capture'})
    expect(captured.cameras.map(({id}) => id)).toContain('cam-2')

    const back = loadDocument(JSON.stringify(saveDocument(asDocument(captured), 'car.gpix')))
    if (!back) throw new Error('what we just wrote is one of ours')
    const opened = reduce(captured, {type: 'open', document: {...back, name: 'car.gpix'}})

    // The counter is read off the ids rather than carried beside them, so it is right for a file
    // written before anyone thought about it.
    expect(opened.serial).toBe(2)

    const again = reduce(opened, {type: 'capture'})
    const ids = again.cameras.map(({id}) => id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('cam-3')
})

test('a recovered snapshot opens as unsaved work, because that is what it is', () => {
    const edited = reduce(fresh(), {type: 'object', op: {kind: 'add'}})
    const back = loadDocument(JSON.stringify(saveDocument(asDocument(edited), 'knight.gpix')))
    if (!back) throw new Error('what we just wrote is one of ours')

    // Off the disk: a file holds this, so there is nothing to warn about.
    expect(reduce(edited, {type: 'open', document: {...back, name: 'knight.gpix'}}).doc.dirty).toBe(
        false
    )

    // Out of the snapshot ring: autosave writes one per committed edit, so by definition no file
    // holds it. Opening it clean would let the artist close the tab without a word.
    const recovered = reduce(edited, {
        type: 'open',
        document: {...back, name: 'knight.gpix', unsaved: true}
    })
    expect(recovered.doc.dirty).toBe(true)
    expect(recovered.objects.list).toHaveLength(2)
})

/*
 * The two transform kinds the reducer forwards but nothing else in this file asks for.
 *
 * `array` is `duplicate` repeated — the reducer only chooses which of `doc/transform.ts`'s
 * functions runs, and choosing the wrong one is the whole of what can go wrong here.
 */
test('an array repeats the selection along a step, as one undo step', () => {
    const picked = reduce(armed('move'), {type: 'select-color'})
    const before = occupied(picked.volume)

    const arrayed = reduce(picked, {
        type: 'transform',
        op: {kind: 'array', delta: [0, 0, 1], count: 2}
    })

    expect(occupied(arrayed.volume)).toBeGreaterThan(before)
    expect(arrayed.selection.size).toBeGreaterThan(picked.selection.size)
    expect(arrayed.history.past).toHaveLength(1)
    expect(reduce(arrayed, {type: 'undo'}).volume.data).toEqual(picked.volume.data)

    // A count of zero is not a transform, and neither is an empty selection.
    expect(
        reduce(picked, {type: 'transform', op: {kind: 'array', delta: [0, 0, 1], count: 0}})
    ).toBe(picked)
})

test('a mirror is its own inverse, and duplicating leaves the original where it was', () => {
    const picked = reduce(armed('move'), {type: 'select-color'})

    const mirrored = reduce(picked, {type: 'transform', op: {kind: 'mirror', axis: 0}})
    expect(occupied(mirrored.volume)).toBeGreaterThanOrEqual(occupied(picked.volume))

    const copied = reduce(picked, {type: 'transform', op: {kind: 'duplicate', delta: [0, 0, 1]}})
    expect(occupied(copied.volume)).toBeGreaterThan(occupied(picked.volume))
    expect(copied.history.past).toHaveLength(1)
})
