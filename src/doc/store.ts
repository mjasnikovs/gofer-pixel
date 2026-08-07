import type {SavedDocument} from './save'

/**
 * Where autosaves and snapshots live — `FEATURESET.md` §32.
 *
 * An interface rather than a direct call to `localStorage`, so the rotation below is a plain
 * function a `bun test` drives against a `Map`. Which is the point: the thing that can lose an
 * artist's work is the rotation, not the browser API, and testing it must not need a browser.
 */
export interface Store {
    get: (key: string) => string | undefined
    set: (key: string, value: string) => void
    remove: (key: string) => void
    keys: () => readonly string[]
}

export const memoryStore = (backing = new Map<string, string>()): Store => ({
    get: key => backing.get(key),
    set: (key, value) => {
        backing.set(key, value)
    },
    remove: key => {
        backing.delete(key)
    },
    keys: () => [...backing.keys()]
})

/**
 * `localStorage`, or nothing at all.
 *
 * A private window, a storage quota and a browser with the feature switched off all fail here, and
 * all three should cost the artist a missing autosave rather than a window that will not open — so
 * every call is guarded and a failure is silent by design.
 */
export const browserStore = (): Store => {
    const backing = globalThis.localStorage as Storage | undefined
    if (!backing) return memoryStore()
    return {
        get: key => backing.getItem(key) ?? undefined,
        set: (key, value) => {
            try {
                backing.setItem(key, value)
            } catch {
                // Out of quota. The snapshot rotation below is what stops that being permanent.
            }
        },
        remove: key => {
            backing.removeItem(key)
        },
        keys: () => Object.keys(backing)
    }
}

const PREFIX = 'gofer-pixel/snapshot/'

/**
 * How many snapshots are kept.
 *
 * Five, because the question an artist asks is "what did this look like before I ruined it", and
 * the answer is nearly always one of the last few. Undo already covers the last 512 *strokes*;
 * these cover the last few *sessions*, which is the case undo cannot — a browser that was closed.
 */
export const SNAPSHOTS = 5

export interface Snapshot {
    readonly key: string
    readonly at: number
    readonly name: string
}

/** Newest first, which is the order anyone reads a list of restore points in. */
export const snapshots = (store: Store): readonly Snapshot[] =>
    store
        .keys()
        .filter(key => key.startsWith(PREFIX))
        .map(key => {
            const stamp = Number(key.slice(PREFIX.length).split('/')[0] ?? '0')
            return {key, at: Number.isFinite(stamp) ? stamp : 0, name: nameOf(store, key)}
        })
        .sort((a, b) => b.at - a.at)

const nameOf = (store: Store, key: string): string => {
    const text = store.get(key)
    if (!text) return 'Snapshot'
    // Read out of the JSON without parsing megabytes of base64 back into a document.
    const found = /"name":"((?:[^"\\]|\\.)*)"/.exec(text)
    return found?.[1] ?? 'Snapshot'
}

/**
 * Write a snapshot and drop the oldest beyond the limit.
 *
 * The write happens before the trim, so a store that is full fails on the *new* snapshot and
 * leaves every old one intact. Trimming first would clear space by throwing away the artist's
 * history and then fail to write the thing it made room for.
 */
export const putSnapshot = (store: Store, document: SavedDocument): void => {
    store.set(`${PREFIX}${String(document.at)}`, JSON.stringify(document))
    for (const stale of snapshots(store).slice(SNAPSHOTS)) store.remove(stale.key)
}

export const latestSnapshot = (store: Store): string | undefined => {
    const newest = snapshots(store)[0]
    return newest ? store.get(newest.key) : undefined
}

export const clearSnapshots = (store: Store): void => {
    for (const entry of snapshots(store)) store.remove(entry.key)
}
