import {expect, test} from 'bun:test'
import {createVolume, setVoxel, voxelIndex, type Volume} from '../render/volume'
import {readVox} from '../vox/vox-file'
import {specFromCode} from './code'
import {decompose, exampleCost, occupiedBounds, opsToCode} from './decompose'
import {countFilled, rasterise} from './ops'

const car = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

/**
 * Every cell as `#rrggbb` or `null`, which is what "the same model" means here.
 *
 * Not the raw indices: `rasterise` builds its own palette in first-seen order, so a faithful
 * rebuild has different numbers in `data` and identical colours on screen. Comparing the indices
 * would fail on a decomposition that is exactly right.
 */
const colours = (volume: Volume): (string | null)[] => {
    const out: (string | null)[] = []
    for (let z = 0; z < volume.sz; z += 1) {
        for (let y = 0; y < volume.sy; y += 1) {
            for (let x = 0; x < volume.sx; x += 1) {
                const value = volume.data[voxelIndex(volume, x, y, z)] ?? 0
                if (value === 0) {
                    out.push(null)
                    continue
                }
                const base = value * 4
                const part = (offset: number): string =>
                    ((volume.palette[base + offset] ?? 0) & 0xff).toString(16).padStart(2, '0')
                out.push(`#${part(0)}${part(1)}${part(2)}`)
            }
        }
    }
    return out
}

/** The volume trimmed to its filled cells, which is the grid a decomposition rebuilds into. */
const trimmed = (volume: Volume): Volume => {
    const bounds = occupiedBounds(volume)
    if (!bounds) return createVolume(1, 1, 1, volume.palette)
    const {lo, hi} = bounds
    const out = createVolume(
        hi[0] - lo[0] + 1,
        hi[1] - lo[1] + 1,
        hi[2] - lo[2] + 1,
        volume.palette
    )
    for (let z = lo[2]; z <= hi[2]; z += 1) {
        for (let y = lo[1]; y <= hi[1]; y += 1) {
            for (let x = lo[0]; x <= hi[0]; x += 1) {
                const value = volume.data[voxelIndex(volume, x, y, z)] ?? 0
                if (value !== 0) setVoxel(out, x - lo[0], y - lo[1], z - lo[2], value)
            }
        }
    }
    return out
}

/*
 * The round trip is an identity, not a permutation: `decompose` swaps into op space and `rasterise`
 * swaps back out of it. A test that expected the axes to come back rearranged would be asserting
 * that one of the two halves is wrong.
 */
test('car.vox decomposes losslessly', () => {
    const spec = decompose(car, 'car')
    const rebuilt = rasterise(spec)
    const original = trimmed(car)

    expect([rebuilt.sx, rebuilt.sy, rebuilt.sz]).toEqual([original.sx, original.sy, original.sz])
    expect(countFilled(rebuilt)).toBe(countFilled(original))
    expect(colours(rebuilt)).toEqual(colours(original))
})

test('the decomposition is boxes, and fewer of them than there are voxels', () => {
    const spec = decompose(car, 'car')
    expect(spec.ops.every(op => op.op === 'box')).toBe(true)
    expect(spec.ops.length).toBeGreaterThan(0)
    expect(spec.ops.length).toBeLessThan(countFilled(car))
})

test('an emitted box is uniform in colour and inside the model', () => {
    const spec = decompose(car, 'car')
    const [width, height, depth] = spec.size
    for (const op of spec.ops) {
        expect(op.op).toBe('box')
        if (op.op !== 'box') continue
        expect(op.from[0]).toBeGreaterThanOrEqual(0)
        expect(op.from[1]).toBeGreaterThanOrEqual(0)
        expect(op.from[2]).toBeGreaterThanOrEqual(0)
        expect(op.to[0]).toBeLessThan(width)
        expect(op.to[1]).toBeLessThan(height)
        expect(op.to[2]).toBeLessThan(depth)
        expect(op.color).toMatch(/^#[0-9a-f]{6}$/)
    }
})

test('op space is y-up: a tall pillar comes back tall in op y', () => {
    // One column, four cells high along the volume's z, which is the axis the app draws as up.
    const volume = createVolume(1, 1, 4)
    volume.palette.set([200, 30, 30, 255], 4)
    for (let z = 0; z < 4; z += 1) setVoxel(volume, 0, 0, z, 1)

    const spec = decompose(volume, 'pillar')
    expect(spec.size).toEqual([1, 4, 1])
    expect(spec.ops).toEqual([{op: 'box', from: [0, 0, 0], to: [0, 3, 0], color: '#c81e1e'}])
})

test('two colours stay two colours, and neither box crosses the seam', () => {
    const volume = createVolume(2, 1, 1)
    volume.palette.set([255, 0, 0, 255], 4)
    volume.palette.set([0, 0, 255, 255], 8)
    setVoxel(volume, 0, 0, 0, 1)
    setVoxel(volume, 1, 0, 0, 2)

    const spec = decompose(volume, 'pair')
    expect(spec.ops.length).toBe(2)
    expect(colours(rasterise(spec))).toEqual(['#ff0000', '#0000ff'])
})

test('an empty volume decomposes to no ops rather than to a guess', () => {
    const spec = decompose(createVolume(4, 4, 4), 'nothing')
    expect(spec.ops).toEqual([])
})

test('the emitted code rebuilds the model it was decomposed from', () => {
    const spec = decompose(car, 'car')
    const code = opsToCode(spec, 'car: a test fixture')
    const reread = specFromCode(code, 'car')
    expect(reread).toBeDefined()
    if (!reread) return

    const rebuilt = rasterise(reread)
    const direct = rasterise(spec)
    expect([rebuilt.sx, rebuilt.sy, rebuilt.sz]).toEqual([direct.sx, direct.sy, direct.sz])
    expect(colours(rebuilt)).toEqual(colours(direct))
})

test('the emitted code declares each colour once and names it', () => {
    const spec = decompose(car, 'car')
    const code = opsToCode(spec, 'car')
    const {colours: count, lines} = exampleCost(spec)

    expect(code.startsWith('// car\n')).toBe(true)
    expect(code.split('\n').filter(line => line.startsWith('const ')).length).toBeGreaterThan(0)
    for (let index = 1; index <= count; index += 1) {
        expect(code).toContain(`c${String(index)} = '#`)
    }
    // Every hex literal lives in a declaration, so a box line never repeats a colour.
    expect(
        code.split('\n').filter(line => line.startsWith('box(') && line.includes('#')).length
    ).toBe(0)
    expect(lines).toBe(code.split('\n').length)
})
