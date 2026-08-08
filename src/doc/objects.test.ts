import {expect, test} from 'bun:test'
import {createVolume, setVoxel, voxelAt, voxelIndex, type Volume} from '../render/volume'
import {beginEdit, commitEdit, revertEdit, writeVoxel} from './edits'
import {
    addObject,
    canRemove,
    duplicateOffset,
    initialObjects,
    isShown,
    lockedIds,
    matching,
    MAX_OBJECTS,
    moveObject,
    objectBounds,
    objectCells,
    objectExtents,
    ownerAt,
    removeObject,
    renameObject,
    setHidden,
    setLocked,
    shownVolume,
    soloObject,
    type Objects
} from './objects'

const twoBlobs = (): {volume: Volume; objects: Objects} => {
    const volume = createVolume(8, 8, 8, new Uint8Array(256 * 4))
    for (let x = 0; x < 3; x += 1) setVoxel(volume, x, 0, 0, 4)
    let objects = initialObjects(volume, 'Body')

    // A second object, drawn into after it is made active.
    const added = addObject(objects, 'Sword')
    if (!added) throw new Error('there is room for a second object')
    objects = added
    const draft = beginEdit(volume, objects.active)
    for (let x = 5; x < 8; x += 1) writeVoxel(draft, x, 0, 0, 9)
    return {volume: draft.volume, objects}
}

test('a freshly opened model is one object holding everything', () => {
    const volume = createVolume(4, 4, 4)
    setVoxel(volume, 1, 1, 1, 3)
    setVoxel(volume, 2, 2, 2, 3)
    const objects = initialObjects(volume)

    expect(objects.list).toHaveLength(1)
    expect(objects.active).toBe(1)
    expect(objectCells(volume, 1).size).toBe(2)
    // Air belongs to nobody, whatever else is true.
    expect(ownerAt(volume, 0, 0, 0)).toBe(0)
    expect(ownerAt(volume, 1, 1, 1)).toBe(1)
})

test('a stroke joins the object that is active, and undo puts the ownership back', () => {
    const {volume, objects} = twoBlobs()
    expect(objects.active).toBe(2)
    expect(objectCells(volume, 1).size).toBe(3)
    expect(objectCells(volume, 2).size).toBe(3)
    expect(ownerAt(volume, 6, 0, 0)).toBe(2)

    const draft = beginEdit(volume, 1)
    writeVoxel(draft, 6, 0, 0, 0)
    const edit = commitEdit(draft)
    if (!edit) throw new Error('the erase changed a cell')
    expect(ownerAt(draft.volume, 6, 0, 0)).toBe(0)
    expect(ownerAt(revertEdit(draft.volume, edit), 6, 0, 0)).toBe(2)
})

test('hiding empties an object out of the grid the renderer sees, and nothing else', () => {
    const {volume, objects} = twoBlobs()
    const hidden = setHidden(objects, 2, true)

    expect(shownVolume(volume, objects)).toBe(volume)
    const shown = shownVolume(volume, hidden)
    expect(shown).not.toBe(volume)
    expect(voxelAt(shown, 6, 0, 0)).toBe(0)
    expect(voxelAt(shown, 1, 0, 0)).toBe(4)
    // The document still holds it. Hiding is not deleting.
    expect(voxelAt(volume, 6, 0, 0)).toBe(9)
    expect(objectCells(volume, 2).size).toBe(3)
})

test('solo shows one object whatever the hidden flags say, and toggles off', () => {
    const {volume, objects} = twoBlobs()
    const soloed = soloObject(setHidden(objects, 2, false), 2)

    expect(isShown(soloed, 2)).toBe(true)
    expect(isShown(soloed, 1)).toBe(false)
    // Soloing makes it active: it is the only thing left that a stroke could land on.
    expect(soloed.active).toBe(2)
    expect(voxelAt(shownVolume(volume, soloed), 1, 0, 0)).toBe(0)

    expect(soloObject(soloed, 2).solo).toBeUndefined()
    // Hiding the soloed object is the artist saying they are done soloing.
    expect(setHidden(soloed, 2, true).solo).toBeUndefined()
})

test('a locked or hidden object refuses the write rather than the tool refusing to try', () => {
    const {volume, objects} = twoBlobs()
    const locked = setLocked(objects, 1, true)
    expect([...lockedIds(locked)]).toEqual([1])

    const draft = beginEdit(volume, 2, lockedIds(locked))
    writeVoxel(draft, 1, 0, 0, 0)
    writeVoxel(draft, 6, 0, 0, 0)
    expect(voxelAt(draft.volume, 1, 0, 0)).toBe(4)
    expect(voxelAt(draft.volume, 6, 0, 0)).toBe(0)

    // Hidden counts as locked: a tool cannot aim at what is not on screen.
    expect([...lockedIds(setHidden(objects, 1, true))]).toEqual([1])
})

