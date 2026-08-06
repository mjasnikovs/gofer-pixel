import {describe, expect, test} from 'bun:test'
import {celAt, createDocument, editCel, type Document} from '../doc/document'
import {Volume} from '../doc/volume'
import {PALETTE} from '../vox/palette'
import {bakeRig, mirrorBone, poseAt, poseVolume, type Bone, type Rig} from './rig'

const size = {sx: 12, sy: 6, sz: 6}

const arm = (keys: Bone['keys'], mirrorX?: boolean): Bone => ({
    name: 'arm',
    box: {x0: 0, y0: 0, z0: 0, x1: 2, y1: 5, z1: 5},
    keys,
    ...(mirrorX === undefined ? {} : {mirrorX})
})

const rest = (): Volume => {
    const volume = new Volume()
    volume.fillBox({x0: 0, y0: 0, z0: 0, x1: 2, y1: 0, z1: 0}, 3) // the arm
    volume.fillBox({x0: 6, y0: 0, z0: 0, x1: 8, y1: 0, z1: 0}, 5) // the body, not in any bone
    return volume
}

const positions = (volume: Volume): string[] => {
    const out: string[] = []
    volume.forEach((x, y, z, color) => {
        out.push(`${String(x)},${String(y)},${String(z)}=${String(color)}`)
    })
    return out.sort()
}

describe('poseAt', () => {
    const bone = arm([
        {frame: 0, offset: [0, 0, 0]},
        {frame: 4, offset: [4, 0, 0]}
    ])

    test('holds the first key before it and the last key after it', () => {
        expect(poseAt(bone, -3).offset).toEqual([0, 0, 0])
        expect(poseAt(bone, 99).offset).toEqual([4, 0, 0])
    })

    test('interpolates between keys and lands on whole voxels', () => {
        expect(poseAt(bone, 1).offset).toEqual([1, 0, 0])
        expect(poseAt(bone, 2).offset).toEqual([2, 0, 0])
        // 4 frames over 3 voxels: every in-between is still an integer, never a half voxel
        const odd = arm([
            {frame: 0, offset: [0, 0, 0]},
            {frame: 4, offset: [3, 0, 0]}
        ])
        for (const frame of [0, 1, 2, 3, 4]) {
            for (const value of poseAt(odd, frame).offset) {
                expect(Number.isInteger(value)).toBe(true)
            }
        }
    })

    test('a bone with no keys sits still', () => {
        expect(poseAt(arm([]), 3)).toEqual({offset: [0, 0, 0], hidden: false})
    })

    test('mirrorX flips the interpolated x', () => {
        const mirrored = arm(
            [
                {frame: 0, offset: [0, 0, 0]},
                {frame: 4, offset: [4, 0, 0]}
            ],
            true
        )
        expect(poseAt(mirrored, 2).offset).toEqual([-2, 0, 0])
    })

    test('visibility does not interpolate', () => {
        const blinking = arm([
            {frame: 0, offset: [0, 0, 0], hidden: true},
            {frame: 4, offset: [0, 0, 0]}
        ])
        expect(poseAt(blinking, 1).hidden).toBe(true)
        expect(poseAt(blinking, 4).hidden).toBe(false)
    })
})

describe('poseVolume', () => {
    const rig: Rig = {
        bones: [
            arm([
                {frame: 0, offset: [0, 0, 0]},
                {frame: 2, offset: [0, 0, 2]}
            ])
        ]
    }

    test('moves the bone and leaves everything else alone', () => {
        const posed = poseVolume(rest(), rig, 2, size)
        expect(positions(posed)).toEqual([
            '0,0,2=3',
            '1,0,2=3',
            '2,0,2=3',
            '6,0,0=5',
            '7,0,0=5',
            '8,0,0=5'
        ])
    })

    test('the rest pose is untouched by posing', () => {
        const source = rest()
        poseVolume(source, rig, 2, size)
        expect(positions(source)).toEqual(positions(rest()))
    })

    test('a hidden bone disappears without taking the rest with it', () => {
        const hidden: Rig = {bones: [arm([{frame: 0, offset: [0, 0, 0], hidden: true}])]}
        expect(positions(poseVolume(rest(), hidden, 0, size))).toEqual([
            '6,0,0=5',
            '7,0,0=5',
            '8,0,0=5'
        ])
    })

    test('a bone pushed off the canvas is clipped, not wrapped', () => {
        const off: Rig = {bones: [arm([{frame: 0, offset: [0, 0, 20]}])]}
        expect(positions(poseVolume(rest(), off, 0, size))).toEqual([
            '6,0,0=5',
            '7,0,0=5',
            '8,0,0=5'
        ])
    })
})

describe('bakeRig', () => {
    const doc = (): Document =>
        editCel(createDocument({size, palette: PALETTE, name: 'rigged'}), 0, 0, volume => {
            volume.paste(rest())
        })

    test('leaves frame 0 as the rest pose and fills the rest', () => {
        const rig: Rig = {
            bones: [
                arm([
                    {frame: 0, offset: [0, 0, 0]},
                    {frame: 3, offset: [0, 0, 3]}
                ])
            ]
        }
        const baked = bakeRig(doc(), rig, 4)

        expect(baked.frames).toBe(4)
        expect(positions(celAt(baked, 0, 0) ?? new Volume())).toEqual(positions(rest()))
        expect(celAt(baked, 0, 1)?.get(0, 0, 1)).toBe(3)
        expect(celAt(baked, 0, 3)?.get(0, 0, 3)).toBe(3)
        // the body never moves
        expect(celAt(baked, 0, 2)?.get(6, 0, 0)).toBe(5)
    })

    test('baking twice gives the same frames — it replaces, it does not accumulate', () => {
        const rig: Rig = {
            bones: [
                arm([
                    {frame: 0, offset: [0, 0, 0]},
                    {frame: 2, offset: [0, 0, 2]}
                ])
            ]
        }
        const once = bakeRig(doc(), rig, 3)
        const twice = bakeRig(once, rig, 3)
        expect(positions(celAt(twice, 0, 2) ?? new Volume())).toEqual(
            positions(celAt(once, 0, 2) ?? new Volume())
        )
    })

    test('every baked frame keeps the voxel count of the rest pose', () => {
        const rig: Rig = {
            bones: [
                arm([
                    {frame: 0, offset: [0, 0, 0]},
                    {frame: 4, offset: [1, 2, 1]}
                ])
            ]
        }
        const baked = bakeRig(doc(), rig, 5)
        for (let frame = 0; frame < 5; frame += 1) {
            expect(celAt(baked, 0, frame)?.count).toBe(6)
        }
    })
})

describe('mirrorBone', () => {
    test('reflects the box and the offsets about the canvas centre', () => {
        const source = arm([{frame: 0, offset: [2, 1, 0]}])
        const mirrored = mirrorBone(source, size)
        expect(mirrored.box.x0).toBe(size.sx - 1 - source.box.x1)
        expect(mirrored.box.x1).toBe(size.sx - 1 - source.box.x0)
        expect(mirrored.keys[0]?.offset).toEqual([-2, 1, 0])
        expect(mirrored.name).toContain('mirrored')
    })
})
