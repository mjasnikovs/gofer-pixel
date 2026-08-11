import {expect, test} from 'bun:test'
import {voxelAt} from '../render/volume'
import {countFilled, MAX_SIZE, rasterise, readSpec, type VoxSpec} from './ops'

const spec = (ops: VoxSpec['ops'], over: Partial<VoxSpec> = {}): VoxSpec => ({
    name: 'test',
    size: [8, 8, 8],
    mirror_x: false,
    ops,
    ...over
})

test('a box fills its inclusive bounds and nothing else', () => {
    // Ops are y-up; the grid is z-up and fitted to them. `[1,1,1]…[2,3,4]` is 2 wide, 3 tall and
    // 4 deep, so the grid is 2 x 4 x 3 and the low corner of the box is its origin.
    const volume = rasterise(spec([{op: 'box', from: [1, 1, 1], to: [2, 3, 4], color: '#ff0000'}]))

    expect([volume.sx, volume.sy, volume.sz]).toEqual([2, 4, 3])
    expect(countFilled(volume)).toBe(2 * 3 * 4)
    expect(voxelAt(volume, 0, 0, 0)).toBe(1)
    expect(voxelAt(volume, 1, 3, 2)).toBe(1)
    expect([...volume.palette.subarray(4, 8)]).toEqual([255, 0, 0, 255])
})

test('y is up in an op, and z is up in the volume', () => {
    // The one thing the model would not learn from the prompt. Measured 2026-08-08: asked for z-up
    // it built four legs across the x-z plane with the head at high y anyway, so the language is
    // y-up and the swap lives in the rasteriser.
    const volume = rasterise(
        spec([
            {op: 'box', from: [0, 0, 0], to: [0, 0, 0], color: '#ff0000'},
            {op: 'box', from: [0, 3, 0], to: [0, 3, 0], color: '#00ff00'}
        ])
    )

    // Second op is *above* the first: higher on the volume's z, not deeper on its y.
    expect(voxelAt(volume, 0, 0, 0)).toBe(1)
    expect(voxelAt(volume, 0, 0, 3)).toBe(2)
})

test('the grid fits the ops, not the size the model declared', () => {
    // Every reply measured against the live model on 2026-08-08 wrote outside its own declared
    // size, and what got dropped was always the detail — the ears, the tail.
    const volume = rasterise(
        spec([{op: 'box', from: [0, 0, 0], to: [11, 13, 9], color: '#ffffff'}], {size: [8, 8, 8]})
    )

    expect([volume.sx, volume.sy, volume.sz]).toEqual([12, 10, 14])
    expect(countFilled(volume)).toBe(12 * 14 * 10)
})

test('an erase cannot grow the grid', () => {
    // Otherwise "start from empty" as a carve of the whole world allocates the whole world.
    const volume = rasterise(
        spec([
            {op: 'erase', from: [0, 0, 0], to: [31, 31, 31]},
            {op: 'box', from: [0, 0, 0], to: [1, 1, 1], color: '#ffffff'}
        ])
    )

    expect([volume.sx, volume.sy, volume.sz]).toEqual([2, 2, 2])
})

test('a grid larger than the ceiling is clamped, and the overflow is dropped', () => {
    const volume = rasterise(
        spec([{op: 'box', from: [0, 0, 0], to: [40, 40, 40], color: '#ffffff'}])
    )

    expect([volume.sx, volume.sy, volume.sz]).toEqual([MAX_SIZE, MAX_SIZE, MAX_SIZE])
    expect(countFilled(volume)).toBe(MAX_SIZE ** 3)
})

test('reversed bounds are the same box', () => {
    const forward = rasterise(spec([{op: 'box', from: [1, 1, 1], to: [4, 4, 4], color: '#ffffff'}]))
    const back = rasterise(spec([{op: 'box', from: [4, 4, 4], to: [1, 1, 1], color: '#ffffff'}]))

    expect([...back.data]).toEqual([...forward.data])
})

