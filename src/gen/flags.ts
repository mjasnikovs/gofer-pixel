import type {Store} from '../doc/store'

/**
 * The experiments, as switches an artist can turn on one at a time.
 *
 * `docs/GEN_IDEAS.md` is eleven directions and none of them is measured. That is the whole reason
 * this file exists: the record in `docs/GEN_RESEARCH.md` was built by changing one thing and
 * rendering three fixed seeds against the live server, and an idea wired in permanently cannot be
 * measured that way — it becomes the baseline before anybody has looked at it.
 *
 * So every experiment lands behind a flag, and **every flag is off by default**. Off is the ground
 * the findings were walked on. A flag that defaults on is not an experiment, it is a decision that
 * skipped its measurement, and the way one graduates is that the numbers go in `GEN_RESEARCH.md` and
 * the flag is deleted along with the code path it guarded.
 *
 * They are remembered in `localStorage` rather than held in `Ask`, and the difference is deliberate.
 * `Ask` is what the artist wants of *this batch* — the prompt, the count, the canvas — and it is
 * reset and re-thought each time the dialog opens. A flag is which build of the generator they are
 * running, so it has to survive a reload: half a measurement is comparing three seeds before lunch
 * against three seeds after it, and a switch that forgot itself over the reload in between would
 * silently compare the flag against itself.
 *
 * Nothing here reaches the `.gpix`. That is a gap and it is an honest one: a candidate made with
 * `silhouette` on is not reproducible from its record, the same way `enforcePalette` is not. When an
 * experiment graduates it stops being a flag, and until it does, a file that recorded one would be
 * recording the name of a code path that is about to be deleted.
 */
export interface Flags {
    /**
     * Let the model choose which language the subject wants — see `gen/auto.ts`.
     *
     * One cheap call per batch, and it **overrides the four language switches below**: whichever it
     * names is turned on and the other three off. The four policy switches — repair, gates, retry,
     * one example — are untouched, because they are about broken output rather than about the
     * subject and the model has nothing to say about them.
     *
     * It picks one language or none, never a set. The picking call is measured to pad when it is
     * unsure (`GEN_RESEARCH.md`, 2026-08-09) and here padding is not a wash but a contradiction:
     * `relational` replaces the example set, so two languages on at once is a prompt describing one
     * and examples teaching another.
     */
    readonly auto: boolean
    /**
     * §1 — repair the volume in code before anything ranks it. `gen/repair.ts`.
     *
     * Deterministic, no model call: drop debris, close a one-voxel gap, put the feet on the floor.
     * The cheapest idea on the page and the one with the most obvious way to be wrong — a rule that
     * fires on a good model is worse than a failure that is honest.
     */
    readonly repair: boolean
    /**
     * §4 — discard a candidate that fails a hard structural gate and spend another seed. `gen/gate.ts`.
     *
     * Rejection sampling, not the dead revision loop: nothing is fed back and the model is never
     * told. It costs wall clock, which is already 7–20 s a candidate, and the resample cap is part
     * of the design — the record has a prompt that failed 8 of 8, and that prompt must not loop.
     */
    readonly gates: boolean
    /**
     * §3 — two silhouettes, extruded and intersected. `gen/shape.ts`.
     *
     * The only experiment here that could change how the output *looks* rather than how often it
     * holds together. `front`/`side` are two more functions in the reply's scope and they emit the
     * same box ops as everything else, so nothing downstream learns a new word.
     */
    readonly silhouette: boolean
    /**
     * §2 — parts and attachments instead of absolute coordinates. `gen/rig.ts`.
     *
     * The one that attacks the diagnosis rather than a symptom. It also replaces the worked
     * examples, which are measured to be the ceiling in both directions (finding 7), so it is the
     * flag most likely to be worse than off until its examples are good.
     */
    readonly relational: boolean
    /**
     * The face language — a block, a tile, a crate. `gen/face.ts`.
     *
     * Not from `GEN_IDEAS.md`: it comes out of the brick measurement on 2026-08-11, which found that
     * the model draws a Mario block perfectly well and three separate parts of this pipeline throw it
     * away. A prop's information is on its faces, and until this existed nothing in `src/gen/` could
     * address one — so the model painted mortar lines through the middle of a solid cube.
     *
     * It is the only experiment that changes the *scoring*, and it has to: a reply that called `face`
     * has declared its content is on its surface, so `overallScore` stops ranking by silhouette and
     * `gate.ts` stops calling it a brick for being solid.
     */
    readonly faces: boolean
    /**
     * §6 — procedural generators for the subjects that have one. `gen/grow.ts`.
     *
     * `tree`, `tower`, `rock`: four numbers from the model, four hundred voxels of branch from code.
     * Aimed squarely at finding 4 — organic and architectural subjects are the ones that work, and
     * they are also the two things procedural generation solved forty years ago.
     */
    readonly procedural: boolean
    /**
     * §11 — one retry when the reply painted nothing.
     *
     * The one strong positive in 3DCodeBench: error-feedback retry took executability from 70.2 %
     * to 97.4 % across every model size. Distinct from feeding a *render* back, which the same paper
     * found does nothing for geometry and which died here three times.
     */
    readonly retryEmpty: boolean
    /**
     * §8 — show the batch one worked example instead of up to three.
     *
     * Measured 2026-08-09 and the measurement says one: the picking call pads when it is unsure, so
     * `a knight` got `farmer, chicken, dog` and grew the chicken's comb on the helmet. It is a flag
     * rather than a changed constant only so that the before and after are one click apart.
     */
    readonly onePick: boolean
}

