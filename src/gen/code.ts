import {MAX_SIZE, readSpec, type VoxOp, type VoxSpec} from './ops'
import {DEFAULT_FLAGS, type Flags} from './flags'
import {silhouetteScope} from './shape'
import {rock, tower, tree} from './grow'
import {rig, RIG_NAMES, scopeFor} from './rig'
import {faceScope} from './face'

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
export const specFromCode = (
    source: string,
    name: string,
    canvas: number = MAX_SIZE,
    flags: Flags = DEFAULT_FLAGS
): VoxSpec | undefined => {
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
    /*
     * The experiments add words to the reply's vocabulary — `gen/flags.ts`, `docs/GEN_IDEAS.md`.
     *
     * Names, not a bag: `new Function` takes its scope as parameters, so a flag that is off leaves
     * the name genuinely undefined and a reply that calls it throws on that line — keeping the ops
     * before it, which is the same call this file already makes about a typo. The alternative, a
     * no-op stub, would let a batch run the experiment's prompt against none of its code and come
     * back with a model nobody could explain.
     */
    const emit = (op: VoxOp): void => {
        spend()
        ops.push(op)
    }
    /*
     * §2 replaces the language rather than extending it — `gen/rig.ts`. So it takes the whole scope,
     * and `box` in it is the rig's own, in the rig's frame. Mixing the two would hand the model two
     * meanings for one name, which is worse than either language on its own.
     *
     * Its ops are read *after* the program has run, not emitted call by call: the rig translates
     * everything it painted onto the floor and onto its own axis at the end, so an op taken early
     * would be in coordinates that no longer exist.
     */
    if (flags.relational) {
        const built = rig()
        try {
            // eslint-disable-next-line @typescript-eslint/no-implied-eval
            const program = new Function(...RIG_NAMES, body) as (...fns: unknown[]) => void
            program(...scopeFor(built))
        } catch {
            // The same call as below: what was built before the throw is still a model.
        }
        return readSpec(
            {name, size: [canvas, canvas, canvas], mirror_x: false, ops: [...built.ops]},
            canvas
        )
    }
    const hull = silhouetteScope(emit)
    /*
     * The face scope is handed the live op list, so `face` measures the solid the reply painted on
     * the lines above it — see `gen/face.ts`. That is what makes "block it out first, then paint the
     * faces" a rule the code keeps rather than a sentence in the prompt.
     */
    const surface = faceScope(ops as VoxOp[], emit)
    const names = ['box', 'ball', 'erase', 'mirrorX']
    const values: unknown[] = [box, ball, erase, mirrorX]
    if (flags.faces) {
        names.push('face')
        values.push(surface.face)
    }
    if (flags.silhouette) {
        names.push('front', 'side')
        values.push(hull.front, hull.side)
    }
    if (flags.procedural) {
        /*
         * The canvas is put in behind the model's back, and last, so it cannot be argued with —
         * §6, `gen/grow.ts`. Every generator clamps to it, and a reply that names its own `canvas`
         * would be choosing the size of a document it is not being asked about.
         */
        const grown =
            (make: (opts: Record<string, unknown>) => readonly VoxOp[]) =>
            (opts: unknown): void => {
                const given = typeof opts === 'object' && opts !== null ? opts : {}
                for (const op of make({...(given as Record<string, unknown>), canvas})) emit(op)
            }
        names.push('tree', 'tower', 'rock')
        values.push(grown(tree), grown(tower), grown(rock))
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const program = new Function(...names, body) as (...fns: unknown[]) => void
        program(...values)
    } catch {
        // A syntax error before the first op leaves `ops` empty, and empty reads as undefined.
    }
    return readSpec(
        {
            name,
            // The code names no size, so the spec records the box it was asked to draw inside.
            size: [canvas, canvas, canvas],
            mirror_x: mirror,
            ops,
            /*
             * The reply's own declaration that its content is on its surface — see `gen/face.ts`.
             * `gate.ts` and `overallScore` both read it, and both are wrong for a prop without it:
             * measured live, a correct Mario brick block was rejected at 83 % and 95 % solid.
             */
            surface: surface.used()
        },
        canvas
    )
}
