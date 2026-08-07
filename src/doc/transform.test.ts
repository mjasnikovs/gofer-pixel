import {expect, test} from 'bun:test'
import {createVolume, setVoxel, voxelAt, type Volume} from '../render/volume'
import {beginEdit, commitEdit, revertEdit, writeVoxel} from './edits'
import {cellOf, selectBox, selectColor, selectionBounds, type Selection} from './selection'
import {canRadial, NO_SYMMETRY, symmetricCells, symmetryMaps} from './symmetry'
import {
    arrayCells,
    deleteCells,
    duplicateCells,
    fitsAfter,
    flipCells,
    lossCount,
    mirrorCells,
    moveCells,
    paintCells,
    rotateCells
} from './transform'

/** An L, so every rotation and flip is distinguishable from every other. */
const ell = (): Volume => {
    const volume = createVolume(8, 8, 8, new Uint8Array(256 * 4))
    for (let y = 0; y < 3; y += 1) setVoxel(volume, 1, 1 + y, 0, 4)
    setVoxel(volume, 2, 1, 0, 7)
    return volume
}

const cells = (volume: Volume, selection: Selection): string[] =>
    [...selection].map(index => cellOf(volume, index).join(',')).sort((a, b) => a.localeCompare(b))

const occupied = ({data}: Volume): number =>
    data.reduce((count, value) => (value === 0 ? count : count + 1), 0)

test('moving is exact, and voxels pushed off the grid are dropped rather than piled up', () => {
    const volume = ell()
    const draft = beginEdit(volume)
    const selection = selectBox(volume, [0, 0, 0], [7, 7, 7])

    const moved = moveCells(draft, selection, [2, 0, 3])
    expect(cells(draft.volume, moved)).toEqual(['3,1,3', '3,2,3', '3,3,3', '4,1,3'])
    expect(occupied(draft.volume)).toBe(4)
    expect(voxelAt(draft.volume, 3, 1, 3)).toBe(4)
    expect(voxelAt(draft.volume, 4, 1, 3)).toBe(7)
    expect(voxelAt(draft.volume, 1, 1, 0)).toBe(0)

    // Off the edge is gone, not clamped into a heap against the wall.
    const off = moveCells(draft, moved, [0, 0, 6])
    expect(off.size).toBe(0)
    expect(occupied(draft.volume)).toBe(0)
})

test('an overlapping move does not eat the cells it has not read yet', () => {
    const volume = createVolume(8, 1, 1, new Uint8Array(256 * 4))
    for (let x = 0; x < 4; x += 1) setVoxel(volume, x, 0, 0, x + 1)
    const draft = beginEdit(volume)

    moveCells(draft, selectBox(volume, [0, 0, 0], [7, 0, 0]), [1, 0, 0])
    expect([...draft.volume.data]).toEqual([0, 1, 2, 3, 4, 0, 0, 0])
})

test('four quarter turns are the identity, and one is not', () => {
    const volume = ell()
    const start = selectBox(volume, [0, 0, 0], [7, 7, 7])

    for (const axis of [0, 1, 2] as const) {
        const draft = beginEdit(volume)
        const once = rotateCells(draft, start, axis, 1)
        expect(cells(draft.volume, once)).not.toEqual(cells(volume, start))
        rotateCells(draft, once, axis, 3)
        expect([...draft.volume.data]).toEqual([...volume.data])
    }
})

test('a quarter turn keeps every voxel, its colours, and the corner of its box', () => {
    const volume = ell()
    const draft = beginEdit(volume)
    const before = selectBox(volume, [0, 0, 0], [7, 7, 7])
    const box = selectionBounds(volume, before)

    const after = rotateCells(draft, before, 2, 1)
    expect(after.size).toBe(before.size)
    expect(occupied(draft.volume)).toBe(4)
    expect(selectColor(draft.volume, 7).size).toBe(1)
    expect(selectionBounds(draft.volume, after)?.min).toEqual(box?.min as never)
})

