import {expect, test} from 'bun:test'
import {createVolume, setVoxel, type Volume} from '../render/volume'
import {readVox} from '../vox/vox-file'
import {MAX_CANDIDATES} from './ask'
import {BUILT_IN_REPLIES} from './builtin'
import {specFromCode} from './code'
import {
    admit,
    gateFailure,
    gateReason,
    gateStatus,
    GATE,
    MAX_RESAMPLES,
    NOTHING_GATED,
    resampleBudget
} from './gate'
import {rasterise} from './ops'
import {scoreModel, type ModelScores} from './score'

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

const exampleScores = (id: string, canvas?: number): ModelScores => {
    const reply = BUILT_IN_REPLIES[id]
    if (reply === undefined) throw new Error(`no built-in reply for ${id}`)
    const spec = specFromCode(reply, id)
    if (!spec) throw new Error(`the ${id} example is not a program`)
    return scoreModel(rasterise(spec, canvas))
}

/**
 * The one test this module exists to pass.
 *
 * The worked examples are the ceiling of everything the generator produces — measured twice on
 * 2026-08-08, in both directions — so a threshold that rejects one of them is not a strict gate, it
 * is a gate calibrated above the best thing this pipeline can do. Both grids are checked because
 * both ship: fitted is the "Enforce canvas size — off" path, and 32 is the default ask.
 */
test('every worked example passes the gate, fitted and at the default canvas', () => {
    for (const [id, reply] of Object.entries(BUILT_IN_REPLIES)) {
        if (reply === undefined) continue
        for (const canvas of [undefined, 32]) {
            const verdict = gateFailure(exampleScores(id, canvas)) ?? 'kept'
            // The id and the sentence are in the assertion so a failure names the example.
            expect(`${id} at ${String(canvas ?? 'fitted')}: ${verdict}`).toBe(
                `${id} at ${String(canvas ?? 'fitted')}: kept`
            )
        }
    }
})

/**
 * The other side of the same rule, on a model no generator wrote.
 *
 * `car.vox` is the only artist-made model in the repo — 478 voxels, 3 colours, and a subject the
 * generator is measured to be *bad* at (finding 4, directional machines). It has to walk through.
 */
test('a model an artist made passes the gate', async () => {
    const car = readVox(
        new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
    )
    expect(gateFailure(scoreModel(car))).toBeUndefined()
})

test('a brick, an empty grid and a scatter of debris each fail for their own reason', () => {
    const brick = box(createVolume(12, 12, 12), [0, 0, 0], [11, 11, 11])
    const nothing = createVolume(12, 12, 12)
    // Five separated 3³ lumps: 135 voxels, so this is a connectivity failure and not a size one.
    const debris = createVolume(16, 16, 16)
    for (const at of [0, 13]) {
        box(debris, [at, at, at], [at + 2, at + 2, at + 2])
        box(debris, [at, 13 - at, at], [at + 2, 15 - at, at + 2])
    }
    box(debris, [7, 7, 7], [9, 9, 9])

    expect(gateReason(scoreModel(nothing))).toBe('empty')
    expect(gateReason(scoreModel(brick))).toBe('brick')
    expect(gateReason(scoreModel(debris))).toBe('debris')

    const said = [nothing, brick, debris].map(volume => gateFailure(scoreModel(volume)))
    expect(new Set(said).size).toBe(3)
    // Every sentence carries the number that failed, because the flag exists to be calibrated.
    expect(said[1]).toContain('100%')
})

/**
 * The case `minSliceUsage` is in the gate for, and the case that shows why `minConnectivity` alone
 * is not enough: 4 voxels of hat over 640 of body is 0.99 connectivity and walks through.
 */
test('a small piece floating high is caught by layers, not by voxels', () => {
    const floating = box(createVolume(8, 8, 16), [0, 0, 0], [7, 7, 9])
    box(floating, [3, 3, 15], [4, 4, 15])
    const scores = scoreModel(floating)

    expect(scores.connectivity).toBeGreaterThan(GATE.minConnectivity)
    expect(gateReason(scores)).toBe('floating')
    expect(gateFailure(scores)).toContain('layers')
})

