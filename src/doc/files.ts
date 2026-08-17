/**
 * The disk, behind a port.
 *
 * The same shape as `doc/store.ts`, and for the same reason: the thing that can lose an artist's
 * work is the logic around the write — which file, overwrite or not, what happens when the picker
 * is cancelled — not the browser API. So that logic sits behind an interface a `bun test` drives
 * against a `Map`, and the browser implementation stays thin enough to read in one sitting.
 *
 * Two implementations of `save` are unavoidable, because the platform has two:
 *
 * - **The File System Access API.** `showSaveFilePicker` hands back a handle, the handle is kept,
 *   and every later Save writes through it with no dialog. Chrome and Edge 105+ only — Firefox has
 *   recorded its position on the spec as "harmful" and Safari has never shipped it.
 * - **An anchor with a `download` attribute**, which every browser has had for a decade. It cannot
 *   overwrite anything, so each Save lands as another file in the downloads folder.
 *
 * `overwrites` is how the caller tells the difference, because the menu has to stop promising a
 * Save that overwrites when it does not.
 */

/**
 * What came back off the disk. `name` is the file's own, which becomes the document's.
 *
 * Bytes as well as text, because the same picker opens a `.gpix` — JSON — and a `.vox`, which is a
 * RIFF container full of arbitrary bytes. Reading that as text and encoding it back would corrupt
 * every byte above 0x7f, quietly, and the model would come out wrong rather than fail to open.
 */
export interface PickedFile {
    readonly name: string
    readonly bytes: Uint8Array
    /** The bytes decoded as UTF-8. Meaningless for a binary file, which is what `bytes` is for. */
    readonly text: string
}

const picked = (name: string, bytes: Uint8Array): PickedFile => ({
    name,
    bytes,
    text: new TextDecoder().decode(bytes)
})

/**
 * What a read is for, as far as this port is concerned.
 *
 * `remember` is the whole of it, and it is a *caller's* fact rather than the adapter's. Both
 * implementations used to sniff the extension — `if (name.endsWith('.gpix')) held = handle` —
 * which meant one rule written twice, and it meant a `.gpix` opened for anything other than the
 * project quietly became the file Save wrote the project back over. That was found through the
 * generate dialog's reference model, which is gone; the rule outlives it, because a palette read
 * and every reader added later have the same shape. Only the project picker asks to be remembered,
 * so only the project picker says so.
 */
export interface ReadFor {
    /** What the native picker calls this file kind in its own filter row. Nothing else. */
    readonly description?: string
    /** Whether this read becomes the file `save(…, reuse)` writes back to. Default false. */
    readonly remember?: boolean
}

export interface Files {
    /**
     * `accept` is a comma-separated extension list, as an `<input accept>` takes.
     * `undefined` when the artist cancels, which is not an error and must not read like one.
     *
     * Two things read a file off the artist's disk — the project picker and the palette loader —
     * and both come through here. Exactly one of them passes `remember`, which is why both can
     * share one instance of this port. There was a third, the generate dialog's reference model,
     * and it went with `src/gen/`.
     */
    open: (accept: string, read?: ReadFor) => Promise<PickedFile | undefined>
    /**
     * Write `text` as `name`. `reuse` asks to write back over the file this port last opened or
     * saved, without a dialog; it is honoured only when `overwrites` is true and there is such a
     * file, and falls back to asking otherwise.
     *
     * Returns the name actually written — the picker lets the artist rename — or `undefined` on
     * cancel.
     */
    save: (name: string, text: string, reuse: boolean) => Promise<string | undefined>
    /**
     * Hand a finished file to wherever the platform puts downloads. No dialog, no handle, no cancel.
     *
     * The other half of this port, and deliberately not `save`. `save` is the *document*: it has a
     * picker, a remembered handle, and a cancel that must never read like a success. An export has
     * none of those — it is up to nine files at once, named by what they are, and the artist said
     * yes on the click that baked them. Folding the two together would put a cancel that cannot
     * happen in front of the one write that never asks.
     *
     * `data` is bytes for a PNG and text for the palette and the metadata JSON, because the two
     * kinds come off the same click and a port that took only text could not carry the sheet — which
     * is exactly why every export used to go round this interface straight to an anchor.
     */
    write: (name: string, data: string | Uint8Array, type: string) => Promise<void>
    /** Whether `reuse` can really overwrite. False on the download path. */
    readonly overwrites: boolean
    /** Forget the file being written back to, so the next Save asks. `new` calls it. */
    forget: () => void
}