test('flip turns the selection over where it stands; mirror leaves a second copy', () => {
    const volume = ell()

    const flipping = beginEdit(volume)
    const flipped = flipCells(flipping, selectBox(volume, [0, 0, 0], [7, 7, 7]), 1)
    expect(flipped.size).toBe(4)
    expect(occupied(flipping.volume)).toBe(4)
    // The box is unmoved and the L has turned over inside it.
    expect(selectionBounds(flipping.volume, flipped)).toEqual({min: [1, 1, 0], max: [2, 3, 0]})
    expect(voxelAt(flipping.volume, 2, 3, 0)).toBe(7)

    const mirroring = beginEdit(volume)
    const mirrored = mirrorCells(mirroring, selectBox(volume, [0, 0, 0], [7, 7, 7]), 0)
    expect(mirrored.size).toBe(8)
    expect(occupied(mirroring.volume)).toBe(8)
    // Across the middle of the grid: x = 1 has a partner at x = 6 in an 8-wide grid.
    expect(voxelAt(mirroring.volume, 6, 1, 0)).toBe(4)
    expect(voxelAt(mirroring.volume, 5, 1, 0)).toBe(7)
})

test('duplicate selects the copy so it can be nudged; array leaves a row of them', () => {
    const volume = ell()

    const one = beginEdit(volume)
    const copy = duplicateCells(one, selectBox(volume, [0, 0, 0], [7, 7, 7]), [0, 0, 1])
    expect(occupied(one.volume)).toBe(8)
    expect(copy.size).toBe(4)
    for (const index of copy) expect(cellOf(one.volume, index)[2]).toBe(1)

    const many = beginEdit(volume)
    const all = arrayCells(many, selectBox(volume, [0, 0, 0], [7, 7, 7]), [0, 0, 1], 3)
    expect(occupied(many.volume)).toBe(16)
    expect(all.size).toBe(16)
    // The fourth copy would run off the grid on an 8-tall volume only after 7 steps.
    expect(arrayCells(many, all, [0, 0, 4], 2).size).toBeLessThan(16 * 3)
})

test('delete and recolour are ordinary edits, and undo puts them back', () => {
    const volume = ell()

    const cutting = beginEdit(volume)
    expect(deleteCells(cutting, selectBox(volume, [0, 0, 0], [7, 7, 7])).size).toBe(0)
    const cut = commitEdit(cutting)
    if (!cut) throw new Error('delete changed cells')
    expect(occupied(cutting.volume)).toBe(0)
    expect(revertEdit(cutting.volume, cut).data).toEqual(volume.data)

    const painting = beginEdit(volume)
    paintCells(painting, selectBox(volume, [0, 0, 0], [7, 7, 7]), 12)
    expect(occupied(painting.volume)).toBe(4)
    expect(selectColor(painting.volume, 12).size).toBe(4)
})

test('a nudge that would push the selection off the grid is refused before it happens', () => {
    const volume = ell()
    const selection = selectBox(volume, [0, 0, 0], [7, 7, 7])
    expect(fitsAfter(volume, selection, [1, 0, 0])).toBe(true)
    expect(fitsAfter(volume, selection, [0, 0, -1])).toBe(false)
    expect(fitsAfter(volume, selection, [6, 0, 0])).toBe(false)
    expect(fitsAfter(volume, new Set(), [1, 0, 0])).toBe(false)
})

test('symmetry writes real voxels, and a cell on the plane is its own image', () => {
    const volume = createVolume(8, 8, 8)

    expect(symmetricCells(volume, NO_SYMMETRY, [1, 2, 3])).toEqual([[1, 2, 3]])
    expect(symmetricCells(volume, {...NO_SYMMETRY, x: true}, [1, 2, 3])).toEqual([
        [1, 2, 3],
        [6, 2, 3]
    ])
    // Two planes are four images, three are eight — and they are all distinct here.
    expect(symmetricCells(volume, {...NO_SYMMETRY, x: true, y: true}, [1, 2, 3])).toHaveLength(4)
    expect(
        symmetricCells(volume, {...NO_SYMMETRY, x: true, y: true, z: true}, [1, 2, 3])
    ).toHaveLength(8)

    // A voxel sitting on the mirror plane maps to itself, and must not be written twice.
    const odd = createVolume(7, 7, 7)
    expect(symmetricCells(odd, {...NO_SYMMETRY, x: true}, [3, 2, 1])).toEqual([[3, 2, 1]])
})

