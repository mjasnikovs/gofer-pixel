import type {Axis} from '../doc/brush'
import {PALETTE_ACCEPT, projectName, PROJECT_ACCEPT, type Files} from '../doc/files'
import {voxelsFromImage} from '../doc/import'
import {initialObjects} from '../doc/objects'
import {loadDocument, saveDocument} from '../doc/save'
import type {Store} from '../doc/store'
import {newDocument} from '../doc/templates'
import {readVox} from '../vox/vox-file'
import {asDocument, type AppAction, type AppState} from './state'

/**
 * The open document's lifecycle: which file is being read or written, and what stands between the
 * artist and losing an hour of work.
 *
 * It was seven `useCallback`s and three `useState`s in `App.tsx`, which meant the one rule in this
 * codebase that can destroy something irreplaceable — *a cancelled picker is not a save, and a save
 * that did not happen is not a Discard* — could only be asked a question by mounting a window with a
 * viewport, a palette and eight thumbnails in it. Sixteen tests did exactly that, at 223 ms each.
 *
 * Every command here is the same shape: ports and state in, an `AppAction` or `undefined` out.
 * `undefined` is always "the artist backed out, change nothing" and never an error — so a command
 * that forgets the cancel case does not compile into a silent data loss, it fails to compile.
 *
 * Nothing here touches React, and nothing here dispatches. `App.tsx` awaits and dispatches, which is
 * the only part of this that needed a component.
 */

/** The three things that replace the open document, and therefore have to ask about it first. */
export type Guarded = 'new' | 'open' | 'generate'

/**
 * Which modal is up. One value rather than the three independent booleans it replaces
 * (`pending`, `asking`, `generating`) — they were never independent, because two dialogs over each
 * other is not a state anything wanted and nothing stopped it.
 *
 * `unsaved` carries what the artist was *trying* to do, so Discard goes on and does it instead of
 * dismissing itself and making them find the menu again.
 */
export type Dialog =
    | {readonly kind: 'none'}
    | {readonly kind: 'unsaved'; readonly next: Guarded}
    | {readonly kind: 'new'}
    | {readonly kind: 'generate'}
    /**
     * Export. The only one of the four that is not `Guarded`, and deliberately: it writes files
     * *out* and never replaces the open document, so there is no unsaved work to ask about. Putting
     * it in the same union is what stops it opening over one of the three that do.
     */
    | {readonly kind: 'export'}

export const NO_DIALOG: Dialog = {kind: 'none'}

/** Open the export dialog. No guard, no picker, nothing to come back and dispatch. */
export const exporting = (): Step => ({dialog: {kind: 'export'}, opening: false})

/**
 * A transition: the dialog to draw, and whether the caller still owes the disk a visit.
 *
 * Open is the odd one of the three — it has no dialog of its own, because the file picker *is* its
 * dialog and the browser owns that. So it comes back as a flag rather than a `kind`.
 */
export interface Step {
    readonly dialog: Dialog
    /** True when the caller should now run `openProject`. */
    readonly opening: boolean
}

/** Go and do it: the guard has either passed or been overridden. */
export const proceed = (what: Guarded | undefined): Step => {
    switch (what) {
        case 'new':
            return {dialog: {kind: 'new'}, opening: false}
        /*
         * Generation is guarded at the *dialog*, not at the pick: the dialog is modal and the pick
         * inside it is the last click of a minute-long wait, which is the worst possible moment to
         * be asked whether the work it is about to replace matters.
         */
        case 'generate':
            return {dialog: {kind: 'generate'}, opening: false}
        case 'open':
            return {dialog: NO_DIALOG, opening: true}
        case undefined:
            return {dialog: NO_DIALOG, opening: false}
    }
}

/** The guard in front of New, Open and Generate — what stops unsaved work leaving unasked about. */
export const guard = (what: Guarded, dirty: boolean): Step =>
    dirty ? {dialog: {kind: 'unsaved', next: what}, opening: false} : proceed(what)

/** What the unsaved dialog is asking about, or `undefined` when it is not up. */
export const asking = (dialog: Dialog): Guarded | undefined =>
    dialog.kind === 'unsaved' ? dialog.next : undefined

export const closed = (): Step => ({dialog: NO_DIALOG, opening: false})

/** Discard on the unsaved dialog: throw the work away and go and do the thing that was asked. */
export const discarded = (dialog: Dialog): Step => proceed(asking(dialog))

/**
 * Save on the unsaved dialog, which is two steps with a picker in between.
 *
 * `now` closes the dialog, because the browser's file picker is about to be the modal and two of
 * them stacked is not a state anything wants. `then` is where **the one rule in this codebase that
 * can destroy an hour of work** lives: a save that did not happen is not a Discard. A cancelled
 * picker leaves everything exactly where it was, and in particular does not go on to replace the
 * document the artist has just declined to save.
 *
 * It is two values rather than two calls because `now` throws away the dialog that `then` needs to
 * read — so the thing being asked about has to be captured before the picker opens, and the only
 * way to make a caller do that is to hand both halves over at once. It used to be a
 * `take → doSave → then → take` dance inside a JSX prop, reachable only by mounting a window.
 */
export const savingFirst = (
    dialog: Dialog
): {readonly now: Step; readonly then: (saved: boolean) => Step} => {
    const what = asking(dialog)
    return {now: closed(), then: saved => (saved ? proceed(what) : closed())}
}

/**
 * Save, or Save As when `reuse` is false.
 *
 * `undefined` on a cancelled picker, and the document stays dirty. It must not report a save that
 * did not happen — that is the exact click that loses the work, because the caller's next move is
 * to throw the document away.
 */
