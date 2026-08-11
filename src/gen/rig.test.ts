import {expect, test} from 'bun:test'
import {voxelIndex, type Volume} from '../render/volume'
import {readSpec, rasterise, type VoxOp} from './ops'
import {bboxFill, connectivity} from './score'
import {LINE_BUDGET} from './teaching'
import {
    RIG_NAMES,
    RIG_REPLIES,
    RIG_SYSTEM,
    rig,
    rigSystemFor,
    scopeFor,
    type Face,
    type Rig
} from './rig'

/**
 * A reply, run the way the app will run it.
 *
 * `bank.test.ts` goes through `specFromCode`, because that is the seam its examples are executed
 * through. This language has no such seam yet — someone else puts these functions into the reply's
 * scope, behind the `relational` flag — so the harness is here, built out of the two exports whose
 * only job is keeping the names and the values in the same order.
 */
const run = (source: string): Rig => {
    const built = rig()
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const program = new Function(...RIG_NAMES, source) as (...fns: unknown[]) => void
    program(...scopeFor(built))
    return built
}

const modelOf = (built: Rig, name = 'rig'): Volume => {
    const spec = readSpec({name, size: [32, 32, 32], mirror_x: false, ops: built.ops})
    if (!spec) throw new Error(`${name} painted nothing`)
    return rasterise(spec)
}

const lowestY = (ops: readonly VoxOp[]): number => {
    let low = Infinity
    for (const op of ops) if (op.op === 'box') low = Math.min(low, op.from[1], op.to[1])
    return low
}

/** The op language is y-up and a `Volume` is z-up, so an op cell reads `(x, z, y)` in the grid. */
const filledAt = (volume: Volume, x: number, y: number, z: number): boolean =>
    (volume.data[voxelIndex(volume, x, z, y)] ?? 0) !== 0

const layerFilled = (volume: Volume, y: number): boolean => {
    for (let z = 0; z < volume.sy; z += 1) {
        for (let x = 0; x < volume.sx; x += 1) if (filledAt(volume, x, y, z)) return true
    }
    return false
}

/*
 * The floor under any example, whoever wrote it and in whichever language — the same shape as
 * `bank.test.ts`'s, over the same two scores, because a broken example teaches breakage and the
 * examples are measured to be the ceiling in both directions (findings 7 and 8).
 *
 * It is a floor and not a likeness. Only eyes can say whether the dog looks like a dog.
 */
test('every worked example is a model, not a story about one', () => {
    const ids = ['chicken', 'dog', 'farmer', 'mushroom', 'tower']
    expect(Object.keys(RIG_REPLIES).sort()).toEqual(ids)

    for (const id of ids) {
        const source = RIG_REPLIES[id]
        expect(source ?? '').not.toBe('')
        if (source === undefined) continue

        const volume = modelOf(run(source), id)
        // One connected piece, standing up, and nowhere near a solid brick.
        expect(connectivity(volume)).toBe(1)
        expect(bboxFill(volume)).toBeLessThan(0.75)
        expect(volume.sz).toBeGreaterThan(8)
        // And it has to fit: every candidate in every batch pays for every example in full.
        expect(source.split('\n').length).toBeLessThanOrEqual(LINE_BUDGET)
    }
})

/*
 * §2's named failure mode is the model ignoring the new language and reverting to boxes, and an
 * example that did it would teach exactly that. So the escape hatch is allowed only where its
 * numbers are read off a part — which is the rule the prompt states, held here against the one
 * example that touches the hatch at all.
 */
test('every example uses the language rather than reverting to boxes', () => {
    for (const [id, source] of Object.entries(RIG_REPLIES)) {
        const text = source ?? ''
        expect(text).toContain('part(')
        for (const call of text.matchAll(/\b(?:box|erase)\(([^)]*)\)/g)) {
            expect(`${id}: ${call[1] ?? ''}`).toContain('.')
        }
    }
})

test('every op comes out as whole cells, so nothing downstream has to round', () => {
    for (const source of Object.values(RIG_REPLIES)) {
        for (const op of run(source ?? '').ops) {
            // No ellipsoids: every guarantee in this language is a claim about two boxes.
            expect(op.op).not.toBe('ball')
            if (op.op === 'ball') continue
            for (const value of [...op.from, ...op.to]) expect(Number.isInteger(value)).toBe(true)
        }
    }
})

test('an attached part is flush with the face it names, with no layer of air between', () => {
    const built = rig()
    const torso = built.part('torso', 7, 6, 5, '#4a7a3a')
    const head = built.attach('head', torso, '+y', {w: 3, h: 3, d: 3, color: '#e0b088'})
    expect(head.y0).toBe(torso.y1 + 1)

    const volume = modelOf(built)
    // There is no layer between them to be empty, so what is left to check is that neither is.
    for (const y of [torso.y1, head.y0]) expect(layerFilled(volume, y)).toBe(true)
    expect(connectivity(volume)).toBe(1)
})

