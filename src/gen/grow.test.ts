import {expect, test} from 'bun:test'
import {rasterise, type Vec3, type VoxOp, type VoxSpec} from './ops'
import {bboxFill, connectivity} from './score'
import {GROW_EXAMPLES, rock, tower, tree} from './grow'

/**
 * The generators are judged the way the example bank is judged, and by the same measurements: one
 * connected piece, nowhere near a solid brick, inside the box it was given. `bank.test.ts` holds the
 * hand-typed examples to that and only somebody's eyes can say whether a dog looks like a dog — but
 * a *generator* has one more obligation the bank does not, which is that its family is a family:
 * the same seed has to give the same voxels and a different seed has to give different ones.
 *
 * All of it is the CPU rasteriser and nothing else, so the whole file is single-digit milliseconds
 * and needs no browser and no server.
 */

/** `code.ts`'s budget, restated because it is not exported. A generator has to stay well inside it. */
const OP_BUDGET = 4096

const spec = (ops: readonly VoxOp[]): VoxSpec => ({
    name: 'grown',
    size: [32, 32, 32],
    mirror_x: false,
    ops: [...ops]
})

const grown = (ops: readonly VoxOp[], canvas: number) => rasterise(spec(ops), canvas)

const bytes = (ops: readonly VoxOp[], canvas: number): string => [...grown(ops, canvas).data].join()

/** The two extreme corners an op touches, which for a ball is its bounding box. */
const corners = (op: VoxOp): readonly Vec3[] =>
    op.op === 'ball' ?
        [
            [op.at[0] - op.r[0], op.at[1] - op.r[1], op.at[2] - op.r[2]],
            [op.at[0] + op.r[0], op.at[1] + op.r[1], op.at[2] + op.r[2]]
        ]
    :   [op.from, op.to]

const outside = (ops: readonly VoxOp[], canvas: number): number => {
    let count = 0
    for (const op of ops) {
        for (const corner of corners(op)) {
            for (const axis of corner) {
                if (!Number.isInteger(axis) || axis < 0 || axis > canvas - 1) count += 1
            }
        }
    }
    return count
}

const lowest = (ops: readonly VoxOp[]): number => {
    let floor = Infinity
    for (const op of ops) {
        if (op.op === 'erase') continue
        for (const corner of corners(op)) floor = Math.min(floor, corner[1])
    }
    return floor
}

/** Which generator at which canvas, so a failing list names the case rather than a boolean. */
const at = (name: string, canvas: number): string => `${name}@${String(canvas)}`

const CANVASES = [16, 32, 64, 128]

const every = (
    canvas: number
): readonly {readonly name: string; readonly ops: readonly VoxOp[]}[] => [
    {name: 'tree', ops: tree({canvas})},
    {name: 'pine', ops: tree({canvas, shape: 'pine'})},
    {name: 'tower', ops: tower({canvas})},
    {name: 'rock', ops: rock({canvas})}
]

test('the same seed grows the same voxels, and a different seed grows a different model', () => {
    // Both halves matter. Determinism is what `GenerationRecord` promises — a spec reproduces its
    // asset — and the whole record in `docs/GEN_RESEARCH.md` is fixed-seed comparisons. But a
    // generator that *ignored* its seed would pass that half and be one shape pretending to be a
    // family, which is the more expensive failure: a batch of six identical trees.
    const seeded = [
        {name: 'tree', of: (seed: number) => tree({seed})},
        {name: 'pine', of: (seed: number) => tree({seed, shape: 'pine'})},
        {name: 'tower', of: (seed: number) => tower({seed})},
        {name: 'rock', of: (seed: number) => rock({seed})}
    ]
    for (const {name, of} of seeded) {
        expect(`${name}:${bytes(of(4200), 32)}`).toBe(`${name}:${bytes(of(4200), 32)}`)
        expect(bytes(of(4200), 32)).not.toBe(bytes(of(4201), 32))
        expect(bytes(of(4201), 32)).not.toBe(bytes(of(4202), 32))
    }
})

test('every generator grows one 6-connected piece, at every canvas', () => {
    /*
     * The failure this project already has from the model, and the one it would be inexcusable to
     * ship from code we wrote ourselves: a canopy floating off its trunk, a boulder with debris
     * beside it. Every generator buys this by construction — `walk` moves one axis per step, a limb
     * starts on a cell of the thing it hangs from, a leaf blob is centred on the tip it grows from,
     * and the rock's columns are flood-filled from the base and all cross one shared plane — so this
     * is checking the construction, not hoping for a number.
     */
    const broken: string[] = []
    for (const canvas of CANVASES) {
        for (const {name, ops} of every(canvas)) {
            if (connectivity(grown(ops, canvas)) !== 1) broken.push(at(name, canvas))
        }
    }
    expect(broken).toEqual([])
})

test('nothing a generator grows is a solid brick', () => {
    /*
     * `overallScore`'s third term is `1 - bboxFill`, and the sign on it is the one thing in that
     * weighting that was measured: three of six "a stone tower" candidates came back at 1.000 and
     * sorted to the top of a score that rewarded fill. Measured here, worst case over the four
     * canvases above:
     *
     *     tree   0.13 – 0.19      pine   0.20 – 0.24
     *     tower  0.59 – 0.61      rock   0.52 – 0.57
     *
     * The tree is the dramatic one, and it is the point of §6: a silhouette of trunk and blobs is
     * four hundred voxels of shape from four numbers. A tower and a rock are solid objects and 0.6 is
     * an honest answer for one — what makes the tower not a brick is the carving, which is the test
     * below, not this number.
     */
    for (const canvas of CANVASES) {
        expect(bboxFill(grown(tree({canvas}), canvas))).toBeLessThan(0.3)
        expect(bboxFill(grown(tree({canvas, shape: 'pine'}), canvas))).toBeLessThan(0.35)
        expect(bboxFill(grown(tower({canvas}), canvas))).toBeLessThan(0.7)
        expect(bboxFill(grown(rock({canvas}), canvas))).toBeLessThan(0.7)
    }
})

