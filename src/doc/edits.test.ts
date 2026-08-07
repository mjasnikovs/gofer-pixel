import {expect, test} from 'bun:test'
import {FACE_X_POS, FACE_Z_POS} from '../render/faces'
import {createVolume, setVoxel, voxelAt, type Volume} from '../render/volume'
import {brushOffsets, faceAxis, type Brush} from './brush'
import {
    applyEdit,
    beginEdit,
    commitEdit,
    connected,
    fillRegion,
    revertEdit,
    stampBrush,
    strokeBrush,
    writeVoxel
} from './edits'
import {EMPTY_HISTORY, HISTORY_LIMIT, canRedo, canUndo, record, redo, undo} from './history'

const brush = (over: Partial<Brush> = {}): Brush => ({
    kind: 'voxel',
    size: 1,
    shape: 'square',
    figure: 'free',
    ...over
})

const filled = ({data}: Volume): number => data.reduce((n, value) => (value === 0 ? n : n + 1), 0)

test('a draft leaves the volume it was opened on untouched', () => {
    const volume = createVolume(8, 8, 8)
    const draft = beginEdit(volume)
    writeVoxel(draft, 1, 2, 3, 7)

    expect(voxelAt(draft.volume, 1, 2, 3)).toBe(7)
    expect(voxelAt(volume, 1, 2, 3)).toBe(0)
    expect(draft.volume.data).not.toBe(volume.data)
    // The palette is shared on purpose: a stroke changes cells, never colours.
    expect(draft.volume.palette).toBe(volume.palette)
})

test('a stroke that crosses itself undoes to where it started, not to its middle', () => {
    const volume = createVolume(8, 8, 8)
    setVoxel(volume, 4, 4, 4, 3)

    const draft = beginEdit(volume)
    writeVoxel(draft, 4, 4, 4, 9)
    writeVoxel(draft, 4, 4, 4, 11)
    const edit = commitEdit(draft)
    if (!edit) throw new Error('the stroke changed a cell')

    expect(edit.at).toHaveLength(1)
    expect(edit.from[0]).toBe(3)
    expect(edit.to[0]).toBe(11)
    expect(voxelAt(revertEdit(draft.volume, edit), 4, 4, 4)).toBe(3)
})

test('a stroke that ends where it began is not an undo step', () => {
    const volume = createVolume(4, 4, 4)
    const draft = beginEdit(volume)
    writeVoxel(draft, 0, 0, 0, 5)
    writeVoxel(draft, 0, 0, 0, 0)
    expect(commitEdit(draft)).toBeUndefined()
})

test('a fast drag leaves a line, not a dotted line', () => {
    const volume = createVolume(32, 32, 32)
    const draft = beginEdit(volume)
    strokeBrush(draft, brush(), FACE_Z_POS, [2, 2, 2], [20, 9, 2], 4)

    // Every step of the line is occupied — no gap anywhere along it.
    for (let x = 2; x <= 20; x += 1) {
        const column = Array.from({length: 32}, (_, y) => voxelAt(draft.volume, x, y, 2))
        expect(column.some(value => value !== 0)).toBe(true)
    }
})

test('a flat brush lies in the plane of the face it is drawn on', () => {
    const wide = brush({size: 4, shape: 'square'})
    expect(brushOffsets(wide, FACE_Z_POS).every(([, , dz]) => dz === 0)).toBe(true)
    expect(brushOffsets(wide, FACE_X_POS).every(([dx]) => dx === 0)).toBe(true)
    expect(brushOffsets(wide, FACE_Z_POS)).toHaveLength(16)
    expect(brushOffsets(brush({size: 4, shape: 'cube'}), FACE_Z_POS)).toHaveLength(64)

    expect(faceAxis(FACE_X_POS)).toBe(0)
    expect(faceAxis(FACE_Z_POS)).toBe(2)
})

test('a ring is a circle with its middle taken out, and neither is bigger than a square', () => {
    for (let size = 1; size <= 8; size += 1) {
        const square = brushOffsets(brush({size, shape: 'square'})).length
        const circle = brushOffsets(brush({size, shape: 'circle'})).length
        const ring = brushOffsets(brush({size, shape: 'ring'})).length
        expect(circle).toBeLessThanOrEqual(square)
        expect(ring).toBeLessThanOrEqual(circle)
        expect(circle).toBeGreaterThan(0)
    }
    expect(brushOffsets(brush({size: 5, shape: 'circle'}))).toHaveLength(21)
    expect(brushOffsets(brush({size: 5, shape: 'ring'}))).toHaveLength(12)
})

