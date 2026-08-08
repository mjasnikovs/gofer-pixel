import {MAX_SIZE, readSpec, type VoxSpec} from './ops'

/**
 * The model's reply is a program, and this runs it.
 *
 * The op language stopped being the wire format on 2026-08-08, measured against the live
 * Qwen3.6-27B: a schema-constrained JSON reply starts emitting ops on its first token, so it has
 * nowhere to think, and the finding-7 worked example was carrying the entire load. The same model
 * asked for JavaScript instead writes a proportions comment first, uses loops for the legs it would
 * otherwise miscount, and named its own renders as the subject 4 of 4 times against 2 of 4 for the
 * JSON path. So the reply is now code calling four functions, and the ops fall out of running it.
 *
 * The code runs with nothing in scope but those four functions. That is a statement about
 * *accidents*, not about hostility: a `new Function` body still sees the page's globals, and the
 * budget below cannot stop an op-free `while (true)`. Both are accepted — the code comes from a
 * local model this app itself prompted, and moving execution into a killable Worker would buy
 * preemption at the price of the no-waiting testing law.
 */
const OP_BUDGET = 4096

/**
 * A reply narrowed into a spec, or `undefined` for anything that did not paint.
 *
 * Execution errors after the first op keep what was painted — the same call as `readSpec` dropping
 * one broken op instead of the reply: a model that crashes on line nine painted eight lines of
 * voxels first, and throwing those away refuses a model over a typo. `readSpec` still validates
 * every op afterwards, so a box called with a string coordinate is dropped, not smeared.
 */
export const specFromCode = (source: string, name: string): VoxSpec | undefined => {
    const body = source.replace(/^\s*```\w*\s*\n/, '').replace(/\n?```\s*$/, '')
    const ops: unknown[] = []
    let mirror = false
    const spend = (): void => {
        if (ops.length >= OP_BUDGET) throw new Error('op budget spent')
    }
    const box = (...args: unknown[]): void => {
        spend()
        const [x0, y0, z0, x1, y1, z1, color] = args
        ops.push({op: 'box', from: [x0, y0, z0], to: [x1, y1, z1], color})
    }
    const ball = (...args: unknown[]): void => {
        spend()
        const [x, y, z, rx, ry, rz, color] = args
        ops.push({op: 'ball', at: [x, y, z], r: [rx, ry, rz], color})
    }
    const erase = (...args: unknown[]): void => {
        spend()
        const [x0, y0, z0, x1, y1, z1] = args
        ops.push({op: 'erase', from: [x0, y0, z0], to: [x1, y1, z1]})
    }
    const mirrorX = (): void => {
        mirror = true
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const program = new Function('box', 'ball', 'erase', 'mirrorX', body) as (
            ...fns: unknown[]
        ) => void
        program(box, ball, erase, mirrorX)
    } catch {
        // A syntax error before the first op leaves `ops` empty, and empty reads as undefined.
    }
    return readSpec({
        name,
        size: [MAX_SIZE, MAX_SIZE, MAX_SIZE],
        mirror_x: mirror,
        ops
    })
}
