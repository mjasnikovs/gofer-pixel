import {expect, test} from 'bun:test'
import {memoryFiles, type Files} from '../doc/files'
import {memoryStore} from '../doc/store'
import {loadDocument, saveDocument} from '../doc/save'
import {initialObjects} from '../doc/objects'
import {NO_SYMMETRY} from '../doc/symmetry'
import {DEFAULT_OUTPUT} from '../doc/save'
import {createVolume} from '../render/volume'
import {readVox} from '../vox/vox-file'
import {initialState} from './state'
import {
    asking,
    closed,
    discarded,
    dropPicture,
    guard,
    loadPalette,
    newProject,
    NO_DIALOG,
    openProject,
    proceed,
    restoreSnapshot,
    saveProject,
    savingFirst
} from './session'

/**
 * The commands that read and write the artist's disk, asked questions directly.
 *
 * Every one of these used to be a mounted window with a viewport, a palette and eight thumbnails in
 * it, clicked through a portalled menu — 223 ms each, to find out what a cancelled picker does. The
 * whole file below runs in single-digit milliseconds and none of it touches React.
 */

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

const state = initialState(volume, 'car.vox')

/** The document as `saveDocument` wants it, with nothing interesting in the version-2 half. */
const asSaved = (grid = createVolume(8, 8, 8, volume.palette)) => ({
    volume: grid,
    objects: initialObjects(grid),
    cameras: [],
    references: [],
    symmetry: NO_SYMMETRY,
    output: DEFAULT_OUTPUT
})

/** A port that always hands back this one file, whatever it was asked for. */
const picking = (name: string, bytes: Uint8Array): Files => ({
    overwrites: true,
    forget: () => undefined,
    open: async () => Promise.resolve({name, bytes, text: new TextDecoder().decode(bytes)}),
    save: async () => Promise.resolve(name),
    // Nothing in `session.ts` writes an export. A stub that threw would be a truer claim, but this
    // port is handed to code under test and a throw would be a failure with no assertion behind it.
    write: () => Promise.resolve()
})

/* ── saving ──────────────────────────────────────────────────────────────────────────────────── */

test('a save writes the document and reports the name the disk gave it', async () => {
    const disk = new Map<string, string>()
    const action = await saveProject(memoryFiles(disk), state, true, () => 1234)

    expect(action).toEqual({type: 'saved', name: 'car.gpix', at: 1234})
    // A `.vox` saves as a `.gpix`, never back over MagicaVoxel's file.
    expect([...disk.keys()]).toEqual(['car.gpix'])
    expect(loadDocument(disk.get('car.gpix') ?? '')).toBeTruthy()
})

test('a cancelled picker reports nothing rather than a save that did not happen', async () => {
    const disk = new Map<string, string>()
    const action = await saveProject(
        memoryFiles(disk, () => undefined),
        state,
        false
    )

    // `undefined` is the whole guard. A caller that took a truthy value here would mark the
    // document clean and then let the artist close the tab on an hour of work.
    expect(action).toBeUndefined()
    expect(disk.size).toBe(0)
})

test('Save As asks even when there is a file to write back to', async () => {
    const disk = new Map<string, string>()
    const asked: string[] = []
    const files = memoryFiles(disk, suggested => {
        asked.push(suggested)
        return 'other.gpix'
    })

    await saveProject(files, state, true)
    // Reuse: the port already holds `other.gpix`, so nothing is asked a second time.
    await saveProject(files, state, true)
    expect(asked).toEqual(['car.gpix'])

    const action = await saveProject(files, state, false)
    expect(asked).toEqual(['car.gpix', 'car.gpix'])
    expect(action?.type).toBe('saved')
})

/* ── opening ─────────────────────────────────────────────────────────────────────────────────── */

test('a .gpix off the disk opens as itself', async () => {
    const disk = new Map([['knight.gpix', JSON.stringify(saveDocument(asSaved(), 'knight.gpix'))]])
    const action = await openProject(memoryFiles(disk))

    expect(action?.type).toBe('open')
    if (action?.type !== 'open') throw new Error('not an open')
    expect(action.document.name).toBe('knight.gpix')
    // Off a file, so it is not unsaved work — that flag belongs to a restored snapshot.
    expect(action.document.unsaved).toBeUndefined()
})