export const DEFAULT_FLAGS: Flags = {
    auto: false,
    repair: false,
    gates: false,
    silhouette: false,
    relational: false,
    procedural: false,
    faces: false,
    retryEmpty: false,
    onePick: false
}

/**
 * The order they are drawn in, with what each one is for.
 *
 * A list rather than the object's own key order, because the dialog draws them cheapest-first —
 * which is the order `GEN_IDEAS.md` recommends taking them in, and the order somebody switching
 * things on to see what happens should meet them in.
 *
 * `note` is one line because it is a subtitle under a switch, not documentation. The documentation
 * is the doc comment on the field, and `where` is the pointer to the code so that a switch nobody
 * remembers can be read rather than guessed at.
 */
export interface FlagNote {
    readonly key: keyof Flags
    readonly title: string
    readonly note: string
    readonly where: string
}

export const FLAG_NOTES: readonly FlagNote[] = [
    {
        key: 'auto',
        title: 'Pick the language automatically',
        note: 'One call per batch chooses one of the four languages below, or none, from the prompt.',
        where: 'gen/auto.ts'
    },
    {
        key: 'repair',
        title: 'Repair the volume',
        note: 'Drop debris, close one-voxel gaps, put the feet on the floor.',
        where: 'gen/repair.ts'
    },
    {
        key: 'gates',
        title: 'Reject and resample',
        note: 'Throw away a candidate that is debris or a brick, and spend another seed.',
        where: 'gen/gate.ts'
    },
    {
        key: 'onePick',
        title: 'One worked example',
        note: 'Teach with the closest example only. Measured better; three grew a comb on a knight.',
        where: 'gen/bank.ts'
    },
    {
        key: 'retryEmpty',
        title: 'Retry an empty reply',
        note: 'One more call, carrying the error, when the reply painted nothing.',
        where: 'gen/llama.ts'
    },
    {
        key: 'faces',
        title: 'Face language',
        note: 'face() paints a pattern on one side — a block, a tile, a crate. Also changes the scoring.',
        where: 'gen/face.ts'
    },
    {
        key: 'silhouette',
        title: 'Silhouette ops',
        note: 'front() and side(), extruded and intersected — curved outlines instead of boxes.',
        where: 'gen/shape.ts'
    },
    {
        key: 'procedural',
        title: 'Procedural ops',
        note: 'tree(), tower() and rock() — the model picks numbers, code grows the geometry.',
        where: 'gen/grow.ts'
    },
    {
        key: 'relational',
        title: 'Relational language',
        note: 'Parts and attachments instead of coordinates. Replaces the worked examples.',
        where: 'gen/rig.ts'
    }
]

/** Whether any experiment is on, which is the one thing the dialog's summary line needs. */
export const experimenting = (flags: Flags): boolean => Object.values(flags).some(on => on)

/** The ids of the experiments that are on, cheapest-first, for a status line and for a bug report. */
export const flagsOn = (flags: Flags): readonly string[] =>
    FLAG_NOTES.filter(({key}) => flags[key]).map(({key}) => key)

const KEY = 'gofer-pixel/flags'

/**
 * What was switched on last time, with anything unrecognised treated as off.
 *
 * Unrecognised covers three real cases and they all mean the same thing: a flag that graduated and
 * was deleted, a flag from a branch this build does not have, and a hand-edited value that is not a
 * boolean. An experiment nobody can see in the dialog must not be running, so the answer to all
 * three is `false` — the switch is the only thing allowed to turn an experiment on.
 */
export const readFlags = (store: Store): Flags => {
    const held = store.get(KEY)
    if (held === undefined) return DEFAULT_FLAGS
    let parsed: unknown
    try {
        parsed = JSON.parse(held)
    } catch {
        return DEFAULT_FLAGS
    }
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_FLAGS
    const read = parsed as Record<string, unknown>
    const out = {...DEFAULT_FLAGS} as Record<keyof Flags, boolean>
    for (const {key} of FLAG_NOTES) out[key] = read[key] === true
    return out
}

export const writeFlags = (store: Store, flags: Flags): void => {
    store.set(KEY, JSON.stringify(flags))
}

/** One switch moved, remembered, and handed back. */
export const flip = (store: Store, flags: Flags, key: keyof Flags, on: boolean): Flags => {
    const next = {...flags, [key]: on}
    writeFlags(store, next)
    return next
}

/** Every experiment off, remembered. The way out of a batch nobody can explain. */
export const resetFlags = (store: Store): Flags => {
    writeFlags(store, DEFAULT_FLAGS)
    return DEFAULT_FLAGS
}
