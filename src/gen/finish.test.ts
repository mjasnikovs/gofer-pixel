import {expect, test} from 'bun:test'
import {finish, SHADE_LIT} from './finish'
import {specFromCode} from './code'
import {countFilled, rasterise} from './ops'
import {voxelAt, type Volume} from '../render/volume'

const column = (): Volume => {
    const spec = specFromCode("box(0,0,0, 2,4,2, '#804020')", 'column')
    if (!spec) throw new Error('the column did not build')
    return rasterise(spec)
}

test('shading recolours every voxel and moves none', () => {
    const before = column()
    const after = finish(before)
    expect(countFilled(after)).toBe(countFilled(before))
    expect([after.sx, after.sy, after.sz]).toEqual([before.sx, before.sy, before.sz])
    for (let i = 0; i < before.data.length; i += 1) {
        expect((after.data[i] ?? 0) === 0).toBe((before.data[i] ?? 0) === 0)
    }
})

test('an exposed top face is lit brighter than the base colour', () => {
    const volume = column()
    const shaded = finish(volume)
    // Height is z in a Volume. The column's top layer is open above, so it takes the lit tone.
    const top = voxelAt(shaded, 1, 1, shaded.sz - 1)
    const red = shaded.palette[top * 4] ?? 0
    expect(red).toBe(Math.round(0x80 * SHADE_LIT))
})

test('the finish is deterministic, because a record must reproduce its asset', () => {
    const once = finish(column())
    const twice = finish(column())
    expect([...once.data]).toEqual([...twice.data])
    expect([...once.palette]).toEqual([...twice.palette])
})

test('emissive follows the colour into its variants', () => {
    const volume = column()
    volume.emissive[1] = 200
    const shaded = finish(volume)
    for (const value of shaded.data) {
        if (value !== 0) expect(shaded.emissive[value]).toBe(200)
    }
})
