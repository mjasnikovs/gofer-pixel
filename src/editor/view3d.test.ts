import {describe, expect, test} from 'bun:test'
import {createDocument, editCel, flattenFrame, type Document} from '../doc/document'
import {PALETTE} from '../vox/palette'
import {pickAttach, pickSurface, rayFor, renderOrtho, toCell, viewSize} from './view3d'

const size = {sx: 8, sy: 6, sz: 4}

const doc = (draw: (set: (x: number, y: number, z: number, c: number) => void) => void): Document =>
    editCel(createDocument({size, palette: PALETTE}), 0, 0, volume => {
        draw((x, y, z, c) => {
            volume.set(x, y, z, c)
        })
    })

describe('view geometry', () => {
    test('each view shows the two axes it is named for', () => {
        expect(viewSize('top', size)).toEqual({width: 8, height: 6})
        expect(viewSize('front', size)).toEqual({width: 8, height: 4})
        expect(viewSize('side', size)).toEqual({width: 6, height: 4})
    })

    test('a ray covers the depth axis exactly once, nearest first', () => {
        const top = rayFor('top', 3, 0, size)
        expect(top.length).toBe(4)
        expect(top[0]).toEqual([3, 5, 3]) // top of the volume, far edge of y at screen row 0
        expect(top[3]).toEqual([3, 5, 0])

        const front = rayFor('front', 3, 0, size)
        expect(front[0]).toEqual([3, 0, 3]) // nearest y, top z
        expect(front[5]).toEqual([3, 5, 3])
    })

    test('screen rows run down while z and y run up', () => {
        expect(rayFor('front', 0, 3, size)[0]).toEqual([0, 0, 0])
        expect(rayFor('top', 0, 5, size)[0]).toEqual([0, 0, 3])
    })

    test('a click maps to the cell under it and clamps at the edges', () => {
        const rect = {left: 0, top: 0, width: 80, height: 60}
        expect(toCell(5, 5, rect, 'top', size)).toEqual([0, 0])
        expect(toCell(75, 55, rect, 'top', size)).toEqual([7, 5])
        expect(toCell(-40, 900, rect, 'top', size)).toEqual([0, 5])
    })
})

describe('picking', () => {
    const tower = doc(set => {
        for (let z = 0; z < 3; z += 1) {
            set(2, 2, z, 5)
        }
    })

    test('the surface pick returns the nearest voxel, not the first in memory order', () => {
        const volume = flattenFrame(tower, 0)
        // from the top, the nearest of the three is z=2
        expect(pickSurface(volume, 'top', 2, 6 - 1 - 2, size)).toEqual([2, 2, 2])
        // from the front the whole column is at y=2, so the nearest is that same voxel
        expect(pickSurface(volume, 'front', 2, 4 - 1 - 1, size)).toEqual([2, 2, 1])
    })

    test('a ray through empty space picks nothing', () => {
        expect(pickSurface(flattenFrame(tower, 0), 'top', 7, 0, size)).toBeNull()
    })

    test('attach lands in front of the surface', () => {
        const volume = flattenFrame(tower, 0)
        expect(pickAttach(volume, 'top', 2, 6 - 1 - 2, size)).toEqual([2, 2, 3])
    })

    test('attach on empty space lands on the far wall rather than doing nothing', () => {
        expect(pickAttach(flattenFrame(tower, 0), 'top', 7, 0, size)).toEqual([7, 5, 0])
    })

    test('slice lock keeps every pick on its slice', () => {
        const volume = flattenFrame(tower, 0)
        expect(pickSurface(volume, 'top', 2, 6 - 1 - 2, size, {lockZ: 0})).toEqual([2, 2, 0])
        expect(pickAttach(volume, 'top', 5, 0, size, {lockZ: 2})).toEqual([5, 5, 2])
    })
})

describe('renderOrtho', () => {
    const cube = doc(set => {
        for (let z = 0; z < 2; z += 1) {
            for (let y = 0; y < 2; y += 1) {
                for (let x = 0; x < 2; x += 1) {
                    set(x, y, z, 4)
                }
            }
        }
    })

    const pixel = (image: {width: number; data: Uint8Array}, h: number, v: number): number[] => [
        ...image.data.subarray((v * image.width + h) * 4, (v * image.width + h) * 4 + 4)
    ]

    test('the silhouette lands where the volume is, and nowhere else', () => {
        const image = renderOrtho(cube, 0, 'top', {shade: false})
        expect(pixel(image, 0, 5)[3]).toBe(255) // y=0 is the bottom screen row
        expect(pixel(image, 0, 0)[3]).toBe(0) // y=5 is empty
        expect(pixel(image, 7, 5)[3]).toBe(0) // x=7 is empty
    })

    test('shading darkens with distance and leaves the nearest voxel alone', () => {
        const stack = doc(set => {
            set(0, 0, 3, 4)
            set(1, 0, 0, 4)
        })
        const image = renderOrtho(stack, 0, 'top')
        const near = pixel(image, 0, 5)
        const far = pixel(image, 1, 5)
        expect(near[0]).toBeGreaterThan(far[0] ?? 0)
        expect(far[3]).toBe(255) // distance changes the colour, not the coverage
    })

    test('slice lock fades everything off the locked slice', () => {
        const image = renderOrtho(cube, 0, 'front', {shade: false, lockZ: 0})
        const onSlice = pixel(image, 0, 3)
        const offSlice = pixel(image, 0, 2)
        expect(onSlice[3]).toBe(255)
        expect(offSlice[3]).toBeLessThan(255)
        expect(offSlice[3]).toBeGreaterThan(0)
    })
})
