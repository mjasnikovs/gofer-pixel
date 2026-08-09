import type {Volume} from '../render/volume'
import {applyEdit, commitEdit, NO_CELLS, revertEdit, type Draft, type Edit} from './edits'
import type {Objects} from './objects'
import {EMPTY_SELECTION, type Selection} from './selection'

/**
 * Undo that feels indestructible (`FEATURESET.md` §32) — two stacks of diffs.
 *
 * The history holds edits, never volumes, so its size is proportional to what the artist changed
 * rather than to the model. A stroke that paints two hundred voxels is 1.2 KB; the limit below is
 * therefore about depth of regret rather than about memory.
 */
export interface History {
    readonly past: readonly Edit[]
    readonly future: readonly Edit[]
}

/** Deep enough that hitting the bottom is a story, not a Tuesday. */
export const HISTORY_LIMIT = 512

export const EMPTY_HISTORY: History = {past: [], future: []}

export const record = (history: History, edit: Edit): History => ({
    past: [...history.past, edit].slice(-HISTORY_LIMIT),
    // Doing something new abandons the branch that was undone. Keeping it would need a tree, and a
    // tree needs a way to show it, which is the "visual history" that `FEATURESET.md` postpones.
    future: []
})

export const canUndo = ({past}: History): boolean => past.length > 0
export const canRedo = ({future}: History): boolean => future.length > 0

/** What `commit` reads. `AppState` and `Gesture` both satisfy it, so both hand themselves over. */
export interface Committing {
    readonly objects: Objects
    readonly selection: Selection
    readonly history: History
}

/** What a landed draft leaves the document as — spread over the caller's own state. */
export interface Landed {
    readonly volume: Volume
    readonly objects: Objects
    readonly selection: Selection
    readonly history: History
}

/**
 * Close a draft into the history, and say what the document becomes.
 *
 * This was written out eight times: five cases of the reducer and three gestures, each opening a
 * draft, calling `commitEdit`, deciding what an empty result means and assembling the same four
 * fields. They did not agree. Three said `return state`, two said `?? NO_CELLS`, three kept the old
 * history — and only two of the eight remembered to stamp the object list onto the edit, which is
 * the exact omission commit `eaa7b23` had to go back and fix. The other six are right by not
 * needing it, which is not the same thing as being checked.
 *
 * `undefined` means **nothing happened** and the caller should hand back the state it was given,
 * untouched. That matters beyond the history: a fresh `draft.volume` on a transform that moved
 * nothing is a new object identity, so `reduce` would compare it against the old one, find it
 * different, and mark a document dirty over an edit that changed no cell.
 *
 * The one case where a nothing-edit is still an edit is a change to the object list: deleting an
 * empty object moves no voxel and still has to be undoable, because losing a name is a loss. Pass
 * `objects` and the entry is recorded either way — see `NO_CELLS`.
 */
export const commit = (
    state: Committing,
    draft: Draft,
    /**
     * What this edit changes besides the voxels: the selection it leaves behind, and the object list
     * when it moved one.
     */
    also: {readonly selection?: Selection; readonly objects?: Objects} = {}
): Landed | undefined => {
    const moved = also.objects
    const edit = commitEdit(draft)
    if (moved) {
        return {
            volume: draft.volume,
            objects: moved,
            /*
             * An edit that moved the object list took voxels with it — a delete takes them away, a
             * duplicate makes new ones — so whatever was selected may not be there any more, and a
             * selection naming cells that have changed under it is worse than no selection.
             */
            selection: EMPTY_SELECTION,
            history: record(state.history, {
                ...(edit ?? NO_CELLS),
                objects: {from: state.objects, to: moved}
            })
        }
    }
    if (!edit) return undefined
    return {
        volume: draft.volume,
        objects: state.objects,
        selection: also.selection ?? state.selection,
        history: record(state.history, edit)
    }
}

/**
 * `objects` is the list the step wants put back, and `undefined` means "this step did not touch
 * it" — which is almost every step. The caller keeps what it has in that case.
 */
export interface Step {
    volume: Volume
    history: History
    objects: Objects | undefined
}

export const undo = (volume: Volume, history: History): Step | undefined => {
    const edit = history.past.at(-1)
    if (!edit) return undefined
    return {
        volume: revertEdit(volume, edit),
        history: {past: history.past.slice(0, -1), future: [...history.future, edit]},
        objects: edit.objects?.from
    }
}

export const redo = (volume: Volume, history: History): Step | undefined => {
    const edit = history.future.at(-1)
    if (!edit) return undefined
    return {
        volume: applyEdit(volume, edit),
        history: {past: [...history.past, edit], future: history.future.slice(0, -1)},
        objects: edit.objects?.to
    }
}
