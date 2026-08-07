import {describe, expect, test} from 'bun:test'
import {CHUNK_SIZE, MAX_COORD, Volume, uniqueChunkBytes} from './volume'
import {Vox} from '../vox/grid'

const filled = (volume: Volume): [number, number, number, number][] => {
    const out: [number, number, number, number][] = []
    volume.forEach((x, y, z, color) => out.push([x, y, z, color]))
    return out
}

describe('Volume storage', () => {
    test('reads back what it writes, and empty everywhere else', () => {
        const volume = new Volume()
        volume.set(0, 0, 0, 5)
        volume.set(31, 17, 9, 200)

        expect(volume.get(0, 0, 0)).toBe(5)
        expect(volume.get(31, 17, 9)).toBe(200)
        expect(volume.get(1, 0, 0)).toBe(0)
        expect(volume.count).toBe(2)
    })

    test('out-of-range coordinates are ignored, not wrapped onto real voxels', () => {
        const volume = new Volume()
        expect(volume.set(-1, 0, 0, 7)).toBe(false)
        expect(volume.set(0, MAX_COORD, 0, 7)).toBe(false)
        expect(volume.get(-1, 0, 0)).toBe(0)
        expect(volume.count).toBe(0)
    })

    test('clearing a voxel drops the chunk once it holds nothing', () => {
        const volume = new Volume()
        volume.set(4, 4, 4, 3)
        expect(volume.chunkCount).toBe(1)

        volume.set(4, 4, 4, 0)
        expect(volume.count).toBe(0)
        expect(volume.chunkCount).toBe(0)
        expect(volume.isEmpty).toBe(true)
    })

    test('set reports whether the cell actually changed', () => {
        const volume = new Volume()
        expect(volume.set(1, 2, 3, 9)).toBe(true)
        expect(volume.set(1, 2, 3, 9)).toBe(false)
        expect(volume.set(1, 2, 3, 0)).toBe(true)
        expect(volume.set(1, 2, 3, 0)).toBe(false)
    })

    test('bounds is tight, and null when empty', () => {
        const volume = new Volume()
        expect(volume.bounds()).toBeNull()

        volume.set(3, 9, 1, 1)
        volume.set(20, 2, 15, 1)
        expect(volume.bounds()).toEqual({x0: 3, y0: 2, z0: 1, x1: 20, y1: 9, z1: 15})
    })

    test('forEach walks z ascending — the renderer paints in this order', () => {
        const volume = new Volume()
        // written top-down and across chunk boundaries, so insertion order is not z order
        volume.set(1, 1, 20, 1)
        volume.set(9, 9, 4, 2)
        volume.set(0, 0, 12, 3)

        expect(filled(volume).map(([, , z]) => z)).toEqual([4, 12, 20])
    })

    test('is deterministic — same edits, same iteration order', () => {
        const build = (order: number[]): string => {
            const volume = new Volume()
            for (const i of order) {
                // distinct coordinate per i, so only the write order differs between the two runs
                volume.set(i % 10, Math.floor(i / 10) % 10, Math.floor(i / 100), (i % 250) + 1)
            }
            return JSON.stringify(filled(volume))
        }
        const forwards = [...Array(200).keys()]
        expect(build(forwards)).toBe(build([...forwards].reverse()))
    })

    test('fillBox paints an inclusive box', () => {
        const volume = new Volume()
        const painted = volume.fillBox({x0: 2, y0: 2, z0: 2, x1: 4, y1: 4, z1: 4}, 6)

        expect(painted).toBe(27)
        expect(volume.count).toBe(27)
        expect(volume.get(2, 2, 2)).toBe(6)
        expect(volume.get(4, 4, 4)).toBe(6)
        expect(volume.get(5, 4, 4)).toBe(0)
    })

    test('round-trips through the dense grid the generator uses', () => {
        const vox = new Vox({sx: 16, sy: 16, sz: 16})
        vox.ellipsoid(8, 8, 8, 5, 4, 3, 7)

        const volume = Volume.fromVox(vox)
        expect(volume.count).toBe(vox.filled)
        expect(volume.toVox({sx: 16, sy: 16, sz: 16}).cells).toEqual(vox.cells)
    })
})

describe('copy-on-write', () => {
    test('a write to a clone leaves the original alone, and vice versa', () => {
        const original = new Volume()
        original.fillBox({x0: 0, y0: 0, z0: 0, x1: 15, y1: 15, z1: 15}, 4)

        const copy = original.clone()
        copy.set(0, 0, 0, 9)
        original.set(15, 15, 15, 1)

        expect(original.get(0, 0, 0)).toBe(4)
        expect(copy.get(0, 0, 0)).toBe(9)
        expect(copy.get(15, 15, 15)).toBe(4)
        expect(original.get(15, 15, 15)).toBe(1)
    })

    test('a clone with no writes shares every byte', () => {
        const original = new Volume()
        original.fillBox({x0: 0, y0: 0, z0: 0, x1: 31, y1: 31, z1: 31}, 4)
        const copy = original.clone()

        expect(uniqueChunkBytes([original])).toBe(uniqueChunkBytes([original, copy]))
    })

    /**
     * The §14 question — 16³ chunks come from Goxel, which handles unlimited scenes, and may be
     * too coarse for a 32³ sprite to share anything. Measured here rather than argued: a
     * one-voxel edit to a full 32³ model must copy well under a tenth of it.
     */
    test('a one-voxel edit copies one chunk, not the model', () => {
        const original = new Volume()
        original.fillBox({x0: 0, y0: 0, z0: 0, x1: 31, y1: 31, z1: 31}, 4)
        const before = uniqueChunkBytes([original])

        const copy = original.clone()
        copy.set(5, 5, 5, 9)
        const after = uniqueChunkBytes([original, copy])

        expect(after - before).toBe(CHUNK_SIZE ** 3)
        expect((after - before) / before).toBeLessThan(0.02)
    })

    test('later writes to the same chunk are in place, not another copy', () => {
        const original = new Volume()
        original.fillBox({x0: 0, y0: 0, z0: 0, x1: 31, y1: 31, z1: 31}, 4)

        const copy = original.clone()
        const oneEdit = (() => {
            copy.set(1, 1, 1, 9)
            return uniqueChunkBytes([original, copy])
        })()
        for (let i = 0; i < CHUNK_SIZE; i += 1) {
            copy.set(i, 1, 1, 8)
        }

        expect(uniqueChunkBytes([original, copy])).toBe(oneEdit)
    })

    test('cloning a clone does not let the middle copy corrupt the first', () => {
        const a = new Volume()
        a.fillBox({x0: 0, y0: 0, z0: 0, x1: 7, y1: 7, z1: 7}, 2)
        const b = a.clone()
        b.set(0, 0, 0, 3)
        const c = b.clone()
        c.set(0, 0, 0, 4)
        b.set(1, 0, 0, 5)

        expect([a.get(0, 0, 0), b.get(0, 0, 0), c.get(0, 0, 0)]).toEqual([2, 3, 4])
        expect([a.get(1, 0, 0), b.get(1, 0, 0), c.get(1, 0, 0)]).toEqual([2, 5, 2])
    })
})
