import {expect, test} from 'bun:test'
import MANIFEST from '../assets/examples/examples.json'
import {volumeFromFile} from '../doc/models'
import {
    exampleFrom,
    MAX_PICKS,
    overBudget,
    pickPrompt,
    readManifest,
    readPicks,
    type Manifest
} from './bank'
import {BUILT_IN_REPLIES} from './builtin'
import {specFromCode} from './code'
import {buildLibrary} from './library'
import {rasterise} from './ops'
import {scoreModel} from './score'
import {readVox} from '../vox/vox-file'

const manifest = readManifest(MANIFEST)
if (!manifest) throw new Error('src/assets/examples/examples.json is not a manifest')

/**
 * The bank exactly as the app loads it, minus the bundler.
 *
 * `import.meta.glob` is a Vite transform and there is no Vite here, so the directory is read
 * straight off disk instead. Same manifest, same files, same decomposer — the route in is the only
 * difference, and it is the route the app's own `bundledSource` is a thin wrapper over.
 */
const fromDisk = async (file: string) => {
    const path = new URL(`../assets/examples/${file}`, import.meta.url)
    const found = Bun.file(path)
    if (!(await found.exists())) return undefined
    return volumeFromFile(file, new Uint8Array(await found.arrayBuffer()))
}

test('the shipped manifest reads, and every entry can teach', async () => {
    const library = await buildLibrary(manifest, fromDisk)
    for (const entry of manifest.entries) {
        const example = library.example(entry.id)
        expect(example).toBeDefined()
        expect(example?.prompt).toBe(entry.subject)
        expect(example?.reply ?? '').not.toBe('')
    }
})

/**
 * A broken example teaches breakage, and the examples are the highest-leverage thing in the prompt
 * — measured twice on 2026-08-08, in both directions. This is the floor under any of them, whether
 * it was typed by hand or decomposed out of an artist's model.
 */
test('every worked example is a model, not a story about one', async () => {
    const library = await buildLibrary(manifest, fromDisk)
    for (const entry of manifest.entries) {
        const example = library.example(entry.id)
        if (!example) throw new Error(`no example for ${entry.id}`)

        const spec = specFromCode(example.reply, entry.id)
        expect(spec).toBeDefined()
        if (!spec) continue

        const volume = rasterise(spec)
        const scores = scoreModel(volume)
        // One connected piece, standing up, and nowhere near a solid brick.
        expect(scores.connectivity).toBe(1)
        expect(scores.bboxFill).toBeLessThan(0.75)
        expect(volume.sz).toBeGreaterThan(8)
        // And it has to fit: every candidate in every batch pays for it in full.
        expect(overBudget(example)).toBe(false)
    }
})

test('the picking prompt is the manifest, so a new entry needs no code', () => {
    const prompt = pickPrompt(manifest)
    for (const entry of manifest.entries) {
        expect(prompt).toContain(entry.id)
        expect(prompt).toContain(entry.use)
    }
    expect(prompt).toContain(String(MAX_PICKS))
})

test('a pick is the ids it named, in order, capped and deduplicated', () => {
    expect(readPicks('dog, chicken', manifest)).toEqual(['dog', 'chicken'])
    // Order is the model's answer, not the manifest's.
    expect(readPicks('tower farmer', manifest)).toEqual(['tower', 'farmer'])
    expect(readPicks('dog, dog, dog', manifest)).toEqual(['dog'])
    expect(readPicks('dog chicken farmer mushroom tower', manifest)).toHaveLength(MAX_PICKS)
    // Words that are not ids are dropped rather than guessed at.
    expect(readPicks('probably some kind of dog really', manifest)).toEqual(['dog'])
})

test('a pick that names nothing falls back to one example rather than to none', () => {
    // A prompt with no worked example in it is the 0-of-12 case, which is worse than a wrong one.
    expect(readPicks('I think it is a sort of vehicle', manifest)).toEqual([manifest.fallback])
    expect(readPicks('', manifest)).toEqual([manifest.fallback])
})

test('the closest example is sent last, nearest the prompt', async () => {
    const library = await buildLibrary(manifest, fromDisk)
    const taught = library.teach(['dog', 'tower'])
    expect(taught).toHaveLength(2)
    expect(taught[1]?.prompt).toBe('a dog')
})

test('an id with no example is dropped from the turns rather than sent as a hole', async () => {
    const library = await buildLibrary(manifest, fromDisk)
    expect(library.teach(['dog', 'nosuchthing'])).toHaveLength(1)
    expect(library.example('nosuchthing')).toBeUndefined()
})

test('an entry with a file teaches from the file, and falls back when it will not load', async () => {
    const entries = [
        {id: 'tower', subject: 'a stone tower', use: 'buildings', notes: '', file: 'missing.vox'}
    ]
    const library = await buildLibrary({fallback: 'tower', entries}, () =>
        Promise.resolve(undefined)
    )
    // A named file that will not load is a stale teacher, which beats no teacher at all.
    expect(library.example('tower')?.reply).toBe(BUILT_IN_REPLIES['tower'])

    const car = readVox(
        new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
    )
    const real = await buildLibrary({fallback: 'tower', entries}, () => Promise.resolve(car))
    expect(real.example('tower')?.reply).toContain('box(')
    expect(real.example('tower')?.reply).not.toBe(BUILT_IN_REPLIES['tower'])
})

test('a decomposed example opens on the notes when there are any, and measurements otherwise', async () => {
    const car = readVox(
        new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
    )
    const written = exampleFrom(
        {
            id: 'car',
            subject: 'a car',
            use: 'vehicles',
            notes: 'cabin set back, wheels at the corners'
        },
        car
    )
    expect(written.reply.split('\n')[0]).toBe('// car: cabin set back, wheels at the corners')

    const measured = exampleFrom({id: 'car', subject: 'a car', use: 'vehicles', notes: ''}, car)
    // The measurements still say a plan comes before the code, which is most of what it is for.
    expect(measured.reply.split('\n')[0]).toBe('// car: 14 wide, 6 tall, 10 long')
})

test('a manifest that is not one is refused, and a broken entry costs one teacher', () => {
    expect(readManifest(null)).toBeUndefined()
    expect(readManifest({entries: []})).toBeUndefined()
    expect(readManifest({fallback: 'a', entries: [{id: 'a'}]})).toBeUndefined()

    const partial: Manifest | undefined = readManifest({
        fallback: 'tower',
        entries: [{id: 'tower', subject: 'a tower', use: 'buildings'}, {id: 'broken'}]
    })
    expect(partial?.entries).toHaveLength(1)
})

test('a fallback that names nothing in the bank falls back to the first entry', () => {
    const read = readManifest({
        fallback: 'gone',
        entries: [{id: 'tower', subject: 'a tower', use: 'buildings'}]
    })
    // A bank still has to answer, and answering with an id nobody has teaches nothing.
    expect(read?.fallback).toBe('tower')
})