test('nothing paints outside the canvas it was given, and everything stands on its floor', () => {
    // The numbers come from a 27B model, so the canvas is enforced here as well as asked for. Feet
    // at y = 0 is finding 5's other half: the prompt has always said it and the ground lattice is
    // drawn at z = 0, so a model that floated would float over it.
    const escaped: string[] = []
    const floating: string[] = []
    for (const canvas of CANVASES) {
        for (const {name, ops} of every(canvas)) {
            if (outside(ops, canvas) !== 0) escaped.push(at(name, canvas))
            if (lowest(ops) !== 0) floating.push(at(name, canvas))
        }
    }
    expect(escaped).toEqual([])
    expect(floating).toEqual([])
})

test('a number the model invented is clamped, not obeyed', () => {
    // Every one of these has an equivalent in a real reply: a fractional height, a size an order of
    // magnitude out, a colour that is a word. None of them may paint outside the canvas.
    const wild = [
        tree({canvas: 32, height: 900, trunk: 400, branches: 99, spread: 512}),
        tree({canvas: 32, height: 12.7, shape: 'pine', branches: -4}),
        tower({canvas: 32, height: -20, width: 900, courses: 400, windows: 9}),
        rock({canvas: 32, width: 512, height: 0, depth: -3, bumpiness: 40})
    ]
    for (const ops of wild) {
        expect(outside(ops, 32)).toBe(0)
        expect(ops.length).toBeGreaterThan(0)
        expect(connectivity(grown(ops, 32))).toBe(1)
    }
})

test('the op count stays far under the budget, at the largest canvas', () => {
    /*
     * The whole design is that nothing downstream learns a new word, so a branch is a run of small
     * boxes and the price of that is op count. Measured: at canvas 128 it is tree 476, pine 8,
     * tower 77, rock 425; at 256, which is past anything `ask.ts` offers, the worst is the tree at
     * 922. The bound is not the measurement — it is 8 branches with one child each for the tree,
     * `ROCK_COLUMNS` for the rock, and a fixed grammar for the tower.
     */
    const spent: string[] = []
    for (const canvas of [128, 256]) {
        for (const {name, ops} of every(canvas)) {
            if (ops.length >= OP_BUDGET / 2) spent.push(at(name, canvas))
        }
    }
    expect(spent).toEqual([])
})

test('a tower is carved, not a box', () => {
    // `erase` is what makes it battlemented rather than a box, exactly as in `builtin.ts`'s tower.
    // Asked of the voxels rather than of the op list: an `erase` that carved nothing would still be
    // in the list, and a parapet is only a parapet if there is a hole where its middle used to be.
    const ops = tower({canvas: 32})
    expect(ops.some(op => op.op === 'erase')).toBe(true)

    const solid = grown(
        ops.filter(op => op.op !== 'erase'),
        32
    )
    const carved = grown(ops, 32)
    let before = 0
    let after = 0
    for (const value of solid.data) if (value !== 0) before += 1
    for (const value of carved.data) if (value !== 0) after += 1
    expect(after).toBeLessThan(before)
    // Not a chip off a corner: the ring, the notches and the door together take a real bite.
    expect(after / before).toBeLessThan(0.95)
    // And the carving does not cost it its one piece — every merlon is still joined to the tower.
    expect(connectivity(carved)).toBe(1)

    // Battlements off is the same tower with a solid cap, so it is the honest control on the above.
    const capped = tower({canvas: 32, battlements: false})
    let plain = 0
    for (const value of grown(capped, 32).data) if (value !== 0) plain += 1
    expect(plain).toBeGreaterThan(after)
})

/**
 * The examples run, and what they produce is a model.
 *
 * Finding 7 says an example beats a rule, and `bank.test.ts` says a broken example teaches breakage.
 * These are the calls the model is shown, so they are executed the way `code.ts` executes a reply —
 * `new Function` with the generators in scope and nothing else — rather than being asserted about as
 * strings. A worked example that does not parse is worse than no example at all.
 */
const runExample = (source: string): readonly VoxOp[] => {
    const out: VoxOp[] = []
    const wrap =
        <T>(fn: (opts: T) => readonly VoxOp[]) =>
        (opts: T): void => {
            out.push(...fn(opts))
        }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const program = new Function('tree', 'tower', 'rock', source) as (...fns: unknown[]) => void
    program(wrap(tree), wrap(tower), wrap(rock))
    return out
}

test('every worked example is a call that grows a model', () => {
    for (const [name, source] of Object.entries(GROW_EXAMPLES)) {
        // A comment first, then one call — the reply style the bank teaches.
        expect(source.startsWith('//')).toBe(true)
        expect(source).toContain(`${name}({`)

        const ops = runExample(source)
        const volume = grown(ops, 32)
        expect(ops.length > 0 ? name : `${name} painted nothing`).toBe(name)
        expect(connectivity(volume) === 1 ? name : `${name} is in pieces`).toBe(name)
        expect(bboxFill(volume)).toBeLessThan(0.75)
        expect(outside(ops, 32)).toBe(0)
    }
})
