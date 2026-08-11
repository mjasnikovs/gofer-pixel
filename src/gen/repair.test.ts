import {expect, test} from 'bun:test'
import {createVolume, setVoxel, voxelAt, type Volume} from '../render/volume'
import {BUILT_IN_REPLIES} from './builtin'
import {specFromCode} from './code'
import {countFilled, rasterise} from './ops'
import {
    bridgeGaps,
    components,
    dropDebris,
    dropToFloor,
    repair,
    SPINDLE_RUN,
    symmetrise,
    SYMMETRY_HIGH,
    thickenSpindles,
    xAgreement
} from './repair'
import {connectivity} from './score'

const box = (
    volume: Volume,
    [x0, y0, z0]: readonly [number, number, number],
    [x1, y1, z1]: readonly [number, number, number],
    value = 1
): Volume => {
    for (let x = x0; x <= x1; x += 1)
        for (let y = y0; y <= y1; y += 1)
            for (let z = z0; z <= z1; z += 1) setVoxel(volume, x, y, z, value)
    return volume
}

const QUIET = {dropped: 0, bridged: 0, lifted: 0, thickened: 0, mirrored: false}

const rasterised = (id: string): Volume => {
    const spec = specFromCode(BUILT_IN_REPLIES[id] ?? '', id)
    if (!spec) throw new Error(`the ${id} example painted nothing`)
    return rasterise(spec)
}

/**
 * The test the thresholds were chosen against, and the one that has to fail first.
 *
 * `GEN_IDEAS.md` §1: "a repair that fires on a good model is worse than a failure that is honest".
 * The five worked examples are the best models this pipeline can produce — they are the ceiling
 * every candidate is taught from — so **not one rule may touch them**, and the assertion is object
 * identity rather than a voxel comparison, because that is also what tells a caller the pass was a
 * no-op.
 *
 * Nothing fires on any of the five. The closest call is measured in the next test.
 */
test('repair is the identity on every worked example in the bank', () => {
    const ids = Object.keys(BUILT_IN_REPLIES)
    expect(ids).toHaveLength(5)
    for (const id of ids) {
        const volume = rasterised(id)
        const {volume: out, report} = repair(volume)
        expect({id, same: out === volume}).toEqual({id, same: true})
        expect({id, ...report}).toEqual({id, ...QUIET})
    }
})

/**
 * The tower is the one example with a deliberate asymmetry in it — a window on a face whose
 * opposite has none — and it is what puts the ceiling under `symmetrise`. Six voxels of 1448. If
 * this number ever drops under `SYMMETRY_HIGH`, the pass starts putting a fourth window on a tower
 * that was drawn with three.
 */
test('the tower clears the symmetry ceiling by six voxels, and that is the whole margin', () => {
    const tower = rasterised('tower')

    expect(countFilled(tower)).toBe(1448)
    expect(xAgreement(tower)).toBeCloseTo(1442 / 1448, 6)
    expect(xAgreement(tower)).toBeGreaterThan(SYMMETRY_HIGH)
    expect(symmetrise(tower).volume).toBe(tower)
})

test('an empty grid is left alone rather than divided by nothing', () => {
    const empty = createVolume(4, 4, 4)
    const {volume, report} = repair(empty)

    expect(volume).toBe(empty)
    expect(report).toEqual(QUIET)
    expect(xAgreement(empty)).toBe(1)
    expect(components(empty).largest).toBe(-1)
})

test('a floating hat one cell over the head is bridged, in the hat own colour', () => {
    const volume = box(createVolume(8, 8, 8), [2, 2, 0], [5, 5, 3], 1)
    box(volume, [2, 2, 5], [5, 5, 5], 2)
    expect(components(volume).sizes).toHaveLength(2)

    const {volume: out, bridged} = bridgeGaps(volume)

    // The contact footprint, not one pillar: the join is what the two parts were reaching for.
    expect(bridged).toBe(16)
    expect(voxelAt(out, 2, 2, 4)).toBe(2)
    expect(voxelAt(out, 5, 5, 4)).toBe(2)
    // And the two definitions of "one piece" agree — `score.ts` has the same walk.
    expect(connectivity(out)).toBe(1)
    expect(components(out).sizes).toHaveLength(1)
    // The input is a value, not a workspace.
    expect(countFilled(volume)).toBe(64 + 16)
})

test('a corner touch is a gap too, because the flood fill calls it two lumps', () => {
    const volume = createVolume(8, 8, 8)
    setVoxel(volume, 1, 1, 1, 4)
    setVoxel(volume, 2, 2, 1, 4)
    expect(connectivity(volume)).toBe(0.5)

    const {volume: out, bridged} = bridgeGaps(volume)

    // Both cells that complete the L touch both lumps, so both are filled and the join is square.
    expect(bridged).toBe(2)
    expect(connectivity(out)).toBe(1)
})