test('radial symmetry is four-fold, and is not offered on a grid it would not be exact on', () => {
    const square = createVolume(8, 8, 8)
    expect(canRadial(square)).toBe(true)
    const spun = symmetricCells(square, {...NO_SYMMETRY, radial: true}, [1, 2, 3])
    expect(spun).toHaveLength(4)
    // Every image is still inside the grid, which is the whole reason for the square rule.
    for (const [x, y, z] of spun) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThan(8)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThan(8)
        expect(z).toBe(3)
    }
    // Four turns come back to where they started, so the set closes.
    expect(new Set(spun.map(cell => cell.join(','))).size).toBe(4)

    const oblong = createVolume(8, 6, 8)
    expect(canRadial(oblong)).toBe(false)
    expect(symmetryMaps(oblong, {...NO_SYMMETRY, radial: true})).toHaveLength(1)
})

test('a symmetric write is one undo step, however many images it left', () => {
    const volume = createVolume(8, 8, 8, new Uint8Array(256 * 4))
    const draft = beginEdit(volume)
    for (const [x, y, z] of symmetricCells(volume, {...NO_SYMMETRY, x: true, y: true}, [1, 1, 1])) {
        writeVoxel(draft, x, y, z, 5)
    }
    const edit = commitEdit(draft)
    if (!edit) throw new Error('the symmetric write changed cells')
    expect(edit.at).toHaveLength(4)
    expect(revertEdit(draft.volume, edit).data).toEqual(volume.data)
    // Undo puts the ownership back too, or a hidden object would come back visible.
    expect(revertEdit(draft.volume, edit).owner).toEqual(volume.owner)
})

/**
 * What a drop would destroy, counted before it happens.
 *
 * A move overwrites whatever it lands on and says nothing, which is the one loss undo cannot make
 * obvious: a move onto air and a move that ate three voxels look identical afterwards. Refusing it
 * is not the answer — on a dense model the artist could never slide a voxel one step along a
 * surface — so the count is the answer, and it has to be exact or it is worse than nothing.
 *
 * O(selection) rather than a scan of the grid: this runs on every pointer move, next to a drag that
 * already copies the whole volume once, and doubling that bill for a warning is not a trade.
 */
test('a drop reports exactly how many voxels it would destroy', () => {
    const volume = ell()
    // A wall two steps to the right of the L, in its own colour so the loss is visible.
    for (let y = 0; y < 3; y += 1) setVoxel(volume, 3, 1 + y, 0, 9)
    const selection = selectColor(volume, 4)
    expect(selection.size).toBe(3)

    // Straight into the wall: every one of the three lands on a voxel that is not moving with it.
    expect(lossCount(volume, selection, [2, 0, 0], true)).toBe(3)
    // Along its own length: two of the three land on cells the L is vacating, and the third on air.
    expect(lossCount(volume, selection, [0, 1, 0], true)).toBe(0)
    // One step right is one voxel — the L's own foot, which is a different colour and not selected.
    expect(lossCount(volume, selection, [1, 0, 0], true)).toBe(1)
    // Away from everything.
    expect(lossCount(volume, selection, [0, 0, 4], true)).toBe(0)
    // Off the grid entirely: a move takes its voxels over the edge with it, which is the same loss
    // wearing a different hat and belongs in the same number.
    expect(lossCount(volume, selection, [-4, 0, 0], true)).toBe(3)

    // A copy vacates nothing, so the cells the original sits on count too: sliding it along its own
    // length now costs the two it used to be handed for free.
    expect(lossCount(volume, selection, [0, 1, 0], false)).toBe(2)
    expect(lossCount(volume, selection, [0, 0, 0], false)).toBe(3)
    // A copy that falls off the grid simply does not appear, and destroys nothing on the way.
    expect(lossCount(volume, selection, [-4, 0, 0], false)).toBe(0)

    // And the count is the loss: the model really does end that many voxels lighter.
    const draft = beginEdit(volume)
    const before = occupied(volume)
    moveCells(draft, selection, [2, 0, 0])
    expect(occupied(draft.volume)).toBe(before - 3)
})