test('later ops paint over earlier ones, and erase carves', () => {
    const volume = rasterise(
        spec([
            {op: 'box', from: [0, 0, 0], to: [7, 7, 7], color: '#112233'},
            {op: 'box', from: [0, 0, 0], to: [0, 0, 0], color: '#445566'},
            {op: 'erase', from: [7, 7, 7], to: [7, 7, 7]}
        ])
    )

    expect(voxelAt(volume, 0, 0, 0)).toBe(2)
    expect(voxelAt(volume, 7, 7, 7)).toBe(0)
    expect(countFilled(volume)).toBe(8 * 8 * 8 - 1)
})

test('a ball is an axis-aligned ellipsoid, and a zero radius is still one voxel thick', () => {
    // Spans x 1…7, y 3…5, z 3…5, so the grid is 7 x 3 x 3 with origin [1, 3, 3].
    const ball = rasterise(spec([{op: 'ball', at: [4, 4, 4], r: [3, 1, 1], color: '#00ff00'}]))

    expect(voxelAt(ball, 0, 1, 1)).toBe(1)
    expect(voxelAt(ball, 3, 1, 2)).toBe(1)
    expect(voxelAt(ball, 3, 1, 3)).toBe(0)

    const flat = rasterise(spec([{op: 'ball', at: [4, 4, 4], r: [2, 0, 0], color: '#00ff00'}]))
    expect(countFilled(flat)).toBe(5)
})

test('mirror_x doubles the model about its own far edge', () => {
    // About the model's edge, not the declared centre: measured 2026-08-08, a half whose declared
    // plane was wrong got joined to itself in the wrong place, which is a seam or a hollow spine.
    const volume = rasterise(
        spec([{op: 'box', from: [0, 0, 0], to: [1, 0, 0], color: '#ffffff'}], {mirror_x: true})
    )

    expect(volume.sx).toBe(4)
    expect(voxelAt(volume, 0, 0, 0)).toBe(1)
    expect(voxelAt(volume, 3, 0, 0)).toBe(1)
    expect(countFilled(volume)).toBe(4)
})

test('one palette entry per distinct colour, in first-seen order', () => {
    const volume = rasterise(
        spec([
            {op: 'box', from: [0, 0, 0], to: [0, 0, 0], color: '#ABCDEF'},
            {op: 'box', from: [1, 0, 0], to: [1, 0, 0], color: '#000000'},
            {op: 'box', from: [2, 0, 0], to: [2, 0, 0], color: '#abcdef'}
        ])
    )

    expect(voxelAt(volume, 0, 0, 0)).toBe(1)
    expect(voxelAt(volume, 1, 0, 0)).toBe(2)
    // Case does not make a second entry — the model mixes them inside one reply.
    expect(voxelAt(volume, 2, 0, 0)).toBe(1)
    expect([...volume.palette.subarray(4, 8)]).toEqual([0xab, 0xcd, 0xef, 255])
})

test('a reply is narrowed, and a size the model invented is clamped', () => {
    const read = readSpec({
        name: 'tower',
        size: [64, 0, 12.7],
        mirror_x: true,
        ops: [
            {op: 'box', from: [0, 0, 0], to: [1, 1, 1], color: '#ffffff'},
            {op: 'box', from: [0, 0, 0], to: [1, 1, 1], color: 'red'},
            {op: 'wobble', from: [0, 0, 0]}
        ]
    })

    expect(read?.size).toEqual([MAX_SIZE, 1, 12])
    // The two unreadable ops are dropped; the good one is kept.
    expect(read?.ops).toHaveLength(1)
    expect(read?.mirror_x).toBe(true)
})

test('a reply with nothing usable in it is not a spec', () => {
    expect(readSpec(undefined)).toBeUndefined()
    expect(readSpec('a tower')).toBeUndefined()
    expect(readSpec({name: 'x', size: [8, 8, 8], mirror_x: false, ops: []})).toBeUndefined()
    expect(readSpec({name: 'x', size: [8, 8], mirror_x: false, ops: []})).toBeUndefined()
    expect(
        readSpec({name: 'x', size: [8, 8, 8], mirror_x: false, ops: [{op: 'box'}]})
    ).toBeUndefined()
})