test('a reply that painted one small lump is tiny rather than a brick', () => {
    // `specFromCode` keeps the ops painted before a crash, so half a program arrives as a die.
    const die = box(createVolume(8, 8, 8), [0, 0, 0], [2, 2, 2])
    expect(scoreModel(die).bboxFill).toBe(1)
    // Both readings are true; the useful half of the sentence is the size.
    expect(gateReason(scoreModel(die))).toBe('tiny')
    expect(gateFailure(scoreModel(die))).toContain('27')
})

/**
 * The thresholds against the numbers that produced them, rather than against volumes built here.
 * These five figures are all from `docs/GEN_RESEARCH.md` and `docs/GEN_IDEAS.md`.
 */
test("the record's own numbers land on the side of the gate the record puts them on", () => {
    const like = (over: Partial<ModelScores>): ModelScores => ({
        connectivity: 1,
        sliceUsage: 1,
        bboxFill: 0.45,
        colorsUsed: 4,
        shellColors: 4,
        voxels: 524,
        ...over
    })

    // "1 in fragments at 0.59 connectivity" — the fish, 2026-08-09.
    expect(gateReason(like({connectivity: 0.59}))).toBe('debris')
    // Three of six "a stone tower" candidates, 2026-08-08: every score exactly 1.000.
    expect(gateReason(like({bboxFill: 1, sliceUsage: 1, connectivity: 1}))).toBe('brick')
    // The 128 canvas run, 2026-08-11: 88 % of its own bounding box.
    expect(gateReason(like({bboxFill: 0.88}))).toBe('brick')

    // And the keeps: the bank's densest example, and the artist's car.
    expect(gateReason(like({bboxFill: 0.63}))).toBeUndefined()
    expect(gateReason(like({bboxFill: 0.57, colorsUsed: 3, voxels: 478}))).toBeUndefined()
})

test('the resample budget is finite and bounded for every count the dialog offers', () => {
    let previous = 0
    for (let count = 1; count <= MAX_CANDIDATES; count += 1) {
        const budget = resampleBudget(count)
        expect(Number.isInteger(budget)).toBe(true)
        expect(budget).toBeGreaterThanOrEqual(0)
        expect(budget).toBeLessThanOrEqual(MAX_RESAMPLES)
        // Never more extra seeds than candidates asked for: a batch may double, and no more.
        expect(budget).toBeLessThanOrEqual(count)
        expect(budget).toBeGreaterThanOrEqual(previous)
        previous = budget
    }
    expect(resampleBudget(MAX_CANDIDATES)).toBe(MAX_RESAMPLES)

    // A loop condition is not the place for NaN, which is why these are numbers and not a throw.
    expect(resampleBudget(0)).toBe(0)
    expect(resampleBudget(-3)).toBe(0)
    expect(resampleBudget(NaN)).toBe(0)
    expect(resampleBudget(Infinity)).toBe(0)
    expect(resampleBudget(2.7)).toBe(2)
})

/**
 * The knight: 0 of 8 passed on 2026-08-08, so a prompt exists where every seed fails the gate.
 *
 * It must terminate, and it must terminate holding candidates. An artist who waited two minutes for
 * an empty grid has been given less than one who was handed four sprites they can see are wrong.
 */
test('a prompt that fails every seed ends with candidates, not with an empty grid', () => {
    const brick = scoreModel(box(createVolume(12, 12, 12), [0, 0, 0], [11, 11, 11]))
    const count = 4
    let tally = NOTHING_GATED
    let attempts = 0
    let shown = 0
    while (shown < count) {
        attempts += 1
        // The bound, asserted inside the loop so a broken cap fails here instead of hanging.
        expect(attempts).toBeLessThanOrEqual(count + MAX_RESAMPLES)
        const admission = admit(brick, tally, count)
        tally = admission.tally
        // The sentence survives being kept anyway, so the card can carry what the gate thought.
        expect(admission.failure).toContain('brick')
        if (admission.keep) shown += 1
    }

    expect(shown).toBe(count)
    expect(attempts).toBe(count + resampleBudget(count))
    expect(tally.rejected).toBe(resampleBudget(count))
    expect(tally.keptAnyway).toBe(count)
    expect(tally.kept).toBe(0)
    expect(gateStatus(tally)).toContain('shown anyway')
})

