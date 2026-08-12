/*
 * How much of each damage is actually in the picture.
 *
 *     bun docs/spikes/vision/seen.ts
 *
 * The `mark` question taught this: a question about something the render does not contain is a bad
 * question, and it scores at chance for a reason that has nothing to do with the model. A shaft
 * erased through the middle of a tower is hidden behind the tower's own wall — the render is all but
 * unchanged, so "which of these is the better tower" has no visible answer and the pair must not be
 * counted.
 *
 * The number is the share of pixels that differ between the good render and the damaged one, over
 * the union of the two silhouettes. No server.
 */
import {BUILT_IN_REPLIES} from '../../../src/gen/builtin'
import {specFromCode} from '../../../src/gen/code'
import {finish} from '../../../src/gen/finish'
import {rasterise} from '../../../src/gen/ops'
import {DAMAGES} from './damage'
import {pixelsFor, VIEW_SETS} from './views'
import type {Volume} from '../../../src/render/volume'

const SUBJECTS: Readonly<Record<string, string>> = {
    dog: 'a dog',
    chicken: 'a chicken',
    farmer: 'a farmer',
    mushroom: 'a red mushroom',
    tower: 'a stone tower'
}

/** The grey the composite paints behind a miss — see `views.ts`. */
const isGround = (r: number, g: number, b: number): boolean => r === 128 && g === 128 && b === 128

/** Share of pixels that differ, over the union of the two silhouettes. */
export const changed = (a: Uint8Array, b: Uint8Array): number => {
    let differ = 0
    let union = 0
    for (let i = 0; i < a.length; i += 4) {
        const ar = a[i] ?? 0
        const ag = a[i + 1] ?? 0
        const ab = a[i + 2] ?? 0
        const br = b[i] ?? 0
        const bg = b[i + 1] ?? 0
        const bb = b[i + 2] ?? 0
        const inA = !isGround(ar, ag, ab)
        const inB = !isGround(br, bg, bb)
        if (inA || inB) union += 1
        if (ar !== br || ag !== bg || ab !== bb) differ += 1
    }
    return union === 0 ? 0 : differ / union
}

export const visibility = (good: Volume, bad: Volume, set: 'one' | 'fiveIso'): number => {
    const views = VIEW_SETS[set] ?? []
    let worst = 0
    for (const view of views) {
        worst = Math.max(worst, changed(pixelsFor(good, view, 96), pixelsFor(bad, view, 96)))
    }
    return worst
}

export const volumeFor = (id: string): Volume | undefined => {
    const reply = BUILT_IN_REPLIES[id]
    const subject = SUBJECTS[id]
    if (reply === undefined || subject === undefined) return undefined
    const spec = specFromCode(reply, subject, 32)
    return spec ? finish(rasterise(spec)) : undefined
}

/**
 * Below this the two renders are the same picture and the pair is not asked.
 *
 * 5 % of the silhouette. `hole` on the tower comes in under it — the shaft is inside the walls —
 * and `hole` on the dog is well over.
 */
export const VISIBLE_ENOUGH = 0.05

export {SUBJECTS}

if (import.meta.main) {
    process.stdout.write(
        `${'model'.padEnd(10)}${DAMAGES.map(d => d.id.padStart(10)).join('')}   (worst view, share of silhouette changed)\n`
    )
    for (const set of ['one', 'fiveIso'] as const) {
        process.stdout.write(`${set}:\n`)
        for (const id of Object.keys(SUBJECTS)) {
            const good = volumeFor(id)
            if (!good) continue
            const cells = DAMAGES.map(damage => {
                const share = visibility(good, damage.apply(good, 4200), set)
                const mark = share < VISIBLE_ENOUGH ? '*' : ' '
                return `${(100 * share).toFixed(0)}%${mark}`.padStart(10)
            })
            process.stdout.write(`  ${id.padEnd(8)}${cells.join('')}\n`)
        }
    }
    process.stdout.write(`\n* below ${String(100 * VISIBLE_ENOUGH)} % — not asked\n`)
}
