/*
 * Is the lever the art, or the way the example is written?
 *
 *     bun docs/spikes/flags/teachers2.ts
 *
 * `teachers.ts` swapped my hand-typed replies for real CC-BY models and the output did not improve —
 * connectivity fell from 0.99 to 0.85. The obvious explanation is that a decomposed model is *mute*:
 * forty-odd literal `box(...)` calls in coordinate order, no proportions comment, no named parts, no
 * loop over a mirrored pair. It shows the result and none of the method, and finding 7's whole claim
 * is about what an example *demonstrates*.
 *
 * So three arms over the one teacher the record has most data on:
 *
 * - **typed** — my 12-line hand-written dog. Well written, poor geometry.
 * - **mute** — `mob_bear.vox` through `decompose` + `opsToCode`. Good geometry, written by a machine.
 * - **narrated** — a 20-line reply in the house style built to the bear's own proportions. Good
 *   geometry, written like a worked example.
 *
 * The third arm is **not** a controlled single-variable change against the second — the geometry is
 * close but not voxel-identical, because a mechanical re-narration of the decomposed ops turned out
 * longer than the thing it was rewriting and its part labels were wrong. What it is instead is the
 * cell the other two leave empty: a good model, well written. If it beats both, the answer is that
 * the bank needs authored examples rather than decomposed assets.
 */
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {BUILT_IN_REPLIES} from '../../../src/gen/builtin'
import {specFromCode} from '../../../src/gen/code'
import {DEFAULT_FLAGS} from '../../../src/gen/flags'
import {finish} from '../../../src/gen/finish'
import {rasterise} from '../../../src/gen/ops'
import {systemFor} from '../../../src/gen/llama'
import {overallScore, scoreModel} from '../../../src/gen/score'
import {exampleFrom} from '../../../src/gen/teaching'
import {readVox} from '../../../src/vox/vox-file'
import {ISOMETRIC_PITCH} from '../../../src/doc/cameras'
import {basisFor, createCamera} from '../../../src/render/camera'
import {encodePng} from '../../../src/image/png'
import {render} from '../../../src/render/raycast'
import {createVolume, filledBounds, setVoxel, voxelAt, type Volume} from '../../../src/render/volume'

const ENDPOINT = 'http://localhost:8080'
const OUT = 'out/teachers2'
const CANVAS = 32
const RENDER = 200
const SEEDS = [4200, 4201, 4202]
const SUBJECTS = ['a cat', 'a fox', 'a horse'] as const
const ARMS = ['typed', 'mute', 'narrated'] as const
type Arm = (typeof ARMS)[number]

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

const bear = trim(readVox(new Uint8Array(await readFile('out/teachers/vox/mob_bear.vox'))))
const mute = exampleFrom(
    {
        id: 'dog',
        subject: 'a dog',
        use: 'stands on four legs: cat, horse, bear, cow',
        notes: 'body 8 wide, 5 tall, 12 long; head at the front, ears on top; four short legs at the corners'
    },
    bear
).example

const REPLIES: Readonly<Record<Arm, string>> = {
    typed: BUILT_IN_REPLIES.dog ?? '',
    mute: mute.reply,
    narrated: await readFile('out/teachers/dog-narrated.js', 'utf8')
}

for (const arm of ARMS) {
    process.stdout.write(`${arm.padEnd(10)}${String(REPLIES[arm].split('\n').length).padStart(3)} lines\n`)
}

interface ChatReply {
    choices?: {message?: {content?: string}}[]
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

export interface Row2 {
    readonly prompt: string
    readonly arm: Arm
    readonly seed: number
    readonly voxels: number
    readonly connectivity: number
    readonly sliceUsage: number
    readonly bboxFill: number
    readonly rank: number
    readonly file: string
    readonly failed: string | undefined
}

await mkdir(`${OUT}/png`, {recursive: true})

const jobs: {prompt: string; arm: Arm; seed: number}[] = []
for (const prompt of SUBJECTS) for (const arm of ARMS) for (const seed of SEEDS) jobs.push({prompt, arm, seed})

const rows: Row2[] = new Array<Row2>(jobs.length)
let next = 0
let done = 0
const worker = async (): Promise<void> => {
    for (;;) {
        const index = next
        next += 1
        const job = jobs[index]
        if (!job) return
        const key = `${job.prompt.replace(/\W+/g, '-')}_${job.arm}_${String(job.seed)}`
        let row: Row2
        try {
            const response = await fetch(`${ENDPOINT}/v1/chat/completions`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    messages: [
                        {role: 'system', content: systemFor(CANVAS, DEFAULT_FLAGS)},
                        {role: 'user', content: 'a dog'},
                        {role: 'assistant', content: REPLIES[job.arm]},
                        {role: 'user', content: job.prompt}
                    ],
                    max_tokens: 4096,
                    temperature: 0.9,
                    seed: job.seed
                })
            })
            if (!response.ok) throw new Error(`llama-server ${String(response.status)}`)
            const body = (await response.json()) as ChatReply
            const reply = body.choices?.[0]?.message?.content ?? ''
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
                sliceUsage: scores.sliceUsage,
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
                sliceUsage: 0,
                bboxFill: 0,
                rank: 0,
                file: '',
                failed: error instanceof Error ? error.message : String(error)
            }
        }
        rows[index] = row
        done += 1
        process.stdout.write(
            `  ${String(done).padStart(2)}/${String(jobs.length)}  ${job.prompt.padEnd(10)}${job.arm.padEnd(10)}${String(job.seed)}  ${row.failed ?? `${String(row.voxels)} voxels, conn ${row.connectivity.toFixed(2)}`}\n`
        )
    }
}
await Promise.all([worker(), worker()])

await writeFile(`${OUT}/rows.json`, JSON.stringify(rows, null, 2))

process.stdout.write('\n')
for (const arm of ARMS) {
    const ok = rows.filter(row => row.arm === arm && row.failed === undefined)
    const mean = (pick: (row: Row2) => number): string =>
        (ok.reduce((sum, row) => sum + pick(row), 0) / Math.max(1, ok.length)).toFixed(3)
    process.stdout.write(
        `${arm.padEnd(10)}n=${String(ok.length).padStart(2)}  voxels ${(ok.reduce((s, r) => s + r.voxels, 0) / Math.max(1, ok.length)).toFixed(0).padStart(5)}  conn ${mean(r => r.connectivity)}  slices ${mean(r => r.sliceUsage)}  rank ${mean(r => r.rank)}  failed ${String(rows.filter(r => r.arm === arm && r.failed).length)}\n`
    )
}