test('a .vox opens as an untitled document, because Save cannot write that format back', async () => {
    const bytes = new Uint8Array(
        await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer()
    )
    let forgotten = false
    const files: Files = {
        ...picking('other.vox', bytes),
        forget: () => {
            forgotten = true
        }
    }
    const action = await openProject(files)

    expect(action?.type).toBe('new')
    if (action?.type !== 'new') throw new Error('not a new')
    expect(action.name).toBe('other.vox')
    expect(action.volume.data.filter(Boolean).length).toBeGreaterThan(0)
    // The held file has to go, or the next Save offers to overwrite a `.vox` with JSON.
    expect(forgotten).toBe(true)
})

test('a file that will not parse opens nothing at all', async () => {
    expect(await openProject(picking('notes.vox', new Uint8Array([1, 2, 3, 4])))).toBeUndefined()
    expect(await openProject(picking('notes.gpix', new TextEncoder().encode('{')))).toBeUndefined()
})

test('a cancelled open leaves the document alone', async () => {
    expect(await openProject(memoryFiles(new Map()))).toBeUndefined()
})

/* ── the rest of the disk ────────────────────────────────────────────────────────────────────── */

test('a new project forgets the file Save was writing back to', () => {
    let forgotten = false
    const files: Files = {...picking('x', new Uint8Array()), forget: () => (forgotten = true)}
    const action = newProject(files, [12, 13, 14], 'fresh')

    expect(action).toMatchObject({type: 'new', name: 'fresh.gpix'})
    if (action.type !== 'new') throw new Error('not a new')
    expect([action.volume.sx, action.volume.sy, action.volume.sz]).toEqual([12, 13, 14])
    expect(forgotten).toBe(true)
})

test('a palette is loaded through the same port, and is not a document', async () => {
    const disk = new Map<string, string | Uint8Array>([
        ['knight.gpix', JSON.stringify(saveDocument(asSaved(), 'knight.gpix'))],
        ['mine.hex', '112233\n445566\n']
    ])
    // This picker always cancels, so a Save that had forgotten its file would write nothing.
    const files = memoryFiles(disk, () => undefined)

    await openProject(files)
    expect(await loadPalette(files)).toEqual({type: 'palette-load', text: '112233\n445566\n'})
    // Still knows the project: loading a palette must not make the next Save ask.
    expect(await saveProject(files, state, true)).toBeTruthy()
})

test('a restored snapshot arrives as unsaved work, and a missing key restores nothing', () => {
    const store = memoryStore()
    store.set('snap-1', JSON.stringify(saveDocument(asSaved(), 'knight.gpix')))

    const action = restoreSnapshot(store, 'snap-1')
    if (action?.type !== 'open') throw new Error('not an open')
    // A snapshot is by definition an edit that was never written to disk.
    expect(action.document.unsaved).toBe(true)

    expect(restoreSnapshot(store, 'snap-9')).toBeUndefined()
    store.set('junk', 'not json')
    expect(restoreSnapshot(store, 'junk')).toBeUndefined()
})

/* ── the picture drop ────────────────────────────────────────────────────────────────────────── */

const asPng = (): File =>
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'front.png', {type: 'image/png'})

