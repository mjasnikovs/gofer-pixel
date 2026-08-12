/*
 * The same model, written the way a worked example is written.
 *
 * `opsToCode` is correct and mute: it emits the boxes in the order the greedy decomposer found them,
 * which is sorted by coordinate and means nothing. Every hand-typed example in `src/gen/builtin.ts`
 * does three things it does not — opens on proportions, names its parts, and folds a mirrored pair
 * into a loop — and finding 7 says the example is most of the result.
 *
 * So this rewrites a decomposed spec **without changing one voxel**: same ops, same order within a
 * group, folded and commented. `narrate.test.ts` would be the place to hold that; here the runner
 * checks it by rasterising both and comparing cell for cell, which is the same assertion
 * `decompose.test.ts` makes about the decomposer itself.
 *
 * Whether the commentary is worth anything is exactly what `teachers2.ts` measures.
 */
import type {VoxOp, VoxSpec} from '../../../src/gen/ops'

const isBox = (op: VoxOp): op is Extract<VoxOp, {op: 'box'}> => op.op === 'box'

/** Which band of the model a box belongs to, by where it sits in y. */
type Band = 'legs' | 'body' | 'head'

const bandOf = (op: Extract<VoxOp, {op: 'box'}>, top: number): Band => {
    const [, y0] = op.from
    const [, y1] = op.to
    if (y0 === 0) return 'legs'
    return y1 >= Math.ceil(top * 0.62) ? 'head' : 'body'
}

const LABEL: Readonly<Record<Band, string>> = {
    legs: 'the legs, on the floor',
    body: 'the body',
    head: 'the head and what is on it'
}

/**
 * Two boxes that are each other's mirror across the middle in x, and identical in everything else.
 *
 * The fold is the point: a pair written as a loop says *these two are a pair* in a way two
 * coordinate lines cannot, and the system prompt already asks for "variables and loops where they
 * help symmetry and repetition".
 */
const mirrors = (
    a: Extract<VoxOp, {op: 'box'}>,
    b: Extract<VoxOp, {op: 'box'}>,
    width: number
): boolean =>
    a.color === b.color
    && a.from[1] === b.from[1]
    && a.to[1] === b.to[1]
    && a.from[2] === b.from[2]
    && a.to[2] === b.to[2]
    && a.from[0] === width - 1 - b.to[0]
    && a.to[0] === width - 1 - b.from[0]
    && a.from[0] !== b.from[0]

const hex = (value: string): string => value.toLowerCase()

export const narrate = (spec: VoxSpec, headline: string): string => {
    const boxes = spec.ops.filter(isBox)
    const [width, height] = spec.size

    // Colours hoisted, most-used first, exactly as `opsToCode` does it.
    const tally = new Map<string, number>()
    for (const box of boxes) tally.set(hex(box.color), (tally.get(hex(box.color)) ?? 0) + 1)
    const names = new Map<string, string>()
    ;[...tally.entries()]
        .sort((a, b) => b[1] - a[1])
        .forEach(([colour], i) => names.set(colour, `c${String(i + 1)}`))

    const lines: string[] = [`// ${headline}`]
    lines.push(
        `const ${[...names.entries()].map(([colour, name]) => `${name} = '${colour}'`).join(', ')}`
    )

    const used = new Set<number>()
    for (const band of ['legs', 'body', 'head'] as const) {
        const mine = boxes
            .map((box, index) => ({box, index}))
            .filter(({box, index}) => !used.has(index) && bandOf(box, height) === band)
        if (mine.length === 0) continue
        lines.push('')
        lines.push(`// ${LABEL[band]}`)
        for (const {box, index} of mine) {
            if (used.has(index)) continue
            const twin = mine.find(
                other => !used.has(other.index) && other.index !== index && mirrors(box, other.box, width)
            )
            const name = names.get(hex(box.color)) ?? "'#888888'"
            if (twin) {
                used.add(index)
                used.add(twin.index)
                const [ax0] = box.from
                const [bx0] = twin.box.from
                const span = box.to[0] - box.from[0]
                lines.push(`for (const x of [${String(Math.min(ax0, bx0))}, ${String(Math.max(ax0, bx0))}]) {`)
                lines.push(
                    `    box(x,${String(box.from[1])},${String(box.from[2])}, x+${String(span)},${String(box.to[1])},${String(box.to[2])}, ${name})`
                )
                lines.push('}')
            } else {
                used.add(index)
                lines.push(
                    `box(${box.from.join(',')}, ${box.to.join(',')}, ${name})`
                )
            }
        }
    }
    return lines.join('\n')
}