export const saveProject = async (
    files: Files,
    state: AppState,
    reuse: boolean,
    now: () => number = Date.now
): Promise<AppAction | undefined> => {
    const suggested = projectName(state.doc.name)
    const text = JSON.stringify(saveDocument(asDocument(state), suggested))
    const written = await files.save(suggested, text, reuse)
    if (written === undefined) return undefined
    return {type: 'saved', name: written, at: now()}
}

/**
 * Open, through the same port Save uses.
 *
 * A `.gpix` is ours; a `.vox` is MagicaVoxel's and arrives as an untitled document, because this app
 * cannot write that format and Save must ask rather than offer to destroy the file that was opened.
 * Anything else that will not parse is refused without touching what is open — a half-loaded
 * document is the one outcome `doc/save.ts` exists to prevent.
 */
export const openProject = async (files: Files): Promise<AppAction | undefined> => {
    // The one read in the app that becomes the file Save writes back to — see `ReadFor`.
    const picked = await files.open(PROJECT_ACCEPT, {remember: true})
    if (!picked) return undefined
    if (picked.name.toLowerCase().endsWith('.vox')) {
        files.forget()
        try {
            const built = readVox(picked.bytes)
            return {type: 'new', volume: built, objects: initialObjects(built), name: picked.name}
        } catch {
            // Not a `.vox` whatever it was called. The open document is untouched.
            return undefined
        }
    }
    const loaded = loadDocument(picked.text)
    return loaded ? {type: 'open', document: {...loaded, name: picked.name}} : undefined
}

/** A new grid from the templates dialog. It writes nothing, so there is no cancel to report. */
export const newProject = (
    files: Files,
    size: readonly [number, number, number],
    fresh: string
): AppAction => {
    const {volume, objects} = newDocument(size)
    files.forget()
    return {type: 'new', volume, objects, name: projectName(fresh)}
}

/**
 * `FEATURESET.md` §7's import half, through the same port.
 *
 * It built its own `<input type=file>` until the port grew a second caller, which meant the one
 * interesting line — what happens to a file that is not a palette — could only be tested by
 * replacing `HTMLInputElement.prototype.click`.
 */
export const loadPalette = async (files: Files): Promise<AppAction | undefined> => {
    const picked = await files.open(PALETTE_ACCEPT, {description: 'Palette'})
    return picked ? {type: 'palette-load', text: picked.text} : undefined
}

/**
 * A snapshot off the autosave store — `FEATURESET.md` §32.
 *
 * `unsaved`, because a snapshot is an edit that was autosaved and never written to disk. Restoring
 * one and calling it saved would let the artist close the tab without a word.
 */
export const restoreSnapshot = (store: Store, key: string): AppAction | undefined => {
    const text = store.get(key)
    const back = text === undefined ? undefined : loadDocument(text)
    return back ? {type: 'open', document: {...back, unsaved: true}} : undefined
}

/**
 * How thick a PNG comes in — `FEATURESET.md` §34's "choose extrusion depth".
 *
 * Four, because one voxel deep is a sheet of paper that looks wrong from every angle but the one it
 * was drawn at, and the point of importing is to have something to sculpt.
 */
export const DEFAULT_EXTRUSION = 4

/**
 * A blob as a `data:` URL.
 *
 * `FileReader` rather than `btoa` over the bytes, because the base64 of a megabyte of PNG through
 * `String.fromCharCode` is the argument-stack blowout `doc/save.ts` already comments on, and the
 * platform has a reader that does not have the problem.
 */
const dataUrl = async (blob: Blob): Promise<string> =>
    new Promise<string>(resolve => {
        const reader = new FileReader()
        reader.addEventListener('load', () => {
            resolve(typeof reader.result === 'string' ? reader.result : '')
        })
        reader.readAsDataURL(blob)
    })

/**
 * A picture dropped on the viewport.
 *
 * Which of the two things `FEATURESET.md` asks for it becomes is decided by the modifier: plain is
 * §33's reference to build against, Shift is §34's import, where every opaque pixel becomes a voxel.
 * Both need the browser's own decoder, which is what `createImageBitmap` and a scratch canvas are —
 * so this is the one command here that is not pure arithmetic over a port.
 */
export const dropPicture = async (
    file: File | undefined,
    asVoxels: boolean,
    onto: Axis
): Promise<AppAction | undefined> => {
    if (!file?.type.startsWith('image/')) return undefined
    const blob = new Blob([await file.arrayBuffer()], {type: file.type})
    let bitmap: ImageBitmap
    try {
        bitmap = await createImageBitmap(blob)
    } catch {
        // A file the browser cannot decode is not a picture, whatever it was named.
        return undefined
    }
    if (!asVoxels) {
        /*
         * A `data:` URL, not `URL.createObjectURL`. An object URL is a handle into this page's
         * memory: it is dead on the next reload and it cannot be written into a `.gpix`, so a
         * project saved with reference art would have opened blank. The cost is the PNG's own bytes,
         * base64'd, inside the file.
         */
        return {type: 'reference', plane: onto, url: await dataUrl(blob)}
    }
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) return undefined
    context.drawImage(bitmap, 0, 0)
    const {data} = context.getImageData(0, 0, bitmap.width, bitmap.height)
    const {volume} = voxelsFromImage(
        new Uint8Array(data),
        bitmap.width,
        bitmap.height,
        DEFAULT_EXTRUSION
    )
    return {type: 'import-image', volume, name: file.name}
}
