import {decompose, opsToCode} from './decompose'
import type {Volume} from '../render/volume'
import type {BankEntry, WorkedExample} from './bank'

/**
 * What teaches one batch: which examples, in what order, within what budget.
 *
 * Four rules decide that, and before this module they lived in four places that could each change
 * without the others noticing:
 *
 * - the **order**, in a `.reverse()` inside `library.ts`'s `teach`;
 * - the **composition** — the artist's dropped model goes after the bank — in a lambda inside
 *   `batch.ts`;
 * - the **budget**, in `reference.ts`, and *only* there.
 *
 * That last one was a real hole rather than an untidiness. `LINE_BUDGET` is the measurement that
 * says an example costs about 900 tokens and three of them is most of a candidate's context. A
 * model dropped on the dialog was checked against it and refused by name; the bank's own entries
 * went through `exampleFrom` with no check at all and ended up in the same array. Check a 200-line
 * `.vox` in to `src/assets/examples/` and every batch silently paid for it.
 *
 * So `WorkedExample` is now only built here, through a constructor that can fail, and both paths
 * go through it.
 *
 * `MAX_PICKS` stays in `bank.ts` on purpose: `pickPrompt` writes the cap into the sentence it sends
 * the model, so the number and the prompt that states it have to move together.
 */

/**
 * What an example costs before it stops being worth its rent.
 *
 * Every candidate in every batch pays for every example it is shown, in full. 80 lines is roughly
 * 900 tokens, and at three examples that is most of a candidate's budget spent before the model has
 * read the prompt. The answer to a model that will not fit is a simpler model.
 */
export const LINE_BUDGET = 80

export const lineCount = (example: WorkedExample): number => example.reply.split('\n').length

export const overBudget = (example: WorkedExample): boolean => lineCount(example) > LINE_BUDGET

/**
 * A model, as the example that teaches it — or the reason it cannot be one.
 *
 * The one way a `WorkedExample` is made from a `Volume`, so "checked" stops being something a
 * caller has to know it is responsible for. `undefined` means over budget, and `lineCount` on the
 * rejected example is what the artist gets told.
 *
 * The headline is the artist's `notes` when there are any, and the measurements otherwise. The
 * measurements alone still tell the model that a plan comes before the code, which is most of what
 * the comment is doing.
 */
export const exampleFrom = (
    entry: BankEntry,
    volume: Volume
): {readonly example: WorkedExample; readonly fits: boolean} => {
    const spec = decompose(volume, entry.subject)
    const [width, height, depth] = spec.size
    const name = entry.subject.replace(/^(a|an|the) /, '')
    const measured = `${name}: ${String(width)} wide, ${String(height)} tall, ${String(depth)} long`
    const example: WorkedExample = {
        prompt: entry.subject,
        reply: opsToCode(spec, entry.notes === '' ? measured : `${name}: ${entry.notes}`)
    }
    return {example, fits: !overBudget(example)}
}

/**
 * The examples a batch is taught from, in the order they are sent as prior turns.
 *
 * Two rules, both here so neither can drift from the other:
 *
 * 1. **Closest last.** The picking call answers closest-first, and the turn nearest the prompt is
 *    the one the model imitates hardest. That is reasoning, not a measurement — nothing has
 *    compared the two orders.
 * 2. **The artist's own model goes after the bank**, nearer the prompt still, because a model they
 *    chose deliberately outranks one an id lookup found for them.
 *
 * The budget filter is here as well rather than at either source, so a teaching set can never be
 * larger than what was measured to fit however it was assembled.
 */
export const teachingSet = (
    fromBank: readonly WorkedExample[],
    reference: WorkedExample | undefined
): readonly WorkedExample[] =>
    [...fromBank]
        .reverse()
        .concat(reference ? [reference] : [])
        .filter(one => !overBudget(one))
