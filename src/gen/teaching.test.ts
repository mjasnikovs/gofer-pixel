import {expect, test} from 'bun:test'
import {createVolume, setVoxel} from '../render/volume'
import {magicaPalette} from '../vox/vox-file'
import type {WorkedExample} from './bank'
import {buildLibrary, type ModelSource} from './library'
import {readManifest} from './bank'
import MANIFEST from '../assets/examples/examples.json'
import {exampleFrom, LINE_BUDGET, lineCount, overBudget, teachingSet} from './teaching'

/**
 * Which examples teach a batch, in what order, within what budget.
 *
 * The budget is the one that had a hole in it. It was enforced on the model an artist drops on the
 * dialog and not on the bank's own entries, and both end up in the same array — so a 200-line model
 * checked in to `src/assets/examples/` was refused at the drop and accepted from disk.
 */

/** Two solid slabs: a handful of boxes, well inside the budget. */
const simple = (): ReturnType<typeof createVolume> => {
    const volume = createVolume(8, 8, 8, magicaPalette())
    for (let x = 1; x < 5; x += 1) {
        for (let y = 1; y < 5; y += 1) {
            for (let z = 1; z < 3; z += 1) setVoxel(volume, x, y, z, 1)
        }
    }
    return volume
}

/** No two neighbours the same colour, so every voxel costs its own line. */
const noisy = (): ReturnType<typeof createVolume> => {
    const volume = createVolume(16, 16, 16, magicaPalette())
    for (let i = 0; i < 16 * 16; i += 1) {
        const x = i % 16
        const y = Math.floor(i / 16)
        setVoxel(volume, x, y, (x + y) % 16, 1 + ((x * 7 + y * 3) % 200))
    }
    return volume
}

const entry = {id: 'thing', subject: 'a thing', use: 'things', notes: ''}

const named = (id: string): WorkedExample => ({prompt: id, reply: `// ${id}\nbox(0,0,0,1,1,1,1)`})

test('an example that fits says so, and one that does not says so too', () => {
    const small = exampleFrom(entry, simple())
    expect(small.fits).toBe(true)
    expect(lineCount(small.example)).toBeLessThanOrEqual(LINE_BUDGET)

    const big = exampleFrom(entry, noisy())
    expect(big.fits).toBe(false)
    expect(overBudget(big.example)).toBe(true)
    // The rejected example still comes back, because the artist is told how far over it went.
    expect(lineCount(big.example)).toBeGreaterThan(LINE_BUDGET)
})

test('the closest example goes last, and the artist’s own model goes after all of them', () => {
    const set = teachingSet([named('dog'), named('bird')], named('mine'))

    // Picked closest-first, sent closest-last, and the dropped model is nearer the prompt still.
    expect(set.map(one => one.prompt)).toEqual(['bird', 'dog', 'mine'])
})

test('with nothing dropped it is the bank, reversed, and nothing else', () => {
    expect(teachingSet([named('dog')], undefined).map(one => one.prompt)).toEqual(['dog'])
    expect(teachingSet([], undefined)).toEqual([])
    expect(teachingSet([], named('mine')).map(one => one.prompt)).toEqual(['mine'])
})

/*
 * The hole. `LINE_BUDGET` is a measurement about what a candidate can afford to be shown, and it
 * has to hold however the example got into the set — otherwise the check on the drop path is a
 * check on one of two doors into the same room.
 */
test('an example over the budget never reaches the batch, whichever door it came in by', () => {
    const {example: huge} = exampleFrom(entry, noisy())

    expect(teachingSet([huge], undefined)).toEqual([])
    expect(teachingSet([named('dog')], huge).map(one => one.prompt)).toEqual(['dog'])
})

test('a bank entry that decomposes past the budget falls back to its built-in reply', async () => {
    const manifest = readManifest(MANIFEST)
    if (!manifest) throw new Error('the shipped manifest should read')
    const first = manifest.entries[0]
    if (!first) throw new Error('the manifest should have entries')

    // A source that hands back a model far too detailed to teach from, for every entry.
    const tooMuch: ModelSource = () => Promise.resolve(noisy())
    const library = await buildLibrary(
        {...manifest, entries: [{...first, file: 'busy.vox'}]},
        tooMuch
    )

    const taught = library.teach([first.id])
    // Something is taught — a missing teacher is worse than a stale one — but not the huge one.
    for (const one of taught) expect(overBudget(one)).toBe(false)
})