test('fill recolours a connected region and stops at a one-voxel gap', () => {
    const volume = createVolume(8, 8, 8)
    for (let x = 0; x < 3; x += 1) setVoxel(volume, x, 0, 0, 2)
    // Same colour, one cell of air away — a diagonal touch is not a connection.
    setVoxel(volume, 4, 0, 0, 2)
    setVoxel(volume, 3, 1, 0, 2)

    const draft = beginEdit(volume)
    fillRegion(draft, 0, 0, 0, 9)
    expect(voxelAt(draft.volume, 2, 0, 0)).toBe(9)
    expect(voxelAt(draft.volume, 4, 0, 0)).toBe(2)
    expect(voxelAt(draft.volume, 3, 1, 0)).toBe(2)
    expect(connected(volume, 0, 0, 0).size).toBe(3)
})

test('fill on empty space does nothing at all', () => {
    const volume = createVolume(16, 16, 16)
    setVoxel(volume, 8, 8, 8, 1)
    const draft = beginEdit(volume)
    fillRegion(draft, 0, 0, 0, 4)
    expect(commitEdit(draft)).toBeUndefined()
    expect(filled(draft.volume)).toBe(1)
})

test('undo and redo walk a stack of strokes and land on the same bytes', () => {
    const volume = createVolume(8, 8, 8)
    const first = beginEdit(volume)
    stampBrush(first, brush({size: 3, shape: 'square'}), FACE_Z_POS, 4, 4, 4, 6)
    const one = commitEdit(first)
    if (!one) throw new Error('the first stroke changed cells')

    const second = beginEdit(first.volume)
    stampBrush(second, brush(), FACE_Z_POS, 0, 0, 0, 7)
    const two = commitEdit(second)
    if (!two) throw new Error('the second stroke changed cells')

    const live = second.volume
    const history = record(record(EMPTY_HISTORY, one), two)
    expect(canUndo(history)).toBe(true)
    expect(canRedo(history)).toBe(false)

    const back = undo(live, history)
    if (!back) throw new Error('there was something to undo')
    expect(voxelAt(back.volume, 0, 0, 0)).toBe(0)
    expect(filled(back.volume)).toBe(9)

    const again = undo(back.volume, back.history)
    if (!again) throw new Error('there were two strokes')
    expect(filled(again.volume)).toBe(0)
    expect(again.volume.data).toEqual(volume.data)
    expect(canUndo(again.history)).toBe(false)
    expect(canRedo(again.history)).toBe(true)

    let forward = redo(again.volume, again.history)
    if (!forward) throw new Error('there was something to redo')
    forward = redo(forward.volume, forward.history)
    if (!forward) throw new Error('there were two strokes to redo')
    expect(forward.volume.data).toEqual(live.data)

    // A new stroke after an undo abandons the branch, rather than leaving a redo that would jump
    // the model somewhere the artist has not been.
    expect(canRedo(record(again.history, one))).toBe(false)
})

test('history forgets its oldest strokes rather than growing without bound', () => {
    const volume = createVolume(4, 4, 4)
    let history = EMPTY_HISTORY
    const draft = beginEdit(volume)
    writeVoxel(draft, 0, 0, 0, 1)
    const edit = commitEdit(draft)
    if (!edit) throw new Error('the stroke changed a cell')
    for (let i = 0; i < HISTORY_LIMIT + 10; i += 1) history = record(history, edit)
    expect(history.past).toHaveLength(HISTORY_LIMIT)
})

test('an edit applied and reverted is the identity, cell for cell', () => {
    const volume = createVolume(16, 16, 16)
    for (let i = 0; i < 40; i += 1)
        setVoxel(volume, i % 16, (i * 7) % 16, (i * 3) % 16, (i % 5) + 1)

    const draft = beginEdit(volume)
    stampBrush(draft, brush({size: 5, shape: 'circle'}), FACE_Z_POS, 8, 8, 8, 12)
    const edit = commitEdit(draft)
    if (!edit) throw new Error('the stamp changed cells')

    expect(applyEdit(volume, edit).data).toEqual(draft.volume.data)
    expect(revertEdit(draft.volume, edit).data).toEqual(volume.data)
})
