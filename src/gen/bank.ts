/**
 * The worked-example bank: one directory of models, one manifest that describes them.
 *
 * The examples are the ceiling on everything the generator produces, measured twice on 2026-08-08
 * in both directions — a better example lifted every output and a deliberately worse one dragged
 * every output down to its own flaws. So they must be replaceable without touching code, which
 * means a directory and a manifest rather than string literals in a source file.
 *
 * An entry teaches with a real model when `file` names one, and with the built-in hand-typed reply
 * otherwise. Both paths end in the same thing — a prompt and a program — because the reply format
 * is code and a worked example in any other language teaches the wrong thing twice.
 */
export interface WorkedExample {
    /** The user turn: what was asked for. */
    readonly prompt: string
    /** The assistant turn: the program that draws it. */
    readonly reply: string
}

export interface BankEntry {
    /** What the picking call answers with. Short, lowercase, no spaces. */
    readonly id: string
    /** The subject this example is an answer to — `a dog`. Becomes the example's user turn. */
    readonly subject: string
    /** When to reach for it. One line, and it is what the picking call reads. */
    readonly use: string
    /**
     * The example's opening comment, in the artist's words.
     *
     * It is not decoration. Every hand-written example opens on proportions and the model imitates
     * planning before it draws — and a decomposer cannot read proportions out of voxels. Empty
     * falls back to the measurements alone, which is weaker.
     */
    readonly notes: string
    /** A `.vox` or `.gpix` beside the manifest. Absent means the built-in reply for this id. */
    readonly file?: string
}

export interface Manifest {
    /** The id used when the picking call answers with nothing recognisable. */
    readonly fallback: string
    readonly entries: readonly BankEntry[]
}

/**
 * How many examples one prompt may carry.
 *
 * Three, and it is **not measured**. Everything on the record was measured at one — finding 8 says
 * one example is not neutral, and nothing has ever compared one against several. Two plausible
 * failures are open: the examples average into a shape that is none of them, and the token cost
 * triples on every candidate in every batch. Measure before trusting it.
 */
export const MAX_PICKS = 3

/**
 * One example instead of three, when the `onePick` experiment is on — `gen/flags.ts`, §8.
 *
 * The measurement says one. Live on 2026-08-09 against three fixed seeds: `a knight` read as an
 * armoured figure 3 of 3 with one example and 0 of 3 with three, two of the three growing the
 * chicken example's red comb on the helmet. The picking call is honest about easy subjects and
 * **pads when it is unsure**, so the subjects that collect three examples are exactly the ones that
 * were already hard.
 *
 * It is a cap passed down the call rather than a different constant, because `pickPrompt` writes the
 * number into the sentence it sends the model: the cap and the prompt that states it have to move
 * together, and a flag that moved only one of them would ask for three and keep one.
 */
export const picksFor = (onePick: boolean): number => (onePick ? 1 : MAX_PICKS)

const isString = (value: unknown): value is string => typeof value === 'string' && value !== ''

const readEntry = (value: unknown): BankEntry | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const {id, subject, use, notes, file} = value as Record<string, unknown>
    if (!isString(id) || !isString(subject) || !isString(use)) return undefined
    if (!/^[a-z0-9]+$/.test(id)) return undefined
    return {
        id,
        subject,
        use,
        notes: isString(notes) ? notes : '',
        ...(isString(file) ? {file} : {})
    }
}

/**
 * The manifest, or `undefined` for anything that is not one.
 *
 * Checked field by field like every other file this app reads. An entry that will not read is
 * dropped rather than fatal: one malformed line should cost one teacher, not the whole bank.
 */
export const readManifest = (value: unknown): Manifest | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const {fallback, entries} = value as Record<string, unknown>
    if (!Array.isArray(entries)) return undefined
    const read = entries.map(readEntry).filter((entry): entry is BankEntry => entry !== undefined)
    if (read.length === 0) return undefined
    const named = isString(fallback) && read.some(entry => entry.id === fallback)
    return {
        // A bank with no usable fallback still has to answer, so the first entry stands in.
        fallback: named ? fallback : (read[0]?.id ?? ''),
        entries: read
    }
}

/**
 * The one call that picks the examples, built from the manifest rather than written by hand.
 *
 * Unconstrained on purpose: a short list of ids is inside what the model does reliably, and a
 * grammar here would buy nothing. Asked once per *batch* — which example fits is a property of the
 * subject, not of the seed — so it costs about two seconds against ten to twenty per candidate.
 */
export const pickPrompt = (manifest: Manifest, picks: number = MAX_PICKS): string => {
    const width = Math.max(...manifest.entries.map(entry => entry.id.length))
    const lines = manifest.entries.map(entry => `${entry.id.padEnd(width)}  ${entry.use}`)
    if (picks <= 1) {
        return `Which one of these examples is the subject most like? Reply with a single id from this list.

${lines.join('\n')}

Answer with one id only, nothing else.`
    }
    return `Which of these examples is the subject most like? Reply with up to ${String(picks)} ids from this list, closest first, separated by commas.

${lines.join('\n')}

Answer with ids only, nothing else.`
}

/**
 * The ids a reply names, in the order it named them, capped and deduplicated.
 *
 * Anything unrecognised is dropped, and a reply that names nothing falls back to one id rather than
 * to none: a prompt with no worked example in it is the 0-of-12 case from finding 7, and that is a
 * worse outcome than a badly chosen teacher.
 */
export const readPicks = (
    value: string,
    manifest: Manifest,
    picks: number = MAX_PICKS
): readonly string[] => {
    const known = new Set(manifest.entries.map(entry => entry.id))
    // The cap is enforced here as well as asked for: a model told "one id" that answers with three
    // must be held to one, or the experiment measures the prompt rather than the number.
    const cap = Math.max(1, Math.floor(picks))
    const out: string[] = []
    for (const word of value.toLowerCase().split(/[^a-z0-9]+/)) {
        if (!known.has(word) || out.includes(word)) continue
        out.push(word)
        if (out.length === cap) break
    }
    return out.length === 0 ? [manifest.fallback] : out
}