test('the tally counts rejects by reason and the status line names them', () => {
    const good = exampleScores('farmer')
    const brick = scoreModel(box(createVolume(12, 12, 12), [0, 0, 0], [11, 11, 11]))
    const nothing = scoreModel(createVolume(12, 12, 12))

    let tally = NOTHING_GATED
    for (const scores of [good, brick, nothing, brick]) {
        tally = admit(scores, tally, 8).tally
    }

    expect(tally.kept).toBe(1)
    expect(tally.rejected).toBe(3)
    expect(tally.keptAnyway).toBe(0)
    expect(tally.reasons.brick).toBe(2)
    expect(tally.reasons.empty).toBe(1)
    expect(tally.reasons.debris).toBe(0)
    expect(gateStatus(tally)).toBe('Gates: 1 kept, 3 resampled (empty ×1, brick ×2)')
})

test('a batch nothing has happened to draws no status line at all', () => {
    expect(gateStatus(NOTHING_GATED)).toBe('')
    // A passing candidate keeps the tally clean: no reasons, nothing spent.
    const passed = admit(exampleScores('dog'), NOTHING_GATED, 4)
    expect(passed.keep).toBe(true)
    expect(passed.failure).toBeUndefined()
    expect(passed.tally.rejected).toBe(0)
    expect(gateStatus(passed.tally)).toBe('Gates: 1 kept')
})

/*
 * A prop swaps one rule for another — `gen/face.ts`. Measured live 2026-08-11 on "a Mario brick
 * block": the model wrote sensible code and this gate rejected it at 83 % solid and at 95 %, because
 * every rule in it was written for a cat.
 */
test('a solid block is kept when it declared its content is on its surface', () => {
    const block: ModelScores = {
        connectivity: 1,
        sliceUsage: 1,
        // The two figures the live brick run actually came back at.
        bboxFill: 0.95,
        colorsUsed: 10,
        shellColors: 5,
        voxels: 3904
    }

    expect(gateReason(block)).toBe('brick')
    expect(gateReason(block, true)).toBeUndefined()
    expect(gateFailure(block, true)).toBeUndefined()
})

test('a prop with nothing on its surface is flat, which is the brick rule for props', () => {
    const bare: ModelScores = {
        connectivity: 1,
        sliceUsage: 1,
        bboxFill: 1,
        colorsUsed: 1,
        shellColors: 1,
        voxels: 4096
    }

    expect(gateReason(bare, true)).toBe('flat')
    expect(gateFailure(bare, true)).toContain('only 1 colour')
    // Two is a base and one highlight — a cube somebody started shading and stopped.
    expect(gateReason({...bare, shellColors: 2}, true)).toBe('flat')
    // Three is a bevel, which is a prop.
    expect(gateReason({...bare, shellColors: 3}, true)).toBeUndefined()
})

test('the rules a prop still has to pass are the ones that are not about silhouette', () => {
    const debris: ModelScores = {
        connectivity: 0.4,
        sliceUsage: 1,
        bboxFill: 0.9,
        colorsUsed: 6,
        shellColors: 6,
        voxels: 900
    }
    // Being a surface excuses being solid. It does not excuse being in pieces.
    expect(gateReason(debris, true)).toBe('debris')
    expect(gateReason({...debris, connectivity: 1, voxels: 4}, true)).toBe('tiny')
    expect(gateReason({...debris, connectivity: 1, voxels: 0}, true)).toBe('empty')
})
