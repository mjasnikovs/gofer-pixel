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

export interface Files {
    /**
     * `accept` is a comma-separated extension list, as an `<input accept>` takes.
     * `undefined` when the artist cancels, which is not an error and must not read like one.
     */
    open: (accept: string) => Promise<PickedFile | undefined>
    /**
     * Write `text` as `name`. `reuse` asks to write back over the file this port last opened or
     * saved, without a dialog; it is honoured only when `overwrites` is true and there is such a
     * file, and falls back to asking otherwise.
     *
     * Returns the name actually written — the picker lets the artist rename — or `undefined` on
     * cancel.
     */
    save: (name: string, text: string, reuse: boolean) => Promise<string | undefined>
    /** Whether `reuse` can really overwrite. False on the download path. */
    readonly overwrites: boolean
    /** Forget the file being written back to, so the next Save asks. `new` calls it. */
    forget: () => void
}

/** What the picker is told a `.gpix` is. */
export const PROJECT_EXTENSION = '.gpix'
export const PROJECT_ACCEPT = '.gpix,.vox'
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

const pickerTypes = (accept: string) => [
    {
        description: 'gofer-pixel project',
        accept: {[PROJECT_TYPE]: accept.split(',').map(part => part.trim())}
    }
]

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

const anchorSave = (name: string, text: string): string => {
    const url = URL.createObjectURL(new Blob([text], {type: PROJECT_TYPE}))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    URL.revokeObjectURL(url)
    return name
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

        open: async accept => {
            const showOpen = picker.showOpenFilePicker
            if (!showOpen) return inputOpen(accept)
            try {
                const [handle] = await showOpen({types: pickerTypes(accept), multiple: false})
                if (!handle) return undefined
                const file = await handle.getFile()
                // Only a project is worth writing back to. A `.vox` opened through here becomes an
                // untitled document, and Save must ask rather than overwrite somebody's model with
                // JSON that MagicaVoxel cannot read.
                held = file.name.endsWith(PROJECT_EXTENSION) ? handle : undefined
                return picked(file.name, new Uint8Array(await file.arrayBuffer()))
            } catch {
                // A cancelled picker throws `AbortError`, and so does a page that has lost user
                // activation. Neither is a failure the artist should be told about.
                return undefined
            }
        },

        save: async (name, text, reuse) => {
            const showSave = picker.showSaveFilePicker
            if (!showSave) return anchorSave(name, text)
            try {
                const handle =
                    reuse && held ? held : (
                        await showSave({
                            suggestedName: name,
                            types: pickerTypes(PROJECT_EXTENSION)
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
    backing = new Map<string, string>(),
    /** What the picker "chooses". `undefined` stands for a cancelled dialog. */
    choose: (suggested: string) => string | undefined = suggested => suggested
): Files => {
    let held: string | undefined

    return {
        overwrites: true,

        forget: () => {
            held = undefined
        },

        open: async accept => {
            const wanted = accept.split(',').map(part => part.trim())
            const name = [...backing.keys()].find(key =>
                wanted.some(extension => key.endsWith(extension))
            )
            const text = name === undefined ? undefined : backing.get(name)
            if (name === undefined || text === undefined) return undefined
            held = name.endsWith(PROJECT_EXTENSION) ? name : undefined
            return Promise.resolve(picked(name, new TextEncoder().encode(text)))
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