/** What the picker is told a `.gpix` is. */
export const PROJECT_EXTENSION = '.gpix'
export const PROJECT_ACCEPT = '.gpix,.vox'
/** What a `.hex` palette can arrive as — `FEATURESET.md` §7. Lospec writes `.txt` as often as `.hex`. */
export const PALETTE_ACCEPT = '.hex,.txt'
const PROJECT_TYPE = 'application/json'

/**
 * What Save should call this document.
 *
 * A `.vox` that was opened and edited saves as `car.gpix`, never back over `car.vox` — this app
 * cannot write MagicaVoxel's format, and offering to would be offering to destroy the file.
 */
export const projectName = (name: string): string =>
    name.endsWith(PROJECT_EXTENSION) ? name : (
        `${name.replace(/\.[^.]*$/, '') || 'untitled'}${PROJECT_EXTENSION}`
    )

/*
 * The File System Access API, typed here rather than pulled in as a lib.
 *
 * `tsconfig`'s DOM lib does not carry it — it is an unofficial spec two of the four engines refuse
 * — and the alternative to fifteen lines of declaration is `any` at exactly the boundary where a
 * wrong assumption costs a file.
 */
interface WritableFile {
    write: (data: string) => Promise<void>
    close: () => Promise<void>
}

interface FileHandle {
    readonly name: string
    getFile: () => Promise<File>
    createWritable: () => Promise<WritableFile>
}

interface Picker {
    showOpenFilePicker?: (options: {
        types: {description: string; accept: Record<string, string[]>}[]
        multiple: boolean
    }) => Promise<FileHandle[]>
    showSaveFilePicker?: (options: {
        suggestedName: string
        types: {description: string; accept: Record<string, string[]>}[]
    }) => Promise<FileHandle>
}

/**
 * What the File System Access API wants: extensions grouped under a MIME type.
 *
 * The MIME matters — Chrome rejects a filter whose type it does not recognise, and the picker then
 * throws where a caller expects a cancel. An extension nobody has listed falls back to plain text,
 * which is what every text-ish thing this app reads actually is.
 */
const MIME: Readonly<Record<string, string>> = {
    '.gpix': PROJECT_TYPE,
    '.vox': 'application/octet-stream'
}

const pickerTypes = (accept: string, description: string) => {
    const grouped: Record<string, string[]> = {}
    for (const part of accept.split(',')) {
        const extension = part.trim()
        if (extension === '' || !extension.startsWith('.')) continue
        const type = MIME[extension] ?? 'text/plain'
        grouped[type] = [...(grouped[type] ?? []), extension]
    }
    return [{description, accept: grouped}]
}

/**
 * A file input, created, clicked and dropped.
 *
 * Not kept in the tree: a hidden input that lives in the layout is one more node for a bounding-box
 * test to trip over, and this is the same reasoning `App.tsx`'s image drop already follows.
 *
 * The promise resolves `undefined` on cancel. There is no cancel event on `<input type=file>` in
 * every engine, so a cancelled picker leaves this promise pending forever — which is correct
 * behaviour for a caller that only ever `await`s to decide what to open, and is why nothing here
 * holds a lock or a spinner while it waits.
 */
const inputOpen = async (accept: string): Promise<PickedFile | undefined> => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    const chosen = await new Promise<File | undefined>(resolve => {
        input.addEventListener('change', () => {
            resolve(input.files?.[0])
        })
        input.addEventListener('cancel', () => {
            resolve(undefined)
        })
        input.click()
    })
    if (!chosen) return undefined
    return picked(chosen.name, new Uint8Array(await chosen.arrayBuffer()))
}

