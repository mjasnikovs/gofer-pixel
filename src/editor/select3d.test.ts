import {describe, expect, test} from 'bun:test'
import {Volume} from '../doc/volume'
import {EMPTY} from '../vox/palette'
import {replaceColor} from '../doc/tools'
import {applyVoxels, type Brush3D} from './brush3d'
import {
    boxFromDrag,
    boxOf,
    pickColor,
    removeColor,
    selectBox,
    selectRegion,
    voxelsOfColor
} from './select3d'

const size = {sx: 8, sy: 8, sz: 8}

const brush = (patch: Partial<Brush3D> = {}): Brush3D => ({
    shape: 'voxel',
    mode: 'paint',
    color: 3,
    ...patch
})

const scene = () => {
    const volume = new Volume()
    // a 2x2x2 block of colour 5 and, apart from it, a single voxel of colour 7
    for (let x = 0; x < 2; x += 1) {
        for (let y = 0; y < 2; y += 1) {
            for (let z = 0; z < 2; z += 1) {
                volume.set(x, y, z, 5)
            }
        }
    }
    volume.set(5, 5, 0, 7)
    return volume
}

describe('box select', () => {
    test('takes the occupied voxels inside it and no empty space', () => {
        const picked = selectBox(scene(), boxOf([0, 0, 0], [7, 7, 7]))
        expect(picked.length).toBe(9)
    })

    test('a box is order-independent', () => {
        expect(boxOf([3, 1, 2], [0, 4, 0])).toEqual({x0: 0, y0: 1, z0: 0, x1: 3, y1: 4, z1: 2})
    })

    test('dragging in a view produces the box between the two picks', () => {
        const volume = scene()
        const box = boxFromDrag(volume, 'top', [0, 7], [1, 6], size, brush())
        expect(box).toEqual({x0: 0, y0: 0, z0: 1, x1: 1, y1: 1, z1: 1})
    })

    test('a drag that starts on empty space selects nothing', () => {
        expect(boxFromDrag(scene(), 'top', [7, 0], [7, 1], size, brush())).toBeNull()
    })
})

describe('region select', () => {
    test('takes the connected block and leaves the separate voxel alone', () => {
        expect(selectRegion(scene(), [0, 0, 0], size).length).toBe(8)
    })

    test('stops at a colour change', () => {
        const volume = scene()
        volume.set(1, 1, 1, 9)
        expect(selectRegion(volume, [0, 0, 0], size).length).toBe(7)
    })

    test('two blocks touching only at a corner are two regions', () => {
        const volume = new Volume()
        volume.set(0, 0, 0, 4)
        volume.set(1, 1, 1, 4)
        expect(selectRegion(volume, [0, 0, 0], size)).toEqual([[0, 0, 0]])
    })

    test('empty space is not a region', () => {
        expect(selectRegion(new Volume(), [0, 0, 0], size)).toEqual([])
    })
})

describe('colour operations', () => {
    test('pick colour reads the surface under the cursor', () => {
        expect(pickColor(scene(), 'top', 0, 7, size, brush())).toBe(5)
        expect(pickColor(scene(), 'top', 5, 2, size, brush())).toBe(7)
        expect(pickColor(scene(), 'top', 7, 0, size, brush())).toBeNull()
    })

    test('remove colour deletes exactly that colour', () => {
        const volume = scene()
        expect(removeColor(volume, 5)).toBe(8)
        expect(volume.get(0, 0, 0)).toBe(EMPTY)
        expect(volume.get(5, 5, 0)).toBe(7)
    })

    test('replace colour keeps the geometry', () => {
        const volume = scene()
        expect(replaceColor(volume, 5, 2)).toBe(8)
        expect(voxelsOfColor(volume, 2).length).toBe(8)
        expect(voxelsOfColor(volume, 5).length).toBe(0)
    })

    test('a selection can be handed straight to a brush', () => {
        const volume = scene()
        const region = selectRegion(volume, [0, 0, 0], size)
        expect(applyVoxels(volume, size, brush({mode: 'erase'}), region)).toBe(8)
        expect(volume.get(1, 1, 1)).toBe(EMPTY)
        expect(volume.get(5, 5, 0)).toBe(7)
    })
})