test('an object knows the box it fills, and an empty one has none', () => {
    const {volume, objects} = twoBlobs()
    expect(objectBounds(volume, 1)).toEqual({min: [0, 0, 0], max: [2, 0, 0], count: 3})
    expect(objectBounds(volume, 2)?.min).toEqual([5, 0, 0])

    const empty = addObject(objects, 'Shield')
    expect(empty?.list).toHaveLength(3)
    expect(objectBounds(volume, empty?.active ?? 0)).toBeUndefined()
})

test('the list can be renamed, reordered, searched and trimmed, but never emptied', () => {
    const {objects} = twoBlobs()

    expect(renameObject(objects, 2, 'Blade').list[1]?.name).toBe('Blade')
    expect(moveObject(objects, 2, 0).list.map(entry => entry.name)).toEqual(['Sword', 'Body'])
    expect(moveObject(objects, 9, 0)).toBe(objects)

    expect(matching(objects, 'sw').map(entry => entry.name)).toEqual(['Sword'])
    expect(matching(objects, '  ')).toHaveLength(2)

    expect(canRemove(objects)).toBe(true)
    const one = removeObject(objects, 2)
    expect(one.list).toHaveLength(1)
    expect(one.active).toBe(1)
    expect(canRemove(one)).toBe(false)
    expect(removeObject(one, 1)).toBe(one)
})

test('the list runs out at the number a byte of ownership can name', () => {
    const volume = createVolume(2, 2, 2)
    let objects = initialObjects(volume)
    for (let i = 1; i < MAX_OBJECTS; i += 1) {
        const added = addObject(objects)
        if (!added) throw new Error(`room for object ${String(i + 1)}`)
        objects = added
    }
    expect(objects.list).toHaveLength(MAX_OBJECTS)
    expect(addObject(objects)).toBeUndefined()

    // A gap in the middle is reused rather than the list refusing at 255 for ever.
    const trimmed = removeObject(objects, 7)
    expect(addObject(trimmed)?.active).toBe(7)
})

test('every cell of a shown volume still points at the owner it had', () => {
    const {volume, objects} = twoBlobs()
    const shown = shownVolume(volume, setHidden(objects, 1, true))
    // Masking empties `data` and leaves `owner` alone, so unhiding is not a rebuild.
    expect(shown.owner).toBe(volume.owner)
    expect(shown.owner[voxelIndex(volume, 1, 0, 0)]).toBe(1)
})

test('every object reports its own extent in one pass over the grid', () => {
    const {volume} = twoBlobs()
    const extents = objectExtents(volume)

    expect(extents.get(1)).toEqual({min: [0, 0, 0], max: [2, 0, 0], count: 3})
    expect(extents.get(2)).toEqual({min: [5, 0, 0], max: [7, 0, 0], count: 3})
    // An object nobody has drawn into owns no cell, so it is not in the map at all.
    expect(extents.get(3)).toBeUndefined()

    // One pass and many passes have to say the same thing, or the panel is lying about a row.
    for (const [id, extent] of extents) expect(objectBounds(volume, id)).toEqual(extent)
})

test('a copy stands beside its original, and nowhere when there is no room', () => {
    const {volume} = twoBlobs()

    // Object 1 is three wide at x 0..2 in an eight-wide grid, so +X clears it.
    expect(duplicateOffset(volume, objectBounds(volume, 1))).toEqual([3, 0, 0])
    // Object 2 ends at x 7, so +X would fall off and -X is taken instead.
    expect(duplicateOffset(volume, objectBounds(volume, 2))).toEqual([-3, 0, 0])
    // Nothing to move out of the way.
    expect(duplicateOffset(volume, undefined)).toEqual([0, 0, 0])

    // An object that fills the grid has no room on any axis, in either direction.
    const full = createVolume(2, 2, 2, new Uint8Array(256 * 4))
    for (let x = 0; x < 2; x += 1)
        for (let y = 0; y < 2; y += 1) for (let z = 0; z < 2; z += 1) setVoxel(full, x, y, z, 4)
    initialObjects(full)
    expect(duplicateOffset(full, objectBounds(full, 1))).toBeUndefined()
})
