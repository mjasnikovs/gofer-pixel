import type {Volume} from '../render/volume'
import {applyEdit, revertEdit, type Edit} from './edits'
import type {Objects} from './objects'

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
