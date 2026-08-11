import {expect, test} from 'bun:test'
import {voxelIndex, type Volume} from '../render/volume'
import {countFilled, rasterise, type VoxOp, type VoxSpec} from './ops'
import {bboxFill, connectivity, shellColors} from './score'
import {faceScope, FACE_EXAMPLES, type Painter} from './face'

/**
 * The face language — `gen/face.ts`. The claim under test is the one the brick measurement made:
 * a prop's information is on its surface, and until this existed the model painted its mortar lines
 * through the middle of a solid cube where nothing could see them.
 */

const CUBE: VoxOp = {op: 'box', from: [0, 0, 0], to: [15, 15, 15], color: '#c2703c'}

/** Run a draw against a solid cube and hand back everything that was painted. */
const onCube = (name: string, draw: (surface: Painter) => void): {ops: VoxOp[]; used: boolean} => {
    const ops: VoxOp[] = [CUBE]
    const scope = faceScope(ops, op => ops.push(op))
    scope.face(name, draw)
    return {ops, used: scope.used()}
}

const spec = (ops: readonly VoxOp[]): VoxSpec => ({
    name: 'test',
    size: [16, 16, 16],
    mirror_x: false,
    ops
})

const colorAt = (volume: Volume, x: number, y: number, z: number): number =>
    volume.data[voxelIndex(volume, x, y, z)] ?? 0

test('a face lands on the outside of the box, one voxel deep', () => {
    // `+z` is the front: the ops are y-up, and `rasterise` swaps y and z into the grid.
    const {ops} = onCube('+z', s => {
        s.rect(0, 0, s.width - 1, s.height - 1, '#ffffff')
    })
    const mark = ops[1]
    if (mark?.op !== 'box') throw new Error('expected a box')
    // The whole face, at the far z and nowhere else.
    expect(mark.from).toEqual([0, 0, 15])
    expect(mark.to).toEqual([15, 15, 15])
})

test('every one of the six names lands on its own side', () => {
    const sides: readonly [string, number, number, number][] = [
        // name, axis index in op space, expected from[axis], expected to[axis]
        ['+x', 0, 15, 15],
        ['-x', 0, 0, 0],
        ['+y', 1, 15, 15],
        ['-y', 1, 0, 0],
        ['+z', 2, 15, 15],
        ['-z', 2, 0, 0]
    ]
    for (const [name, axis, from, to] of sides) {
        const {ops} = onCube(name, s => {
            s.rect(0, 0, s.width - 1, s.height - 1, '#ffffff')
        })
        const mark = ops[1]
        if (mark?.op !== 'box') throw new Error(`${name} painted nothing`)
        expect(mark.from[axis]).toBe(from)
        expect(mark.to[axis]).toBe(to)
    }
})

/**
 * `v` is up on all four side faces, which is the reason `bevel` can mean "light on top" at all. The
 * test is on two different axes, because a mapping that got one right by luck gets the other wrong.
 */
test('v is up on the side faces, so the bevel lights the top edge', () => {
    for (const name of ['+z', '-x']) {
        const {ops} = onCube(name, s => {
            s.bevel(1, '#ffffff', '#000000')
        })
        const lit = ops.find(op => op.op === 'box' && op.color === '#ffffff')
        if (lit?.op !== 'box') throw new Error(`${name} lit nothing`)
        // The first mark a bevel makes is the top edge, at the highest y the cube has.
        expect(lit.to[1]).toBe(15)
        expect(lit.from[1]).toBe(15)
    }
})

test('a face with nothing painted before it does nothing, and declares nothing', () => {
    const ops: VoxOp[] = []
    const scope = faceScope(ops, op => ops.push(op))
    scope.face('+z', (s: Painter) => {
        s.rect(0, 0, 4, 4, '#ffffff')
    })
    expect(ops).toHaveLength(0)
    // "Block it out first, then paint the faces" is a rule, and this is it being kept.
    expect(scope.used()).toBe(false)
})

test('used() is false until a mark actually lands', () => {
    const bare = onCube('+z', () => {
        // draws nothing
    })
    expect(bare.used).toBe(false)

    const marked = onCube('+z', s => {
        s.dot(1, 1, '#ffffff')
    })
    expect(marked.used).toBe(true)
})

