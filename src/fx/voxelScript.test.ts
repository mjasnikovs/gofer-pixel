import {describe, expect, test} from 'bun:test'
import {Volume} from '../doc/volume'
import {EMPTY} from '../vox/palette'
import {SCRIPT_PRESETS, runVoxelScript} from './voxelScript'

const size = {sx: 8, sy: 8, sz: 8}

const solid = (color = 4): Volume => {
    const volume = new Volume()
    volume.fillBox({x0: 0, y0: 0, z0: 0, x1: 7, y1: 7, z1: 7}, color)
    return volume
}

const count = (volume: Volume): number => {
    let n = 0
    volume.forEach(() => {
        n += 1
    })
    return n
}

describe('runVoxelScript', () => {
    test('writes the expression result as a palette index', () => {
        const volume = new Volume()
        const result = runVoxelScript(volume, size, 'z < 2 ? 3 : 0')
        expect(result.visited).toBe(512)
        expect(volume.get(0, 0, 0)).toBe(3)
        expect(volume.get(0, 0, 2)).toBe(EMPTY)
        expect(count(volume)).toBe(128)
        expect(result.changed).toBe(128)
    })

    test('a box confines it, and coordinates stay global', () => {
        const volume = new Volume()
        runVoxelScript(volume, size, '7', {box: {x0: 2, y0: 2, z0: 2, x1: 3, y1: 3, z1: 3}})
        expect(volume.get(2, 2, 2)).toBe(7)
        expect(volume.get(1, 2, 2)).toBe(EMPTY)
        expect(count(volume)).toBe(8)
    })

    test('add only fills empty space; paint only touches what exists', () => {
        const volume = new Volume()
        volume.set(0, 0, 0, 9)
        runVoxelScript(volume, size, '2', {
            mode: 'add',
            box: {x0: 0, y0: 0, z0: 0, x1: 1, y1: 0, z1: 0}
        })
        expect(volume.get(0, 0, 0)).toBe(9)
        expect(volume.get(1, 0, 0)).toBe(2)

        const painted = new Volume()
        painted.set(0, 0, 0, 9)
        runVoxelScript(painted, size, '5', {mode: 'paint'})
        expect(painted.get(0, 0, 0)).toBe(5)
        expect(count(painted)).toBe(1)
    })

    test('a script can carve, and sees the voxel it is replacing as v', () => {
        const volume = solid()
        runVoxelScript(volume, size, 'x == y ? 0 : v')
        expect(volume.get(3, 3, 0)).toBe(EMPTY)
        expect(volume.get(3, 4, 0)).toBe(4)
    })

    test('out-of-range results are clamped into palette space', () => {
        const volume = new Volume()
        runVoxelScript(volume, size, '-5', {box: {x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0}})
        expect(volume.get(0, 0, 0)).toBe(0)
        runVoxelScript(volume, size, '9999', {box: {x0: 1, y0: 0, z0: 0, x1: 1, y1: 0, z1: 0}})
        expect(volume.get(1, 0, 0)).toBe(255)
    })

    test('t is available, so one script can drive several frames', () => {
        const a = new Volume()
        const b = new Volume()
        runVoxelScript(a, size, 'z < t ? 1 : 0', {t: 2})
        runVoxelScript(b, size, 'z < t ? 1 : 0', {t: 5})
        expect(count(b)).toBeGreaterThan(count(a))
    })

    test('a bad script throws before it touches anything', () => {
        const volume = solid()
        const before = count(volume)
        expect(() => runVoxelScript(volume, size, '2 +')).toThrow()
        expect(count(volume)).toBe(before)
    })
})

describe('presets', () => {
    test.each(SCRIPT_PRESETS.map(preset => [preset.name, preset] as const))(
        '%s runs and changes something',
        (_name, preset) => {
            // half solid, half empty: `add` presets need somewhere to go and `paint` ones need
            // something to work on
            const volume = new Volume()
            volume.fillBox({x0: 0, y0: 0, z0: 0, x1: 7, y1: 3, z1: 7}, 4)
            const result = runVoxelScript(volume, size, preset.source, {mode: preset.mode})
            expect(result.visited).toBeGreaterThan(0)
            expect(result.changed).toBeGreaterThan(0)
        }
    )

    test('hollow leaves a shell', () => {
        const volume = solid()
        const hollow = SCRIPT_PRESETS.find(preset => preset.name === 'hollow')
        runVoxelScript(volume, size, hollow?.source ?? '', {mode: hollow?.mode ?? 'set'})
        expect(volume.get(0, 0, 0)).toBe(4)
        expect(volume.get(4, 4, 4)).toBe(EMPTY)
        expect(count(volume)).toBe(512 - 6 * 6 * 6)
    })

    test('stairs climb', () => {
        const volume = new Volume()
        const stairs = SCRIPT_PRESETS.find(preset => preset.name === 'stairs')
        runVoxelScript(volume, size, stairs?.source ?? '')
        expect(volume.get(0, 0, 0)).toBe(4)
        expect(volume.get(0, 0, 1)).toBe(EMPTY)
        expect(volume.get(6, 0, 3)).toBe(4)
    })
})
