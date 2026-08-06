import {describe, expect, test} from 'bun:test'
import {Volume} from '../doc/volume'
import {EMPTY} from '../vox/palette'
import {applyAxisLock, applyBrush3d, brushVoxels, faceRegion, line3d, type Brush3D} from './brush3d'

const size = {sx: 8, sy: 8, sz: 8}

const filled = (draw: (set: (x: number, y: number, z: number, c: number) => void) => void) => {
    const volume = new Volume()
    draw((x, y, z, c) => {
        volume.set(x, y, z, c)
    })
    return volume
}

const brush = (patch: Partial<Brush3D> = {}): Brush3D => ({
    shape: 'voxel',
    mode: 'attach',
    color: 3,
    ...patch
})

const cell = (h: number, v: number): [number, number] => [h, v]

describe('line3d', () => {
    test('a straight run has one voxel per step', () => {
        expect(line3d([0, 0, 0], [3, 0, 0])).toEqual([
            [0, 0, 0],
            [1, 0, 0],
            [2, 0, 0],
            [3, 0, 0]
        ])
    })

    test('a diagonal is gap-free and ends where it was asked to', () => {
        const path = line3d([0, 0, 0], [4, 2, 7])
        expect(path[0]).toEqual([0, 0, 0])
        expect(path[path.length - 1]).toEqual([4, 2, 7])
        for (let i = 1; i < path.length; i += 1) {
            const a = path[i - 1] ?? [0, 0, 0]
            const b = path[i] ?? [0, 0, 0]
            expect(
                Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2]))
            ).toBe(1)
        }
    })

    test('a zero-length line is one voxel, not none', () => {
        expect(line3d([2, 2, 2], [2, 2, 2])).toEqual([[2, 2, 2]])
    })
})

describe('modes', () => {
    const floor = () =>
        filled(set => {
            for (let x = 0; x < 4; x += 1) {
                set(x, 0, 0, 5)
            }
        })

    test('attach builds on top of what is there, seen from above', () => {
        const volume = floor()
        const changed = applyBrush3d(volume, size, brush(), {
            view: 'top',
            from: cell(1, 7),
            to: cell(1, 7)
        })
        expect(changed).toBe(1)
        expect(volume.get(1, 0, 1)).toBe(3)
        expect(volume.get(1, 0, 0)).toBe(5)
    })

    test('erase takes the surface voxel', () => {
        const volume = floor()
        applyBrush3d(volume, size, brush({mode: 'erase'}), {
            view: 'top',
            from: cell(1, 7),
            to: cell(1, 7)
        })
        expect(volume.get(1, 0, 0)).toBe(EMPTY)
    })

    test('paint recolours what exists and never creates', () => {
        const volume = floor()
        applyBrush3d(volume, size, brush({mode: 'paint', color: 9}), {
            view: 'top',
            from: cell(1, 7),
            to: cell(1, 7)
        })
        expect(volume.get(1, 0, 0)).toBe(9)

        const empty = new Volume()
        expect(
            applyBrush3d(empty, size, brush({mode: 'paint', color: 9}), {
                view: 'top',
                from: cell(1, 7),
                to: cell(1, 7)
            })
        ).toBe(0)
    })
})

describe('shapes', () => {
    test('box fills between the two ends', () => {
        const volume = new Volume()
        applyBrush3d(volume, size, brush({shape: 'box'}), {
            view: 'front',
            from: cell(1, 7),
            to: cell(3, 5)
        })
        // front view: h = x, v = z counted down, depth y — an empty volume attaches at the far wall
        expect(volume.get(1, 7, 0)).toBe(3)
        expect(volume.get(3, 7, 2)).toBe(3)
        expect(volume.get(2, 7, 1)).toBe(3)
        expect(volume.get(4, 7, 0)).toBe(EMPTY)
    })

    test('centre grows a ball whose radius is the drag length', () => {
        const volume = new Volume()
        applyBrush3d(volume, size, brush({shape: 'centre'}), {
            view: 'front',
            from: cell(4, 4),
            to: cell(6, 4)
        })
        expect(volume.get(4, 7, 3)).toBe(3)
        expect(volume.get(6, 7, 3)).toBe(3)
        expect(volume.get(4, 7, 5)).toBe(3)
        expect(volume.get(7, 7, 3)).toBe(EMPTY)
    })

    test('face takes the connected same-coloured run and stops at a colour change', () => {
        const volume = filled(set => {
            for (let x = 0; x < 5; x += 1) {
                set(x, 0, 0, x === 3 ? 6 : 5)
            }
        })
        const region = faceRegion(volume, 'top', 0, 7, size)
        expect(region.map(v => v[0]).sort((a, b) => a - b)).toEqual([0, 1, 2])
    })

    test('face on empty space names nothing', () => {
        expect(faceRegion(new Volume(), 'top', 0, 0, size)).toEqual([])
    })
})

describe('constraints', () => {
    test('mirror x writes both sides in one gesture', () => {
        const volume = new Volume()
        applyBrush3d(volume, size, brush({mirrorX: true}), {
            view: 'top',
            from: cell(1, 7),
            to: cell(1, 7)
        })
        expect(volume.get(1, 0, 0)).toBe(3)
        expect(volume.get(6, 0, 0)).toBe(3)
    })

    test('slice lock keeps a box on one z', () => {
        const volume = new Volume()
        applyBrush3d(volume, size, brush({shape: 'box', lockZ: 2}), {
            view: 'top',
            from: cell(1, 7),
            to: cell(3, 5)
        })
        let offSlice = 0
        volume.forEach((_x, _y, z) => {
            if (z !== 2) {
                offSlice += 1
            }
        })
        expect(offSlice).toBe(0)
        expect(volume.get(2, 1, 2)).toBe(3)
    })

    /**
     * A side effect of slice lock that is easy to be surprised by: in a front or side view the
     * locked slice is a single row of the screen, so everywhere else the brush correctly does
     * nothing. Pinned so it reads as intended rather than as a dead viewport.
     */
    test('in a front view, slice lock leaves only the locked row editable', () => {
        const volume = new Volume()
        const off = applyBrush3d(volume, size, brush({lockZ: 2}), {
            view: 'front',
            from: cell(1, 7),
            to: cell(1, 7)
        })
        expect(off).toBe(0)

        const on = applyBrush3d(volume, size, brush({lockZ: 2}), {
            view: 'front',
            from: cell(1, size.sz - 1 - 2),
            to: cell(1, size.sz - 1 - 2)
        })
        expect(on).toBe(1)
        expect(volume.get(1, 7, 2)).toBe(3)
    })

    test('axis lock flattens a drag onto one axis', () => {
        expect(applyAxisLock([1, 2, 3], [5, 6, 7], 'x')).toEqual([5, 2, 3])
        expect(applyAxisLock([1, 2, 3], [5, 6, 7], 'z')).toEqual([1, 2, 7])
        expect(applyAxisLock([1, 2, 3], [5, 6, 7], null)).toEqual([5, 6, 7])
    })

    test('the preview list is exactly what the commit writes', () => {
        const volume = filled(set => {
            set(2, 2, 0, 5)
        })
        const gesture = {view: 'top' as const, from: cell(2, 5), to: cell(4, 5)}
        const previewed = brushVoxels(volume, size, brush({shape: 'line'}), gesture)
        const changed = applyBrush3d(volume, size, brush({shape: 'line'}), gesture)
        expect(changed).toBe(previewed.length)
    })
})
