import {expect, test} from 'bun:test'
import {countVoxels} from '../vox/vox-file'
import {freshenPalette, projectPalette} from './palette'
import {clampAxis, MAX_AXIS, newDocument, TEMPLATES, templateNamed} from './templates'

test('every template is a whole grid this renderer can hold', () => {
    expect(TEMPLATES.length).toBeGreaterThan(0)
    for (const {name, size} of TEMPLATES) {
        expect(name).not.toBe('')
        for (const axis of size) {
            expect(Number.isInteger(axis)).toBe(true)
            expect(axis).toBeGreaterThan(0)
            expect(axis).toBeLessThanOrEqual(MAX_AXIS)
        }
    }
})

test('a new document is empty, owns nothing, and has something to paint with', () => {
    const {volume, objects} = newDocument([32, 32, 48])

    expect([volume.sx, volume.sy, volume.sz]).toEqual([32, 32, 48])
    expect(countVoxels(volume)).toBe(0)
    expect(volume.owner.some(id => id !== 0)).toBe(false)
    expect(objects.list).toHaveLength(1)
    expect(objects.active).toBe(1)
    // A new grid carries MagicaVoxel's ramp, which is entirely filler — so on its own it offers
    // the artist nothing to click. What makes it paintable is `freshenPalette`, which lays DB32
    // over exactly that filler, and which every document goes through in `initialState`.
    expect(projectPalette(volume).length).toBe(0)
    const freshened = projectPalette({...volume, palette: freshenPalette(volume)})
    expect(freshened.length).toBeGreaterThan(8)
    expect(freshened.every(({isUsed}) => !isUsed)).toBe(true)
})

test('an axis is clamped to a whole number inside the ceiling', () => {
    expect(clampAxis(0)).toBe(1)
    expect(clampAxis(-4)).toBe(1)
    expect(clampAxis(31.6)).toBe(32)
    expect(clampAxis(MAX_AXIS + 100)).toBe(MAX_AXIS)
    expect(clampAxis(Number.NaN)).toBe(1)
    expect(newDocument([0, 999, 8]).volume.sx).toBe(1)
    expect(newDocument([0, 999, 8]).volume.sy).toBe(MAX_AXIS)
})

test('a template nobody named falls back rather than returning nothing', () => {
    expect(templateNamed('Prop').size).toEqual([32, 32, 32])
    expect(templateNamed('no such template').name).toBe('Prop')
})
