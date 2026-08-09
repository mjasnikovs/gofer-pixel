import type {Axis} from './brush'

/**
 * A picture to build against — `FEATURESET.md` §33.
 *
 * One per plane, stretched to the grid's own box in that plane, so an artist who drew a 32×32 front
 * view gets it lined up with a 32-wide model without doing arithmetic. It is a `data:` URL rather
 * than a path, because a document that referred to a file on disk would open blank on the next
 * machine, and it is not part of the model: nothing here is ever rendered into a sprite.
 *
 * It lives in `doc/` rather than in `app/state.ts` because `doc/save.ts` writes it into the file,
 * and the format may not reach up into the app to find out what it is holding.
 */
export interface Reference {
    readonly plane: Axis
    readonly url: string
    readonly opacity: number
    /** Locked means the panel will not change or drop it — `FEATURESET.md` §33's "lock it". */
    readonly locked: boolean
}

/**
 * What a lock refuses, in one predicate.
 *
 * It used to be three different spellings in three reducer cases — `&& !entry.locked` in one,
 * `|| entry.locked` in another, deliberately ignored in a third — and *absent from the fourth*, so
 * dropping a new picture onto a locked plane quietly replaced the one the artist had locked. One
 * line now, and the four operations below all ask it.
 *
 * Unlocking is the exception and has to be: a lock that could not be undone is a trap.
 */
const refuses = (entry: Reference | undefined): boolean => entry?.locked === true

const onPlane = (references: readonly Reference[], plane: Axis): Reference | undefined =>
    references.find(entry => entry.plane === plane)

/**
 * A picture on a plane — one per plane, so a second drop on the front replaces the first.
 *
 * Two pictures of the front stacked on each other is not something anyone asked for, and the artist
 * plainly meant the new one. Unless they locked the old one, which is exactly the sentence
 * `FEATURESET.md` §33 writes as "lock it".
 */
export const place = (
    references: readonly Reference[],
    plane: Axis,
    url: string
): readonly Reference[] =>
    refuses(onPlane(references, plane)) ? references : (
        [
            ...references.filter(entry => entry.plane !== plane),
            {plane, url, opacity: 0.5, locked: false}
        ]
    )

/** How strongly the picture shows through. Clamped here, so no caller can put it out of range. */
export const fade = (
    references: readonly Reference[],
    plane: Axis,
    opacity: number
): readonly Reference[] =>
    references.map(entry =>
        entry.plane === plane && !refuses(entry) ?
            {...entry, opacity: Math.min(1, Math.max(0, opacity))}
        :   entry
    )

export const lock = (
    references: readonly Reference[],
    plane: Axis,
    on: boolean
): readonly Reference[] =>
    references.map(entry => (entry.plane === plane ? {...entry, locked: on} : entry))

export const drop = (references: readonly Reference[], plane: Axis): readonly Reference[] =>
    references.filter(entry => entry.plane !== plane || refuses(entry))

const isAxis = (value: unknown): value is Axis => value === 0 || value === 1 || value === 2

/**
 * A reference off a file, or `undefined`.
 *
 * Every field checked, like everything else `loadDocument` reads: a reference with a missing plane
 * would draw somewhere the artist never put it, and one with a URL that is not a `data:` URL would
 * either be a dead `blob:` from another session or an outbound request from a document somebody
 * else wrote. Both are refused here rather than in the layer that draws it.
 */
export const readReference = (value: unknown): Reference | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const {plane, url, opacity, locked} = value as Record<string, unknown>
    if (!isAxis(plane)) return undefined
    if (typeof url !== 'string' || !url.startsWith('data:image/')) return undefined
    if (typeof opacity !== 'number' || !(opacity >= 0 && opacity <= 1)) return undefined
    return {plane, url, opacity, locked: locked === true}
}