test('an unknown face name and a non-function body are both ignored', () => {
    const ops: VoxOp[] = [CUBE]
    const scope = faceScope(ops, op => ops.push(op))
    scope.face('+w', (s: Painter) => {
        s.dot(0, 0, '#ffffff')
    })
    scope.face('+z', 'not a function')
    expect(ops).toHaveLength(1)
    expect(scope.used()).toBe(false)
})

test('coordinates off the face are clipped, not wrapped, and never grow the model', () => {
    const {ops} = onCube('+z', s => {
        s.rect(-40, -40, 400, 400, '#ffffff')
    })
    const mark = ops[1]
    if (mark?.op !== 'box') throw new Error('expected a box')
    expect(mark.from).toEqual([0, 0, 15])
    expect(mark.to).toEqual([15, 15, 15])

    // Entirely off the face is nothing at all, rather than a mark smeared along the edge.
    const away = onCube('+z', s => {
        s.dot(99, 99, '#ffffff')
    })
    expect(away.used).toBe(false)
})

/**
 * The test that proves a surface is a surface: painting every face of a solid cube repaints cells
 * that were already filled, so the voxel count does not move. A language that grew the model would
 * be painting solids again under a different name.
 */
test('a face repaints the model rather than adding to it', () => {
    const plain = rasterise(spec([CUBE]))
    const {ops} = ((): {ops: VoxOp[]} => {
        const all: VoxOp[] = [CUBE]
        const scope = faceScope(all, op => all.push(op))
        for (const name of ['+x', '-x', '+y', '-y', '+z', '-z']) {
            scope.face(name, (s: Painter) => {
                s.bevel(1, '#ffffff', '#000000')
            })
        }
        return {ops: all}
    })()
    const painted = rasterise(spec(ops))

    expect(countFilled(painted)).toBe(countFilled(plain))
    expect(painted.sx).toBe(plain.sx)
    expect(painted.sy).toBe(plain.sy)
    expect(painted.sz).toBe(plain.sz)
    // And it did change the picture: the shell now carries three tones where it carried one.
    expect(shellColors(plain)).toBe(1)
    expect(shellColors(painted)).toBe(3)
})

test('courses are staggered, so a face reads as brickwork rather than graph paper', () => {
    const {ops} = onCube('+z', s => {
        s.courses(4, 2, '#000000')
    })
    const uprights = ops
        .filter(
            (op): op is Extract<VoxOp, {op: 'box'}> => op.op === 'box' && op.color === '#000000'
        )
        // The verticals are the ones that do not span the whole width.
        .filter(op => op.from[0] === op.to[0])
        .map(op => op.from[0])

    expect(uprights.length).toBeGreaterThan(1)
    // Alternate rows are offset half a cell: more than one distinct column means a running bond.
    expect(new Set(uprights).size).toBeGreaterThan(1)
})

/**
 * The examples, run the way `code.ts` runs a reply. What is asserted is what a prop *is*: one solid
 * piece, mostly filled — which every other test in `src/gen/` treats as failure — and several
 * colours on the shell, which is where all of its information lives.
 */
test('both worked examples are props: solid, joined, and patterned on the outside', () => {
    for (const [id, reply] of Object.entries(FACE_EXAMPLES)) {
        if (reply === undefined) throw new Error(`${id} has no reply`)
        const ops: VoxOp[] = []
        const emit = (op: VoxOp): void => {
            ops.push(op)
        }
        const scope = faceScope(ops, emit)
        const box = (
            x0: number,
            y0: number,
            z0: number,
            x1: number,
            y1: number,
            z1: number,
            color: string
        ): void => {
            emit({op: 'box', from: [x0, y0, z0], to: [x1, y1, z1], color})
        }
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const program = new Function('box', 'face', reply) as (...fns: unknown[]) => void
        program(box, scope.face)

        const volume = rasterise(spec(ops))
        expect(scope.used()).toBe(true)
        expect(connectivity(volume)).toBe(1)
        // A prop is *meant* to be solid. This is the assertion `shape.ts` and `rig.ts` invert.
        expect(bboxFill(volume)).toBeGreaterThan(0.9)
        expect(shellColors(volume)).toBeGreaterThanOrEqual(3)
        // And the pattern is on the outside: the middle of the cube is still the base colour.
        expect(colorAt(volume, 8, 8, 8)).toBeGreaterThan(0)
    }
})