test('a part slid off its parent is pulled back until it still touches', () => {
    const built = rig()
    const torso = built.part('torso', 7, 6, 5, '#4a7a3a')
    // 400 cells to the left of a 7-wide torso is not a place. One cell of overlap is.
    const head = built.attach('head', torso, '+y', {w: 3, h: 3, d: 3, dx: 400, dz: -400})
    expect(head.x0).toBe(torso.x1)
    expect(head.z1).toBe(torso.z0)
    expect(connectivity(modelOf(built))).toBe(1)
})

test('the axis of the face itself is not a parameter, so a gap cannot be spelled', () => {
    const built = rig()
    const torso = built.part('torso', 7, 6, 5, '#4a7a3a')
    const flush = built.attach('head', torso, '+y', {w: 3, h: 3, d: 3})
    const asked = built.attach('head', torso, '+y', {w: 3, h: 3, d: 3, dy: 9})
    expect(asked.y0).toBe(flush.y0)
    expect(connectivity(modelOf(built))).toBe(1)
})

test('sink pushes a part into its parent and never out of the far side', () => {
    const built = rig()
    const shaft = built.part('shaft', 6, 10, 6, '#8a8a86')
    // A sink equal to the part's own height is a recolour of a band, which is a base course.
    const course = built.attach('base', shaft, '-y', {w: 6, h: 3, d: 6, sink: 3, color: '#6f6f6b'})
    expect(course.y0).toBe(shaft.y0)
    expect(course.y1).toBe(shaft.y0 + 2)
    // Asking for more can only ever mean "all the way in".
    const deeper = built.attach('base', shaft, '-y', {w: 6, h: 3, d: 6, sink: 99})
    expect(deeper.y0).toBe(course.y0)
    expect(connectivity(modelOf(built))).toBe(1)
})

test('a leg reaches y = 0 whatever the torso is, and whatever length it was asked for', () => {
    for (const height of [2, 5, 8, 20]) {
        for (const length of [1, 4, 11]) {
            const built = rig()
            const torso = built.part('torso', 7, height, 5, '#4a7a3a')
            built.legs(torso, {count: 2, length, thick: 2, color: '#5a4632'})
            expect(lowestY(built.ops)).toBe(0)

            const volume = modelOf(built)
            expect(layerFilled(volume, 0)).toBe(true)
            expect(connectivity(volume)).toBe(1)
        }
    }
})

test('a leg is lengthened to the floor rather than the figure being lifted onto air', () => {
    const built = rig()
    const body = built.part('body', 6, 5, 12, '#8b5a2b')
    built.legs(body, {count: 4, length: 3, thick: 2, color: '#8b5a2b'})
    // A tail hung below the belly is lower than the legs were told to be. The legs grow to it.
    built.attach('tail', body, '-z', {w: 2, h: 8, d: 3, dy: -6, color: '#a0693a'})
    const volume = modelOf(built)
    expect(lowestY(built.ops)).toBe(0)
    expect(layerFilled(volume, 0)).toBe(true)
    expect(connectivity(volume)).toBe(1)
})

/** x is left/right in op space, and `rasterise` leaves it as the grid's own x. */
const mirrorsExactly = (volume: Volume): boolean => {
    for (let z = 0; z < volume.sz; z += 1) {
        for (let y = 0; y < volume.sy; y += 1) {
            for (let x = 0; x < volume.sx; x += 1) {
                const here = volume.data[voxelIndex(volume, x, y, z)] ?? 0
                const there = volume.data[voxelIndex(volume, volume.sx - 1 - x, y, z)] ?? 0
                if (here !== there) return false
            }
        }
    }
    return true
}

test('a mirrored pair is exact, in every call that makes one', () => {
    const built = rig()
    const torso = built.part('torso', 9, 8, 5, '#4a7a3a')
    const head = built.attach('head', torso, '+y', {w: 5, h: 5, d: 5, color: '#e0b088'})
    built.pair('eye', head, '+z', {w: 1, h: 1, d: 1, dx: 1, color: '#2b2b28'})
    built.pair('ear', head, '+x', {w: 1, h: 2, d: 2, color: '#e0b088'})
    built.arms(torso, {length: 7, thick: 2, color: '#4a7a3a', hand: '#e0b088'})
    built.legs(torso, {count: 2, length: 9, thick: 3, inset: 1, color: '#5a4632'})
    expect(mirrorsExactly(modelOf(built))).toBe(true)
})

test('a pair mirrors onto whole cells whether the parent is odd or even across', () => {
    // The plane is carried as `x0 + x1` rather than as a centre, so an even width has no half-cell.
    for (const width of [4, 5, 6, 7]) {
        const built = rig()
        const body = built.part('body', width, 4, 4, '#8b5a2b')
        const [one, other] = built.pair('horn', body, '+y', {w: 1, h: 1, d: 1, dx: 1})
        expect(other.x0).toBe(body.x0 + body.x1 - one.x1)
        expect(other.w).toBe(one.w)
        expect(Number.isInteger(other.x0)).toBe(true)
        expect(mirrorsExactly(modelOf(built))).toBe(true)
    }
})

