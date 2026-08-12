/*
 * Can it rank? A forced choice between two models built for the same request.
 *
 *     bun docs/spikes/vision/pairs.ts
 *
 * Three things are measured, and only the first needs an opinion about quality — which is why it is
 * bought with damage rather than with taste:
 *
 * 1. **Accuracy.** One of the pair is a worked example from the bank; the other is that same model
 *    with a hole through it, or in two floating halves. The undamaged one is better and nobody had
 *    to judge that. If it cannot see obvious damage it cannot see two seeds apart, so this is an
 *    upper bound.
 * 2. **Order sensitivity.** Every pair is asked twice, swapped. A ranker that changes its mind when
 *    the pictures change places is not a ranker, whatever its taste is like. This needs no ground
 *    truth at all.
 * 3. **Position bias**, from a pair of *identical* models. There is no right answer, so whatever it
 *    says is what it says when it cannot tell — and that is the number every other cell has to beat.
 *
 * The answer is grammar-constrained to `A` or `B`. `docs/GEN_VISION.md` measured that a free reply
 * hedges and a grammar removes the hedge, at a cost on the hardest spatial question.
 */
import {DAMAGES, type DamageId} from './damage'
import {SUBJECTS, visibility, volumeFor, VISIBLE_ENOUGH} from './seen'
import {askOnce, imagePart, textPart, type Part} from './server'
import {base64For, VIEW_SETS} from './views'
import type {Volume} from '../../../src/render/volume'

const SIZE = 96

const modelParts = async (
    label: string,
    volume: Volume,
    set: 'one' | 'fiveIso'
): Promise<Part[]> => {
    const views = VIEW_SETS[set] ?? []
    const parts: Part[] = []
    for (const view of views) {
        parts.push(textPart(views.length === 1 ? `Model ${label}:` : `Model ${label} — ${view.label}:`))
        parts.push(imagePart(await base64For(volume, view, SIZE)))
    }
    return parts
}

const choose = async (
    subject: string,
    first: Volume,
    second: Volume,
    set: 'one' | 'fiveIso'
): Promise<string> => {
    const parts: Part[] = [
        textPart(
            `Two voxel models were built for the same request: "${subject}". Here is Model A, then Model B.`
        ),
        ...(await modelParts('A', first, set)),
        ...(await modelParts('B', second, set)),
        textPart(
            `Which one is the better ${subject.replace(/^an? /, '')}? Answer with a single letter, A or B.`
        )
    ]
    const reply = await askOnce(parts, 8, ['A', 'B'])
    return reply.said.trim().toUpperCase()
}

interface Row {
    readonly subject: string
    readonly damage: DamageId | 'identical'
    readonly set: string
    /** Which letter the good model was shown as. */
    readonly goodAt: 'A' | 'B'
    readonly said: string
    readonly correct: boolean | undefined
}

const rows: Row[] = []

for (const set of ['one', 'fiveIso'] as const) {
    for (const [id, subject] of Object.entries(SUBJECTS)) {
        const good = volumeFor(id)
        if (!good) {
            process.stdout.write(`${id}: the built-in reply did not run\n`)
            continue
        }
        for (const damage of DAMAGES) {
            const bad = damage.apply(good, 4200)
            /*
             * The `mark` lesson, applied before the call rather than after it: a shaft erased
             * through the middle of a tower is behind the tower's own wall, so the two renders are
             * the same picture and the pair has no visible answer.
             */
            const share = visibility(good, bad, set)
            if (share < VISIBLE_ENOUGH) {
                process.stdout.write(
                    `  skipped ${id}/${damage.id} at ${set}: only ${(100 * share).toFixed(0)} % of the silhouette changes\n`
                )
                continue
            }
            for (const goodAt of ['A', 'B'] as const) {
                const said =
                    goodAt === 'A' ?
                        await choose(subject, good, bad, set)
                    :   await choose(subject, bad, good, set)
                rows.push({
                    subject,
                    damage: damage.id,
                    set,
                    goodAt,
                    said,
                    correct: said === goodAt
                })
            }
        }
        // The control: the same model twice. There is no right answer.
        const said = await choose(subject, good, good, set)
        rows.push({subject, damage: 'identical', set, goodAt: 'A', said, correct: undefined})
    }
}

const pct = (list: readonly Row[]): string =>
    list.length === 0 ? '  — ' : `${((100 * list.filter(r => r.correct === true).length) / list.length).toFixed(0).padStart(3)}%`

process.stdout.write(`\n${'condition'.padEnd(26)}${'picked the good one'.padStart(20)}${'n'.padStart(5)}\n`)
for (const set of ['one', 'fiveIso']) {
    const mine = rows.filter(r => r.set === set && r.damage !== 'identical')
    process.stdout.write(`${`${set}: all damage`.padEnd(26)}${pct(mine).padStart(20)}${String(mine.length).padStart(5)}\n`)
    for (const damage of DAMAGES) {
        const cell = mine.filter(r => r.damage === damage.id)
        process.stdout.write(`${`  ${damage.id}`.padEnd(26)}${pct(cell).padStart(20)}${String(cell.length).padStart(5)}\n`)
    }
    for (const goodAt of ['A', 'B'] as const) {
        const cell = mine.filter(r => r.goodAt === goodAt)
        process.stdout.write(
            `${`  good shown as ${goodAt}`.padEnd(26)}${pct(cell).padStart(20)}${String(cell.length).padStart(5)}\n`
        )
    }
}

process.stdout.write('\nposition bias — identical models, no right answer:\n')
for (const set of ['one', 'fiveIso']) {
    const mine = rows.filter(r => r.set === set && r.damage === 'identical')
    const a = mine.filter(r => r.said === 'A').length
    process.stdout.write(`  ${set.padEnd(10)}said A ${String(a)} of ${String(mine.length)}\n`)
}

process.stdout.write('\norder sensitivity — pairs whose answer survived the swap:\n')
for (const set of ['one', 'fiveIso']) {
    const mine = rows.filter(r => r.set === set && r.damage !== 'identical')
    let stable = 0
    let total = 0
    for (const [id] of Object.entries(SUBJECTS)) {
        const subject = SUBJECTS[id]
        for (const damage of DAMAGES) {
            const asA = mine.find(r => r.subject === subject && r.damage === damage.id && r.goodAt === 'A')
            const asB = mine.find(r => r.subject === subject && r.damage === damage.id && r.goodAt === 'B')
            if (!asA || !asB) continue
            total += 1
            // Stable means it named the same *model*, not the same letter.
            if ((asA.said === 'A') === (asB.said === 'B')) stable += 1
        }
    }
    process.stdout.write(
        `  ${set.padEnd(10)}${String(stable)} of ${String(total)} (${((100 * stable) / Math.max(1, total)).toFixed(0)}%)\n`
    )
}

process.stdout.write('\nevery call:\n')
for (const row of rows) {
    process.stdout.write(
        `  ${row.set.padEnd(8)}${row.subject.padEnd(16)}${row.damage.padEnd(11)}good=${row.goodAt} said=${row.said} ${row.correct === undefined ? '' : row.correct ? 'ok' : 'MISS'}\n`
    )
}