/**
 * An anchor with a `download` attribute, created, clicked and dropped — the one way this platform
 * hands a file to the operating system without a picker.
 *
 * One implementation, two callers: the fallback `save` for the browsers that have no
 * `showSaveFilePicker`, and `write`, which is every export. The export path used to build its own
 * copy of these six lines in `app/download.ts`, outside this port, which is why the whole of what an
 * artist actually ships could only be tested by replacing three globals.
 */
const anchorDownload = (name: string, data: string | Uint8Array, type: string): void => {
    const url = URL.createObjectURL(new Blob([data as BlobPart], {type}))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    URL.revokeObjectURL(url)
}

export const browserFiles = (): Files => {
    const picker = globalThis as unknown as Picker
    const overwrites = typeof picker.showSaveFilePicker === 'function'
    let held: FileHandle | undefined

    return {
        overwrites,

        forget: () => {
            held = undefined
        },

        write: (name, data, type) => {
            anchorDownload(name, data, type)
            return Promise.resolve()
        },

        open: async (accept, read) => {
            const showOpen = picker.showOpenFilePicker
            if (!showOpen) return inputOpen(accept)
            try {
                const [handle] = await showOpen({
                    types: pickerTypes(accept, read?.description ?? 'gofer-pixel project'),
                    multiple: false
                })
                if (!handle) return undefined
                const file = await handle.getFile()
                // Only a read that asked to be remembered is worth writing back to. A `.vox` opened
                // as a document becomes an untitled one — `forget` is the caller's to call — and a
                // palette or a reference model is not a document at all, so neither asks.
                if (read?.remember === true) held = handle
                return picked(file.name, new Uint8Array(await file.arrayBuffer()))
            } catch {
                // A cancelled picker throws `AbortError`, and so does a page that has lost user
                // activation. Neither is a failure the artist should be told about.
                return undefined
            }
        },

        save: async (name, text, reuse) => {
            const showSave = picker.showSaveFilePicker
            if (!showSave) {
                anchorDownload(name, text, PROJECT_TYPE)
                return name
            }
            try {
                const handle =
                    reuse && held ? held : (
                        await showSave({
                            suggestedName: name,
                            types: pickerTypes(PROJECT_EXTENSION, 'gofer-pixel project')
                        })
                    )
                const writable = await handle.createWritable()
                await writable.write(text)
                await writable.close()
                held = handle
                return handle.name
            } catch {
                return undefined
            }
        }
    }
}

/**
 * The disk as a `Map` — what `bun test` drives.
 *
 * `overwrites` is true, so the reuse path is the one under test. It is the path with the state in
 * it, and therefore the one that can go wrong.
 */
export const memoryFiles = (
    /**
     * The files on this disk. Bytes as well as text, because a `.vox` is binary and a `Map` of
     * strings cannot hold one — every byte above `0x7f` would come back as `U+FFFD`.
     */
    backing = new Map<string, string | Uint8Array>(),
    /** What the picker "chooses". `undefined` stands for a cancelled dialog. */
    choose: (suggested: string) => string | undefined = suggested => suggested
): Files => {
    let held: string | undefined

    return {
        overwrites: true,

        forget: () => {
            held = undefined
        },

        /*
         * Into the same map, under the name the writer chose. The test holds the map, so a claim
         * about an export is a claim about its bytes — which is what the anchor could never be
         * asked, because happy-dom hands back an opaque `blob:` handle and nothing can read it.
         */
        write: (name, data) => {
            backing.set(name, data)
            return Promise.resolve()
        },

        open: async (accept, read) => {
            const wanted = accept.split(',').map(part => part.trim())
            const name = [...backing.keys()].find(key =>
                wanted.some(extension => key.endsWith(extension))
            )
            const stored = name === undefined ? undefined : backing.get(name)
            if (name === undefined || stored === undefined) return undefined
            if (read?.remember === true) held = name
            return Promise.resolve(
                picked(name, typeof stored === 'string' ? new TextEncoder().encode(stored) : stored)
            )
        },

        save: async (name, text, reuse) => {
            const target = reuse && held !== undefined ? held : choose(name)
            if (target === undefined) return Promise.resolve(undefined)
            backing.set(target, text)
            held = target
            return Promise.resolve(target)
        }
    }
}