/**
 * A bridge can land against a second loose lump on its way past, and that lump is then already
 * attached. Without the check it gets a bridge of its own — voxels added to close a gap that is
 * closed, which is the one way this rule can invent geometry nobody asked for.
 */
test('a lump the first bridge already caught does not get a second bridge', () => {
    const volume = box(createVolume(8, 8, 8), [0, 0, 0], [0, 0, 7], 1)
    setVoxel(volume, 2, 0, 0, 2)
    setVoxel(volume, 1, 1, 0, 3)
    expect(components(volume).sizes).toHaveLength(3)

    const {volume: out, bridged} = bridgeGaps(volume)

    expect(bridged).toBe(1)
    expect(voxelAt(out, 1, 0, 0)).toBe(2)
    expect(connectivity(out)).toBe(1)
    expect(countFilled(out)).toBe(11)
})

test('two empty cells is not a gap, and what cannot be reattached is dropped', () => {
    const volume = box(createVolume(8, 8, 8), [0, 0, 0], [3, 3, 3], 1)
    setVoxel(volume, 0, 0, 6, 2)

    expect(bridgeGaps(volume).bridged).toBe(0)
    expect(repair(volume).report).toEqual({...QUIET, dropped: 1})
})

test('debris is what is small, not what is loose: a structural part survives detached', () => {
    // 8 voxels against 64 is an eighth — over `DEBRIS_FRACTION`, so this is a part, not a speck.
    const part = box(createVolume(8, 8, 8), [0, 0, 0], [3, 3, 3], 1)
    box(part, [6, 6, 6], [7, 7, 7], 2)
    expect(dropDebris(part).volume).toBe(part)

    // Half of it — 4 of 64 — and it goes. Deleting a detached head hides the failure; deleting a
    // stray cube loses nothing.
    const speck = box(createVolume(8, 8, 8), [0, 0, 0], [3, 3, 3], 1)
    box(speck, [6, 6, 6], [7, 7, 6], 2)
    const {volume: out, dropped} = dropDebris(speck)
    expect(dropped).toBe(4)
    expect(countFilled(out)).toBe(64)
    expect(voxelAt(out, 6, 6, 6)).toBe(0)
})

test('a model already on the floor is not moved', () => {
    const grounded = box(createVolume(8, 8, 8), [1, 1, 0], [2, 2, 2], 1)
    const {volume, lifted} = dropToFloor(grounded)

    expect(volume).toBe(grounded)
    expect(lifted).toBe(0)
})

test('a hovering model comes down to z = 0 with every voxel and colour it had', () => {
    const hovering = box(createVolume(8, 8, 8), [1, 1, 3], [2, 2, 5], 7)
    const {volume, lifted} = dropToFloor(hovering)

    expect(lifted).toBe(3)
    expect(voxelAt(volume, 1, 1, 0)).toBe(7)
    expect(voxelAt(volume, 2, 2, 2)).toBe(7)
    expect(countFilled(volume)).toBe(countFilled(hovering))
    expect([volume.sx, volume.sy, volume.sz]).toEqual([8, 8, 8])
})

/**
 * The reason `dropToFloor` runs last. A stray voxel on the ground is what `rasterise` fitted the
 * grid to, so deleting it as debris leaves the model hanging a layer over the lattice.
 */
test('the floor is found after the debris that was holding the model up', () => {
    const volume = box(createVolume(8, 8, 8), [2, 2, 1], [5, 5, 4], 1)
    setVoxel(volume, 7, 7, 0, 2)

    const {volume: out, report} = repair(volume)

    expect(report).toEqual({...QUIET, dropped: 1, lifted: 1})
    expect(voxelAt(out, 2, 2, 0)).toBe(1)
    expect(countFilled(out)).toBe(64)
})

test('a four-tall 1x1 column is widened and a three-tall one is left alone', () => {
    const pin = createVolume(8, 8, 8)
    box(pin, [4, 4, 0], [4, 4, SPINDLE_RUN - 1], 5)
    const {volume: out, thickened} = thickenSpindles(pin)

    // A lone column stands on its own centre line, so it has no outward side and takes both —
    // three wide and still centred, rather than two wide and half a cell off.
    expect(thickened).toBe(2 * SPINDLE_RUN)
    expect(voxelAt(out, 3, 4, 0)).toBe(5)
    expect(voxelAt(out, 5, 4, 3)).toBe(5)
    expect(voxelAt(out, 4, 5, 0)).toBe(0)

    const stub = createVolume(8, 8, 8)
    box(stub, [4, 4, 0], [4, 4, SPINDLE_RUN - 2], 5)
    expect(thickenSpindles(stub).volume).toBe(stub)
})

/**
 * Why the widening goes outward rather than `+x`, which was the first version.
 *
 * With `+x` for both legs the model's x span becomes 2…6, the mirror plane moves half a cell, and
 * `xAgreement` on a model that was a perfect 1.0000 falls to exactly 0.80 — inside `symmetrise`'s
 * band, so the next rule in the pass reflects a body it had no business touching.
 */
