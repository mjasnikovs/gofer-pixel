import {expect, test} from 'bun:test'
import {voxelAt} from '../render/volume'
import {countFilled, MAX_SIZE, rasterise, readSpec, VOX_SCHEMA, type VoxSpec} from './ops'

const spec = (ops: VoxSpec['ops'], over: Partial<VoxSpec> = {}): VoxSpec => ({
    name: 'test',
    size: [8, 8, 8],
    mirror_x: false,
    ops,
    ...over
})

test('a box fills its inclusive bounds and nothing else', () => {
    const volume = rasterise(spec([{op: 'box', from: [1, 1, 1], to: [2, 3, 4], color: '#ff0000'}]))

    expect(countFilled(volume)).toBe(2 * 3 * 4)
    expect(voxelAt(volume, 1, 1, 1)).toBe(1)
    expect(voxelAt(volume, 2, 3, 4)).toBe(1)
    expect(voxelAt(volume, 0, 1, 1)).toBe(0)
    expect(voxelAt(volume, 3, 1, 1)).toBe(0)
    expect([...volume.palette.subarray(4, 8)]).toEqual([255, 0, 0, 255])
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
    const ball = rasterise(spec([{op: 'ball', at: [4, 4, 4], r: [3, 1, 1], color: '#00ff00'}]))

    expect(voxelAt(ball, 1, 4, 4)).toBe(1)
    expect(voxelAt(ball, 4, 5, 4)).toBe(1)
    expect(voxelAt(ball, 4, 6, 4)).toBe(0)

    const flat = rasterise(spec([{op: 'ball', at: [4, 4, 4], r: [2, 0, 0], color: '#00ff00'}]))
    expect(countFilled(flat)).toBe(5)
})

test('a write off the grid is dropped, not clamped onto the wall', () => {
    const volume = rasterise(
        spec([{op: 'box', from: [-4, -4, -4], to: [1, 1, 1], color: '#ffffff'}])
    )

    // A clamp would have smeared 6 x 6 x 6 of a mistyped coordinate across three faces.
    expect(countFilled(volume)).toBe(2 * 2 * 2)
})

test('mirror_x reflects the finished model rather than itself', () => {
    const volume = rasterise(
        spec([{op: 'box', from: [0, 0, 0], to: [1, 0, 0], color: '#ffffff'}], {mirror_x: true})
    )

    expect(voxelAt(volume, 0, 0, 0)).toBe(1)
    expect(voxelAt(volume, 7, 0, 0)).toBe(1)
    expect(voxelAt(volume, 6, 0, 0)).toBe(1)
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

test('the schema the server is asked to enforce matches the ops that can be read', () => {
    // The grammar is the only thing standing between a 27B model and a parser, so the two lists
    // have to be the same list.
    const {anyOf} = VOX_SCHEMA.properties.ops.items
    expect(anyOf.map(entry => entry.properties.op.const)).toEqual(['box', 'ball', 'erase'])
    expect(VOX_SCHEMA.properties.ops.maxItems).toBe(40)
})
