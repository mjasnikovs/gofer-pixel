import {expect, test} from 'bun:test'
import {createVolume, setVoxel, voxelAt} from '../render/volume'
import {beginEdit, writeVoxel} from './edits'
import {commit, EMPTY_HISTORY, undo, type Committing} from './history'
import {addObject, initialObjects, removeObject} from './objects'
import {EMPTY_SELECTION, selectVoxel} from './selection'

/**
 * Closing a draft into the history — the four steps that were written out eight times.
 *
 * Five cases of the reducer and three gestures each opened a draft, called `commitEdit`, decided
 * what an empty result meant and assembled the same four fields. They disagreed three ways about
 * the empty case, and only the two that had to remembered to stamp the object list onto the edit.
 * That omission is commit `eaa7b23`: undo put the voxels of a deleted object back and left them
 * owned by an id no row could name.
 *
 * These are the rules that used to be spread across two files and could only be asked by building a
 * whole `AppState`.
 */

const grid = () => {
    const volume = createVolume(4, 4, 4, new Uint8Array(256 * 4))
    setVoxel(volume, 0, 0, 0, 7)
    return volume
}

const opened = (): Committing & {volume: ReturnType<typeof grid>} => {
    const volume = grid()
    return {
        volume,
        objects: initialObjects(volume),
        selection: EMPTY_SELECTION,
        history: EMPTY_HISTORY
    }
}

test('a draft that moved a voxel lands as one entry, and undoes back to where it started', () => {
    const state = opened()
    const draft = beginEdit(state.volume)
    writeVoxel(draft, 1, 1, 1, 3)

    const landed = commit(state, draft)
    if (!landed) throw new Error('a written voxel is an edit')

    expect(voxelAt(landed.volume, 1, 1, 1)).toBe(3)
    expect(landed.history.past).toHaveLength(1)
    // Nothing it was not asked to move: the object list and the selection are the ones handed in.
    expect(landed.objects).toBe(state.objects)
    expect(landed.selection).toBe(state.selection)

    const back = undo(landed.volume, landed.history)
    expect(voxelAt(back?.volume ?? landed.volume, 1, 1, 1)).toBe(0)
})

/*
 * The reason this is `undefined` rather than a state with the old history on it: `draft.volume` is
 * a fresh object every time, so a caller that handed it back would hand back a document whose
 * volume is `!==` the one that went in — and `reduce` compares exactly that to decide whether there
 * is unsaved work. A rotate that moved nothing would mark the file dirty.
 */
test('a draft that changed nothing is nothing at all, so the caller can hand back what it had', () => {
    const state = opened()
    const draft = beginEdit(state.volume)
    // Written, but to the value that was already there.
    writeVoxel(draft, 0, 0, 0, 7)

    expect(commit(state, draft)).toBeUndefined()
})

test('the selection an edit leaves behind is the one it was given', () => {
    const state = opened()
    const draft = beginEdit(state.volume)
    writeVoxel(draft, 2, 2, 2, 5)
    const selection = selectVoxel(state.volume, 2, 2, 2)

    expect(commit(state, draft, {selection})?.selection).toBe(selection)
})

/*
 * `FEATURESET.md` §8's delete. An empty object moves no voxel, and losing a name is still a loss —
 * so the list moving is enough to make an entry, and the entry carries the list both ways.
 */
test('a list that moved is an edit even when no cell did, and undo puts the list back', () => {
    const state = opened()
    const added = addObject(state.objects)
    if (!added) throw new Error('a second object fits')
    const emptied = removeObject(added, added.active)
    const draft = beginEdit(state.volume, emptied.active)

    const landed = commit({...state, objects: added}, draft, {objects: emptied})
    if (!landed) throw new Error('a list that moved is always an edit')

    expect(landed.objects).toBe(emptied)
    expect(landed.history.past).toHaveLength(1)
    expect(landed.history.past[0]?.at).toHaveLength(0)
    expect(undo(landed.volume, landed.history)?.objects).toBe(added)
})

/*
 * The other half of the same rule. A delete takes voxels with it, so cells the artist had chosen
 * may not be there any more — and a selection naming cells that changed under it is worse than no
 * selection. It is cleared whatever the caller asked for.
 */
test('an edit that moved the list drops the selection, whatever it was passed', () => {
    const state = opened()
    const chosen = selectVoxel(state.volume, 0, 0, 0)
    const added = addObject(state.objects)
    if (!added) throw new Error('a second object fits')
    const draft = beginEdit(state.volume, added.active)
    writeVoxel(draft, 3, 3, 3, 2)

    const landed = commit({...state, selection: chosen}, draft, {
        objects: added,
        selection: chosen
    })

    expect(landed?.selection.size).toBe(0)
})