test('a symmetric pair of thin legs is widened outward, so the mirror plane does not move', () => {
    const volume = box(createVolume(8, 8, 8), [2, 2, 4], [5, 5, 7], 1)
    box(volume, [2, 2, 0], [2, 2, 3], 2)
    box(volume, [5, 2, 0], [5, 2, 3], 2)
    expect(xAgreement(volume)).toBe(1)

    const {volume: out, thickened} = thickenSpindles(volume)

    expect(thickened).toBe(8)
    expect(voxelAt(out, 1, 2, 0)).toBe(2)
    expect(voxelAt(out, 6, 2, 0)).toBe(2)
    // Inward was the other candidate, and it welds two legs three cells apart into a slab.
    expect(voxelAt(out, 3, 2, 0)).toBe(0)
    expect(voxelAt(out, 4, 2, 0)).toBe(0)
    expect(xAgreement(out)).toBe(1)
    expect([out.sx, out.sy, out.sz]).toEqual([8, 8, 8])
})

test('a column against the wall of the grid widens the only way it can', () => {
    const volume = createVolume(8, 8, 8)
    box(volume, [7, 4, 0], [7, 4, 3], 5)

    const {volume: out, thickened} = thickenSpindles(volume)

    expect(thickened).toBe(SPINDLE_RUN)
    expect(voxelAt(out, 6, 4, 0)).toBe(5)
})

test('a model missing one leg gets the better half reflected, in that half colour', () => {
    const volume = box(createVolume(8, 8, 12), [2, 2, 4], [5, 5, 9], 1)
    box(volume, [2, 2, 0], [3, 3, 3], 2)
    // 96 of body, all matched, against 16 of leg that has nothing across the plane.
    expect(xAgreement(volume)).toBeCloseTo(96 / 112, 6)

    const {volume: out, mirrored} = symmetrise(volume)

    expect(mirrored).toBe(true)
    expect(xAgreement(out)).toBe(1)
    expect(countFilled(out)).toBe(96 + 32)
    // The colour comes off the half that was kept. Nothing here invents one.
    expect(voxelAt(out, 4, 2, 0)).toBe(2)
    expect(voxelAt(out, 5, 3, 3)).toBe(2)
})

test('a model that is not nearly symmetric is not made symmetric', () => {
    // A staircase: 0.56 agreement, which is a subject rather than a defect.
    const stair = createVolume(8, 8, 8)
    for (let x = 0; x < 8; x += 1) box(stair, [x, 0, 0], [x, 0, x], 1)

    expect(xAgreement(stair)).toBeLessThan(0.6)
    expect(symmetrise(stair).volume).toBe(stair)
    expect(repair(stair).report.mirrored).toBe(false)
})

/**
 * The middle column of an odd-width model is its own mirror: it belongs to both halves, the plane
 * passes through it, and reflecting it is the identity. So it is left byte for byte alone — a rule
 * that "corrected" it would be inventing a seam down the middle of the model.
 */
test('the middle column of an odd width is left exactly where it is', () => {
    const volume = box(createVolume(8, 8, 10), [2, 2, 0], [6, 5, 7], 1)
    box(volume, [2, 2, 8], [3, 3, 8], 2)
    setVoxel(volume, 4, 3, 5, 9)
    const middle = Array.from({length: 10}, (_, z) => voxelAt(volume, 4, 3, z))

    const {volume: out, mirrored} = symmetrise(volume)

    expect(mirrored).toBe(true)
    expect(Array.from({length: 10}, (_, z) => voxelAt(out, 4, 3, z))).toEqual(middle)
    expect(voxelAt(out, 4, 3, 5)).toBe(9)
    // The bump was reflected onto the other side, so the width itself did not change.
    expect(voxelAt(out, 5, 3, 8)).toBe(2)
    expect(xAgreement(out)).toBe(1)
})

test('a broken model is bridged, cleaned and grounded in one pass, and reports each', () => {
    const volume = box(createVolume(12, 12, 12), [3, 3, 2], [8, 8, 7], 1)
    box(volume, [3, 3, 9], [8, 8, 9], 2)
    setVoxel(volume, 11, 11, 11, 3)

    const {volume: out, report} = repair(volume)

    expect(report).toEqual({dropped: 1, bridged: 36, lifted: 2, thickened: 0, mirrored: false})
    expect(out).not.toBe(volume)
    expect(connectivity(out)).toBe(1)
    // Never resized, and the model is on the floor.
    expect([out.sx, out.sy, out.sz]).toEqual([12, 12, 12])
    expect(voxelAt(out, 3, 3, 0)).toBe(1)
    // Never a colour that was not already on a voxel: 1 body, 2 hat, and 3 went out with the speck.
    const used = new Set(out.data.filter(value => value !== 0))
    expect([...used].sort((a, b) => a - b)).toEqual([1, 2])
    // The input is untouched, so a caller can still show what it was handed.
    expect(countFilled(volume)).toBe(216 + 36 + 1)
})
