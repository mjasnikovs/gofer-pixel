/*
 * The bridge from the benchmark to the product: the five worked examples in `src/gen/builtin.ts`,
 * named by the model under the configuration `gen/veto.ts` uses today and under the one this spike
 * measured as best.
 *
 * The corpus is primitives. These are the real thing — a dog, a chicken, a farmer, a mushroom, a
 * tower — built by the same `specFromCode` → `rasterise` → `finish` the generator runs, so the
 * pictures are the pictures the app makes.
 *
 *     bun docs/spikes/vision/bank.ts
 *
 * Open naming, not a closed list, because that is what `veto.ts` asks and the question here is
 * whether more views change its answer.
 */
import {BUILT_IN_REPLIES} from '../../../src/gen/builtin'
import {specFromCode} from '../../../src/gen/code'
import {rasterise} from '../../../src/gen/ops'
import {finish} from '../../../src/gen/finish'
import {base64For, VIEW_SETS} from './views'
import {askOnce, imagePart, textPart} from './server'
import type {Volume} from '../../../src/render/volume'

const QUESTION = 'This is a voxel model. What does it depict? Answer with one or two words.'

const SUBJECTS: Readonly<Record<string, string>> = {
    dog: 'a dog',
    chicken: 'a chicken',
    farmer: 'a farmer',
    mushroom: 'a red mushroom',
    tower: 'a stone tower'
}

const nameIt = async (volume: Volume, set: 'one' | 'fiveIso', size: number): Promise<string> => {
    const views = VIEW_SETS[set] ?? []
    const parts = []
    if (views.length > 1) {
        parts.push(textPart(`Here are ${String(views.length)} views of one voxel model.`))
        for (const view of views) {
            parts.push(textPart(`View — ${view.label}:`))
            parts.push(imagePart(await base64For(volume, view, size)))
        }
    } else {
        const view = views[0]
        if (view) parts.push(imagePart(await base64For(volume, view, size)))
    }
    parts.push(textPart(QUESTION))
    const reply = await askOnce(parts, 32)
    return reply.said.replace(/\s+/g, ' ').slice(0, 60)
}

process.stdout.write(`${'id'.padEnd(10)}${'subject'.padEnd(18)}${'one @224'.padEnd(28)}five @96\n`)
for (const [id, subject] of Object.entries(SUBJECTS)) {
    const reply = BUILT_IN_REPLIES[id]
    if (reply === undefined) continue
    const spec = specFromCode(reply, subject, 32)
    if (!spec) {
        process.stdout.write(`${id.padEnd(10)}${subject.padEnd(18)}(the reply did not run)\n`)
        continue
    }
    const volume = finish(rasterise(spec))
    // 224 px and one three-quarter view is exactly what `veto.ts` sends today.
    const before = await nameIt(volume, 'one', 224)
    const after = await nameIt(volume, 'fiveIso', 96)
    process.stdout.write(`${id.padEnd(10)}${subject.padEnd(18)}${before.padEnd(28)}${after}\n`)
}
