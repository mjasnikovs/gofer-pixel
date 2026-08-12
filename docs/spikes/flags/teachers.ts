/*
 * The one claim the whole bank rests on, tested: **are the worked examples the ceiling?**
 *
 *     bun docs/spikes/flags/teachers.ts
 *
 * `docs/GEN_RESEARCH.md` says twice that they are, measured in both directions on 2026-08-08 — a
 * better example lifted every output and a deliberately worse one dragged everything down to its own
 * flaws. Both of those were *hand-typed* examples. No real model has ever been in the bank, so the
 * claim that a real one lifts the output has never been tested at all.
 *
 * Same subjects, same fixed seeds, same everything, and one thing changed: the assistant turn is
 * either the hand-typed reply in `src/gen/builtin.ts` or a real CC-BY model decomposed by
 * `teaching.ts`'s own `exampleFrom`. Nothing else moves.
 *
 * The models are trimmed to their filled bounds first. `library.ts` does not do that — it hands the
 * decoded volume straight over — so a padded file would teach coordinates that start at 6 and a size
 * that counts air. A checked-in asset should be tight; this is what a tight one gives.
 *
 * The picking call is not made. Each subject's teacher is pinned below, so the only variable is
 * which reply that teacher is.
 */
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {BUILT_IN_REPLIES} from '../../../src/gen/builtin'
import {specFromCode} from '../../../src/gen/code'
import {DEFAULT_FLAGS} from '../../../src/gen/flags'
import {finish} from '../../../src/gen/finish'
import {rasterise} from '../../../src/gen/ops'
import {systemFor} from '../../../src/gen/llama'
import {overallScore, scoreModel} from '../../../src/gen/score'
import {exampleFrom, lineCount} from '../../../src/gen/teaching'
import {readVox} from '../../../src/vox/vox-file'
import type {BankEntry, WorkedExample} from '../../../src/gen/bank'
import {ISOMETRIC_PITCH} from '../../../src/doc/cameras'
import {basisFor, createCamera} from '../../../src/render/camera'
import {encodePng} from '../../../src/image/png'
import {render} from '../../../src/render/raycast'
import {createVolume, filledBounds, setVoxel, voxelAt, type Volume} from '../../../src/render/volume'

const ENDPOINT = 'http://localhost:8080'
const OUT = 'out/teachers'
const VOX = process.argv[2] ?? 'out/teachers/vox'
const CANVAS = 32
const RENDER = 200

/**
 * The four entries, with **notes rewritten for the model that now teaches them**.
 *
 * `exampleFrom` puts `notes` in as the reply's opening comment, and every hand-typed example opens on
 * proportions because the model imitates planning before it draws. Notes describing a different model
 * would be a lie in the one line the model reads first.
 */
const SWAPS: readonly {
    readonly entry: BankEntry
    readonly file: string
}[] = [
    {
        entry: {
            id: 'dog',
            subject: 'a dog',
            use: 'stands on four legs: cat, horse, bear, cow',
            notes: 'body 8 wide, 5 tall, 12 long; head at the front, ears on top; four short legs at the corners'
        },
        file: 'mob_bear.vox'
    },
    {
        entry: {
            id: 'chicken',
            subject: 'a chicken',
            use: 'a bird on two legs: chicken, penguin, owl',
            notes: 'round body 6 wide and 6 deep, 9 tall; head on top at the front with a beak; two short legs under it'
        },
        file: 'mob_penguin.vox'
    },
    {
        entry: {
            id: 'farmer',
            subject: 'a farmer',
            use: 'a person on two legs with arms: knight, farmer, wizard, robot',
            notes: '11 tall; legs 0-3, torso 4-7, head 8-10; a cap on the head and a bag at the side'
        },
        file: 'chr_mailman.vox'
    },
    {
        entry: {
            id: 'mushroom',
            subject: 'a red mushroom',
            use: 'a stalk or trunk under a wider mass: mushroom, tree, flower, coral',
            notes: 'narrow trunk 2 wide up the middle, a wider mass above it filling 8 by 8; 15 tall'
        },
        file: 'obj_tree1.vox'
    }
]

/** Which teacher each subject gets. Pinned, so the picking call is not a second variable. */
const SUBJECTS: readonly {readonly prompt: string; readonly teacher: string}[] = [
    {prompt: 'a cat', teacher: 'dog'},
    {prompt: 'a fox', teacher: 'dog'},
    {prompt: 'a horse', teacher: 'dog'},
    {prompt: 'a chicken', teacher: 'chicken'},
    {prompt: 'a knight', teacher: 'farmer'},
    {prompt: 'a red mushroom', teacher: 'mushroom'}
]

const SEEDS = [4200, 4201, 4202]

const trim = (volume: Volume): Volume => {
    const bounds = filledBounds(volume)
    if (!bounds) return volume
    const [x0, y0, z0] = bounds.min
    const [x1, y1, z1] = bounds.max
    const out = createVolume(x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1, volume.palette)
    for (let z = z0; z <= z1; z += 1) {
        for (let y = y0; y <= y1; y += 1) {
            for (let x = x0; x <= x1; x += 1) {
                setVoxel(out, x - x0, y - y0, z - z0, voxelAt(volume, x, y, z))
            }
        }
    }
    return out
}