/** A stand-in for the browser's decoder and the three context calls the drop makes alongside it. */
const withDecoder = async (run: () => Promise<void>): Promise<void> => {
    const realBitmap = globalThis.createImageBitmap
    const realContext = HTMLCanvasElement.prototype.getContext
    globalThis.createImageBitmap = async () =>
        Promise.resolve({width: 2, height: 2, close: () => undefined})
    HTMLCanvasElement.prototype.getContext = (() => ({
        drawImage: () => undefined,
        getImageData: () => ({
            data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 0, 0]),
            width: 2,
            height: 2,
            colorSpace: 'srgb'
        })
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext
    try {
        await run()
    } finally {
        globalThis.createImageBitmap = realBitmap
        HTMLCanvasElement.prototype.getContext = realContext
    }
}

test('a dropped picture becomes reference art on the plane it was aimed at', async () => {
    await withDecoder(async () => {
        const action = await dropPicture(asPng(), false, 0)
        expect(action?.type).toBe('reference')
        if (action?.type !== 'reference') throw new Error('not a reference')
        if (action.op.kind !== 'place') throw new Error('not a placement')
        expect(action.op.plane).toBe(0)
        // A `data:` URL, so it survives a reload and can be written into a `.gpix`.
        expect(action.op.url).toStartWith('data:image/png;base64,')
    })
})

test('the same picture with Shift becomes voxels instead', async () => {
    await withDecoder(async () => {
        const action = await dropPicture(asPng(), true, 1)
        if (action?.type !== 'import-image') throw new Error('not an import')
        expect(action.name).toBe('front.png')
        // Two opaque pixels in a 2 × 2, extruded four deep.
        expect([action.volume.sx, action.volume.sy, action.volume.sz]).toEqual([2, 4, 2])
        expect(action.volume.data.filter(Boolean).length).toBe(8)
    })
})

test('a drop that is not a picture does nothing at all', async () => {
    await withDecoder(async () => {
        expect(await dropPicture(undefined, false, 1)).toBeUndefined()
        const notes = new File(['hello'], 'notes.txt', {type: 'text/plain'})
        expect(await dropPicture(notes, false, 1)).toBeUndefined()
    })
})

test('a picture the browser cannot decode is not a picture, whatever it was named', async () => {
    const real = globalThis.createImageBitmap
    globalThis.createImageBitmap = async () => Promise.reject(new Error('not an image'))
    try {
        expect(await dropPicture(asPng(), false, 1)).toBeUndefined()
    } finally {
        globalThis.createImageBitmap = real
    }
})

/* ── the guard ───────────────────────────────────────────────────────────────────────────────── */

test('a clean document goes straight through the guard', () => {
    expect(guard('new', false)).toEqual({dialog: {kind: 'new'}, opening: false})
    expect(guard('generate', false)).toEqual({dialog: {kind: 'generate'}, opening: false})
    // Open has no dialog of its own — the file picker is its dialog, and the browser owns that.
    expect(guard('open', false)).toEqual({dialog: NO_DIALOG, opening: true})
})

test('a dirty document is asked about first, and the question remembers what it was for', () => {
    for (const what of ['new', 'open', 'generate'] as const) {
        const step = guard(what, true)
        expect(step).toEqual({dialog: {kind: 'unsaved', next: what}, opening: false})
        // Discard has to know what the artist was trying to do, or it dismisses itself and makes
        // them find the menu a second time.
        expect(asking(step.dialog)).toBe(what)
        expect(proceed(asking(step.dialog))).toEqual(guard(what, false))
    }
})

test('nothing is being asked about when no dialog is up', () => {
    expect(asking(NO_DIALOG)).toBeUndefined()
    expect(asking({kind: 'new'})).toBeUndefined()
    expect(closed()).toEqual({dialog: NO_DIALOG, opening: false})
    expect(proceed(undefined)).toEqual({dialog: NO_DIALOG, opening: false})
})

/**
 * The transitions the unsaved dialog is made of. They used to run inside its JSX props, so the one
 * rule in this codebase that can destroy an hour of work could only be asked a question by mounting
 * a whole window and clicking through it.
 */
test('Discard goes on and does the thing the artist was asking for', () => {
    for (const what of ['new', 'open', 'generate'] as const) {
        expect(discarded(guard(what, true).dialog)).toEqual(guard(what, false))
    }
})

test('Discard on nothing does nothing', () => {
    expect(discarded(NO_DIALOG)).toEqual(closed())
})

test('Save closes the question first, because the picker is about to be the modal', () => {
    expect(savingFirst(guard('new', true).dialog).now).toEqual(closed())
})

test('a save that happened goes on to do what was asked', () => {
    for (const what of ['new', 'open', 'generate'] as const) {
        expect(savingFirst(guard(what, true).dialog).then(true)).toEqual(guard(what, false))
    }
})

/**
 * The click that loses the work. Save, then Cancel on the file picker: nothing was written, so
 * nothing may replace the document — a cancelled picker is not a silent Discard.
 */
test('a save that did not happen replaces nothing', () => {
    for (const what of ['new', 'open', 'generate'] as const) {
        const {then} = savingFirst(guard(what, true).dialog)
        expect(then(false)).toEqual(closed())
        expect(then(false).opening).toBe(false)
    }
})