test('a pair of legs is one length, because it is one expression', () => {
    const built = rig()
    const torso = built.part('torso', 8, 6, 6, '#4a7a3a')
    built.legs(torso, {count: 4, length: 7, thick: 2, color: '#5a4632'})
    const legs = built.ops.filter(op => op.op === 'box' && op.color === '#5a4632')
    expect(legs).toHaveLength(4)
    const heights = new Set(legs.map(op => (op.op === 'box' ? op.to[1] - op.from[1] : -1)))
    expect(heights.size).toBe(1)
})

test('an absurd size is clamped rather than crashing, and still paints', () => {
    const built = rig()
    // Everything a 27B model can emit that is not a size: 1e9, a NaN, a negative, a colour name.
    const torso = built.part('torso', 1e9, Number.NaN, -5, 'not a colour')
    expect(torso.w).toBe(128)
    expect(torso.h).toBe(1)
    expect(torso.d).toBe(1)
    expect(torso.color).toBe('#808080')

    built.attach('head', torso, 'sideways' as Face, {w: 1e9, h: -3, color: '#abc'})
    built.legs(torso, {count: 99, length: 1e9, thick: 1e9, color: '#fff'})
    built.arms(torso, {length: Number.POSITIVE_INFINITY, thick: 1e9, drop: 1e9})

    expect(
        readSpec({name: 'absurd', size: [32, 32, 32], mirror_x: false, ops: built.ops})
    ).toBeDefined()
    for (const op of built.ops) {
        if (op.op === 'ball') continue
        for (const value of [...op.from, ...op.to]) {
            expect(Number.isInteger(value)).toBe(true)
            expect(Math.abs(value)).toBeLessThanOrEqual(1024)
        }
    }
    // A short colour is expanded rather than dropped: the shape is the thing the model got right.
    expect(built.ops.some(op => op.op === 'box' && op.color === '#aabbcc')).toBe(true)
})

test('a reply that will not stop building ends in a model rather than in a hang', () => {
    const built = run(`const body = part('body', 6, 6, 6, '#8b5a2b')
let last = body
for (let i = 0; i < 100000; i += 1) last = attach('bit', last, '+y', {w: 1, h: 1, d: 1})`)
    expect(built.ops.length).toBeLessThanOrEqual(4096)
    expect(built.ops.length).toBeGreaterThan(1)
    expect(connectivity(modelOf(built))).toBe(1)
})

test('the escape hatch is in the rig frame and travels with the rest of it', () => {
    const built = rig()
    const shaft = built.part('shaft', 6, 8, 6, '#8a8a86')
    built.box(shaft.x0, shaft.y0 + 4, shaft.z0, shaft.x0, shaft.y0 + 5, shaft.z0, '#2b2b28')
    built.erase(shaft.x0 + 2, shaft.y0, shaft.z0, shaft.x0 + 3, shaft.y0 + 2, shaft.z0)
    expect(built.ops.filter(op => op.op === 'erase')).toHaveLength(1)

    const volume = modelOf(built)
    expect(filledAt(volume, 0, 4, 0)).toBe(true)
    // The carve is a notch in the near wall, not a hole through the shaft.
    expect(filledAt(volume, 2, 0, 0)).toBe(false)
    expect(filledAt(volume, 2, 0, 1)).toBe(true)
    expect(connectivity(volume)).toBe(1)
})

test('a coordinate that is not a place is dropped, never smeared along a wall', () => {
    const built = rig()
    built.part('shaft', 4, 4, 4, '#8a8a86')
    built.box(0, 0, 0, 99999, 2, 2, '#2b2b28')
    built.box(Number.NaN, 0, 0, 2, 2, 2, '#2b2b28')
    // Two refused boxes and one mass: the model is the mass, unmarked.
    expect(built.ops).toHaveLength(1)
})

test('the prompt names every function it hands over, and carries the canvas the same way', () => {
    for (const name of RIG_NAMES) expect(RIG_SYSTEM).toContain(`${name}(`)
    expect(RIG_SYSTEM).toContain('32x32x32')
    expect(rigSystemFor(64)).toContain('64x64x64')
    expect(rigSystemFor(128)).toContain('128x128x128')
    // Both halves of the canvas switch: the bound, and the instruction to use the box.
    expect(rigSystemFor(64)).toContain('close to 64 tall')
    expect(RIG_SYSTEM).toContain('Feet at y=0')
    // And what the hatch is for, which is the whole of the prompt's defence against §2's risk.
    expect(RIG_SYSTEM).toContain('Do not build the masses with')
})

test('the scope is the names, in the order the names are in', () => {
    const built = rig()
    const values = scopeFor(built)
    expect(values).toHaveLength(RIG_NAMES.length)
    expect(values[0]).toBe(built.part)
    expect(values[1]).toBe(built.attach)
    expect(values[2]).toBe(built.pair)
    expect(values[3]).toBe(built.legs)
    expect(values[4]).toBe(built.arms)
    expect(values[5]).toBe(built.box)
    expect(values[6]).toBe(built.erase)
})