const typed = new Map<string, WorkedExample>()
const fromModel = new Map<string, WorkedExample>()
for (const swap of SWAPS) {
    const reply = BUILT_IN_REPLIES[swap.entry.id]
    if (reply !== undefined) typed.set(swap.entry.id, {prompt: swap.entry.subject, reply})
    const volume = trim(readVox(new Uint8Array(await readFile(`${VOX}/${swap.file}`))))
    const built = exampleFrom(swap.entry, volume)
    if (!built.fits) throw new Error(`${swap.file} is over budget at ${String(lineCount(built.example))} lines`)
    fromModel.set(swap.entry.id, built.example)
    process.stdout.write(
        `${swap.entry.id.padEnd(10)}${swap.file.padEnd(20)}typed ${String(lineCount(typed.get(swap.entry.id) ?? {prompt: '', reply: ''})).padStart(3)} lines  ->  model ${String(lineCount(built.example)).padStart(3)} lines\n`
    )
}

interface ChatReply {
    choices?: {message?: {content?: string}}[]
}

const generate = async (prompt: string, example: WorkedExample, seed: number): Promise<string> => {
    const response = await fetch(`${ENDPOINT}/v1/chat/completions`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            messages: [
                {role: 'system', content: systemFor(CANVAS, DEFAULT_FLAGS)},
                {role: 'user', content: example.prompt},
                {role: 'assistant', content: example.reply},
                {role: 'user', content: prompt}
            ],
            max_tokens: 4096,
            temperature: 0.9,
            seed
        })
    })
    if (!response.ok) throw new Error(`llama-server ${String(response.status)}`)
    const body = (await response.json()) as ChatReply
    return body.choices?.[0]?.message?.content ?? ''
}

const shot = async (volume: Volume): Promise<Uint8Array> => {
    const bounds = filledBounds(volume)
    const zoom =
        bounds ?
            Math.ceil(
                Math.hypot(
                    bounds.max[0] - bounds.min[0] + 1,
                    bounds.max[1] - bounds.min[1] + 1,
                    bounds.max[2] - bounds.min[2] + 1
                ) * 1.15
            )
        :   volume.sz
    const target = render(
        volume,
        basisFor({...createCamera(volume, Math.PI / 4, ISOMETRIC_PITCH), zoom}, volume, RENDER),
        RENDER,
        RENDER
    )
    const px = new Uint8Array(target.color.length)
    for (let i = 0; i < px.length; i += 4) {
        const a = (target.color[i + 3] ?? 0) / 255
        px[i] = Math.round((target.color[i] ?? 0) * a + 34 * (1 - a))
        px[i + 1] = Math.round((target.color[i + 1] ?? 0) * a + 34 * (1 - a))
        px[i + 2] = Math.round((target.color[i + 2] ?? 0) * a + 38 * (1 - a))
        px[i + 3] = 255
    }
    return encodePng(RENDER, RENDER, px)
}

export interface Row {
    readonly prompt: string
    readonly arm: 'typed' | 'model'
    readonly seed: number
    readonly voxels: number
    readonly connectivity: number
    readonly bboxFill: number
    readonly rank: number
    readonly file: string
    readonly failed: string | undefined
}

await mkdir(`${OUT}/png`, {recursive: true})

const jobs: {prompt: string; teacher: string; arm: 'typed' | 'model'; seed: number}[] = []
for (const subject of SUBJECTS) {
    for (const arm of ['typed', 'model'] as const) {
        for (const seed of SEEDS) jobs.push({...subject, arm, seed})
    }
}

const rows: Row[] = new Array<Row>(jobs.length)
let next = 0
let done = 0
const worker = async (): Promise<void> => {
    for (;;) {
        const index = next
        next += 1
        const job = jobs[index]
        if (!job) return
        const example = (job.arm === 'typed' ? typed : fromModel).get(job.teacher)
        const key = `${job.prompt.replace(/\W+/g, '-')}_${job.arm}_${String(job.seed)}`
        let row: Row
        try {
            if (!example) throw new Error(`no ${job.arm} example for ${job.teacher}`)
            const reply = await generate(job.prompt, example, job.seed)
            await writeFile(`${OUT}/png/${key}.txt`, reply)
            const spec = specFromCode(reply, job.prompt, CANVAS)
            const flat = spec ? rasterise(spec, CANVAS) : undefined
            if (!flat || !flat.data.some(value => value !== 0)) throw new Error('painted nothing')
            const shaded = finish(flat)
            const scores = scoreModel(shaded, flat)
            await writeFile(`${OUT}/png/${key}.png`, await shot(shaded))
            row = {
                prompt: job.prompt,
                arm: job.arm,
                seed: job.seed,
                voxels: scores.voxels,
                connectivity: scores.connectivity,
                bboxFill: scores.bboxFill,
                rank: overallScore(scores),
                file: `${key}.png`,
                failed: undefined
            }
        } catch (error) {
            row = {
                prompt: job.prompt,
                arm: job.arm,
                seed: job.seed,
                voxels: 0,
                connectivity: 0,
                bboxFill: 0,
                rank: 0,
                file: '',
                failed: error instanceof Error ? error.message : String(error)
            }
        }
        rows[index] = row
        done += 1
        process.stdout.write(
            `  ${String(done).padStart(3)}/${String(jobs.length)}  ${job.prompt.padEnd(16)}${job.arm.padEnd(7)}${String(job.seed)}  ${row.failed ?? `${String(row.voxels)} voxels`}\n`
        )
    }
}
await Promise.all([worker(), worker()])

await writeFile(`${OUT}/rows.json`, JSON.stringify(rows, null, 2))
process.stdout.write(`\nwrote ${OUT}/rows.json\n`)