test('an unnamed model still has a name', () => {
    const read = readSpec({
        size: [8, 8, 8],
        mirror_x: false,
        ops: [{op: 'erase', from: [0, 0, 0], to: [1, 1, 1]}]
    })

    expect(read?.name).toBe('Generated')
})

/*
 * The canvas — `gen/ask.ts`'s "Enforce canvas size". Off, the grid is fitted to the ops and every
 * test above holds. On, the grid is the cube and the ops are placed in it, and the placement is the
 * whole feature: an artist asked for room to keep drawing, not for a model floating in the middle
 * of a box.
 */

test('a canvas is the grid, whatever the ops painted', () => {
    const ops: VoxSpec['ops'] = [{op: 'box', from: [1, 0, 1], to: [6, 11, 6], color: '#ff0000'}]

    const canvas = rasterise(spec(ops), 32)
    expect([canvas.sx, canvas.sy, canvas.sz]).toEqual([32, 32, 32])
    // The same ops with the switch off are the 6 x 6 x 12 the model painted.
    const fitted = rasterise(spec(ops))
    expect([fitted.sx, fitted.sy, fitted.sz]).toEqual([6, 6, 12])
    expect(countFilled(canvas)).toBe(countFilled(fitted))
})

test('the content is centred across the canvas and stands on its floor', () => {
    // 6 wide, 12 tall, 6 deep, painted away from the origin so a placement that ignored the ops'
    // own low corner would land somewhere else.
    const canvas = rasterise(
        spec([{op: 'box', from: [1, 0, 1], to: [6, 11, 6], color: '#ff0000'}]),
        32
    )

    // (32 - 6) / 2 = 13, on both horizontal axes.
    expect(voxelAt(canvas, 13, 13, 0)).toBe(1)
    expect(voxelAt(canvas, 18, 18, 11)).toBe(1)
    expect(voxelAt(canvas, 12, 13, 0)).toBe(0)
    expect(voxelAt(canvas, 19, 18, 11)).toBe(0)
    // Feet on the floor rather than centred in z: the prompt has always said feet at y = 0, and a
    // model lifted into the middle of the box would hover over the ground lattice.
    expect(voxelAt(canvas, 13, 13, 12)).toBe(0)
})

test('a mirrored half is laid against the middle of the canvas, not centred on it', () => {
    // Centring the drawn half would put its reflection back on top of it.
    const canvas = rasterise(
        spec([{op: 'box', from: [0, 0, 0], to: [5, 3, 3], color: '#ff0000'}], {mirror_x: true}),
        32
    )

    // Twelve wide, hard against the middle from both sides: 10…15 drawn, 16…21 reflected.
    expect(voxelAt(canvas, 9, 14, 0)).toBe(0)
    expect(voxelAt(canvas, 10, 14, 0)).toBe(1)
    expect(voxelAt(canvas, 15, 14, 0)).toBe(1)
    expect(voxelAt(canvas, 16, 14, 0)).toBe(1)
    expect(voxelAt(canvas, 21, 14, 0)).toBe(1)
    expect(voxelAt(canvas, 22, 14, 0)).toBe(0)
    expect(countFilled(canvas)).toBe(6 * 2 * 4 * 4)
})

test('a model bigger than its canvas is clipped, and the canvas is still the canvas', () => {
    const canvas = rasterise(
        spec([{op: 'box', from: [0, 0, 0], to: [63, 63, 63], color: '#ff0000'}]),
        32
    )

    expect([canvas.sx, canvas.sy, canvas.sz]).toEqual([32, 32, 32])
    expect(countFilled(canvas)).toBe(32 * 32 * 32)
})

test('a canvas that nothing painted is still that canvas', () => {
    const empty = rasterise(spec([{op: 'erase', from: [0, 0, 0], to: [4, 4, 4]}]), 64)

    expect([empty.sx, empty.sy, empty.sz]).toEqual([64, 64, 64])
    expect(countFilled(empty)).toBe(0)
})
