import {DEFAULT_FLAGS, type Flags} from './flags'

/**
 * Letting the model choose which language a subject wants — one, or none.
 *
 * `src/gen/` now has four languages a reply can be written in, and exactly one of them fits any
 * given subject: a fish is an outline, a tree is a generator, a knight is joined parts, a brick block
 * is a surface. Asking the artist to know which is asking them to have read this directory.
 *
 * **It picks a language, never a set of flags, and that restriction is the whole design.** The
 * measurement behind it is in `docs/GEN_RESEARCH.md`, 2026-08-09: the example picking call is honest
 * about easy subjects and **pads when it is unsure** — `a knight` came back `farmer, chicken, dog`,
 * and three examples measured worse than one. A model asked "which of these should I use" over-
 * selects, and over-selecting here is not a wash but a contradiction: `relational` replaces the whole
 * example set, so `relational` and `faces` together send the face help with nothing demonstrating it.
 *
 * The other three experiments are deliberately out of reach. `repair`, `gates` and `retryEmpty` are
 * about what to do with output that came back broken, not about the subject, so the model has
 * nothing to say about them and is not asked. They stay the artist's.
 */
export type Language = 'silhouette' | 'procedural' | 'relational' | 'faces'

export const LANGUAGES: readonly Language[] = ['faces', 'silhouette', 'procedural', 'relational']

/**
 * What each language is for, in the words the model is shown.
 *
 * Written as *subjects*, not as mechanisms. The call is a one-word classification of the prompt —
 * which is the shape of question that measures well — and "a block, a tile, a crate" is something a
 * model can match a prompt against, where "paints one voxel deep on a side of the bounding box" is
 * not.
 */
export const LANGUAGE_USE: Readonly<Record<Language, string>> = {
    faces: 'a block, tile, crate, chest, sign or prop — its shape is a plain box and everything about it is the pattern on its faces',
    silhouette:
        'a body whose shape is one smooth curved outline — a fish, a mushroom, a vase, an egg, a pot',
    procedural: 'a tree, a bush, a plant, a tower, a building, a wall, a rock or a boulder',
    relational:
        'a figure or an animal built from joined parts — a dog, a knight, a chicken, a farmer'
}

/** What the model is asked, once per batch. Built from the table above so an entry needs no code. */
export const autoPrompt = (): string => {
    const width = Math.max(...LANGUAGES.map(name => name.length))
    const lines = LANGUAGES.map(name => `${name.padEnd(width)}  ${LANGUAGE_USE[name]}`)
    return `Which one of these best describes the subject? Reply with a single word from this list, or "none".

${lines.join('\n')}
none${' '.repeat(width - 4)}  anything else

Answer with one word only, nothing else.`
}

/**
 * The language a reply named, or `undefined` for "none" and for anything unrecognised.
 *
 * The first known word wins rather than requiring the whole reply to be one word, because a model
 * that answers "faces" and a model that answers "faces." have said the same thing. Everything else
 * is `undefined`, which is the honest reading of a reply that did not choose: **no language is a
 * real answer here**, and it is the right one for a subject none of the four was built for.
 */
export const readLanguage = (value: string): Language | undefined => {
    for (const word of value.toLowerCase().split(/[^a-z]+/)) {
        if (word === 'none') return undefined
        const found = LANGUAGES.find(name => name === word)
        if (found !== undefined) return found
    }
    return undefined
}

/**
 * The flags a batch actually runs under.
 *
 * With `auto` off this is the identity, and that matters more than it looks: every measurement in
 * `docs/GEN_RESEARCH.md` was taken with the switches meaning exactly what they say, and a resolve
 * step that quietly edited them would invalidate the record it is measured against.
 *
 * With `auto` on the chosen language is turned on and **the other three are turned off**, whatever
 * the artist left switched. That is what auto means, and it is also the only way to keep the
 * contradiction out: two languages on at once is a prompt describing one and examples teaching
 * another. The four policy flags are copied through untouched.
 */
export const resolveFlags = (flags: Flags, chosen: Language | undefined): Flags => {
    if (!flags.auto) return flags
    return {
        ...flags,
        silhouette: chosen === 'silhouette',
        procedural: chosen === 'procedural',
        relational: chosen === 'relational',
        faces: chosen === 'faces'
    }
}

/** Whether asking is worth a call at all. Nothing to choose between with `auto` off. */
export const asking = (flags: Flags): boolean => flags.auto

/** What the status line says a batch chose, or an empty string when it chose nothing. */
export const autoNote = (chosen: Language | undefined, flags: Flags): string => {
    if (!flags.auto) return ''
    return chosen === undefined ? 'Auto: no language fits this subject' : `Auto: ${chosen}`
}

/** Every language off, for a caller that wants the plain generator. */
export const NO_LANGUAGE: Flags = {
    ...DEFAULT_FLAGS,
    silhouette: false,
    procedural: false,
    relational: false,
    faces: false
}
