import MANIFEST from '../assets/examples/examples.json'
import {volumeFromFile} from '../doc/models'
import type {Volume} from '../render/volume'
import {exampleFrom, readManifest, type BankEntry, type Manifest, type WorkedExample} from './bank'
import {BUILT_IN_REPLIES} from './builtin'

/**
 * The bank, loaded: every manifest entry resolved to the example it teaches with.
 *
 * Loading happens at run time, not at build time. A build step would mean rebuilding the app to
 * change a teacher, and the whole point of moving the examples onto disk was that swapping one
 * costs a file copy. Decomposition is cheap enough to pay for on the way in — `car.vox`, 478
 * voxels, comes apart in about a millisecond.
 */
export interface Library {
    readonly manifest: Manifest
    readonly example: (id: string) => WorkedExample | undefined
    /**
     * The examples for a pick, as prior turns, in the order they should be sent.
     *
     * **Reversed from the order they were picked in.** The picking call answers closest-first, and
     * the turn nearest the prompt is the one the model imitates hardest, so the closest example
     * goes last. That is reasoning, not a measurement — nothing has compared the two orders.
     */
    readonly teach: (ids: readonly string[]) => readonly WorkedExample[]
}

/** Reads one model out of the bank directory. `undefined` for anything that will not load. */
export type ModelSource = (file: string) => Promise<Volume | undefined>

const resolve = async (
    entry: BankEntry,
    source: ModelSource
): Promise<WorkedExample | undefined> => {
    if (entry.file !== undefined) {
        const volume = await source(entry.file)
        // A named file that will not load falls through to the built-in rather than dropping the
        // entry. A missing teacher is a worse outcome than a stale one — see `readPicks`.
        if (volume) return exampleFrom(entry, volume)
    }
    const reply = BUILT_IN_REPLIES[entry.id]
    return reply === undefined ? undefined : {prompt: entry.subject, reply}
}

export const buildLibrary = async (manifest: Manifest, source: ModelSource): Promise<Library> => {
    const examples = new Map<string, WorkedExample>()
    for (const entry of manifest.entries) {
        const example = await resolve(entry, source)
        if (example) examples.set(entry.id, example)
    }
    return {
        manifest,
        example: id => examples.get(id),
        teach: ids =>
            ids
                .map(id => examples.get(id))
                .filter((example): example is WorkedExample => example !== undefined)
                .reverse()
    }
}

/**
 * The bank directory, as the bundler sees it.
 *
 * `import.meta.glob` is a Vite transform: in the app the call below is *replaced* by a literal map
 * of paths to URLs before the code ever runs. Outside Vite — `bun test` — there is no such function,
 * so the guard returns a source that finds nothing and every entry falls back to its built-in
 * reply. That is the right answer for a test rather than a workaround for one: a test that asserted
 * on decomposed assets would be asserting on whatever happened to be in the directory.
 *
 * Eager, because the manifest is small and a lazy import per entry would turn one load into five
 * round trips.
 */
export const bundledSource = (
    decode: (name: string, bytes: Uint8Array) => Volume | undefined
): ModelSource => {
    /*
     * `try`, not a feature check. `import.meta.glob` is not a function anybody calls — Vite
     * *replaces the call expression* with a literal map before the code runs, so reading
     * `import.meta.glob` as a property is `undefined` in the browser too and a guard written that
     * way switches the bank off in the one place it is meant to work. Measured 2026-08-09: it did,
     * silently, and every entry fell back to its built-in reply.
     *
     * Outside Vite the call survives to run time and throws, which is what this catches.
     */
    let urls: Record<string, string> = {}
    try {
        urls = import.meta.glob('../assets/examples/*.{vox,gpix}', {
            query: '?url',
            import: 'default',
            eager: true
        })
    } catch {
        return () => Promise.resolve(undefined)
    }

    return async file => {
        const key = Object.keys(urls).find(path => path.endsWith(`/${file}`))
        const url = key === undefined ? undefined : urls[key]
        if (url === undefined) return undefined
        try {
            const response = await fetch(url)
            if (!response.ok) return undefined
            return decode(file, new Uint8Array(await response.arrayBuffer()))
        } catch {
            return undefined
        }
    }
}

/**
 * The app's own bank: the checked-in manifest, the checked-in directory, one load per session.
 *
 * Memoised because the dialog is opened and closed repeatedly and the decomposition is the same
 * every time. A `Promise`, so two dialogs opened before the first load lands share one.
 */
let held: Promise<Library> | undefined

export const defaultLibrary = (): Promise<Library> => {
    held ??= (async () => {
        const manifest = readManifest(MANIFEST)
        if (!manifest) throw new Error('src/assets/examples/examples.json is not a manifest')
        return buildLibrary(manifest, bundledSource(volumeFromFile))
    })()
    return held
}
