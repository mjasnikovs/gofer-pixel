/*
 * One generation run that every flag verdict is read off.
 *
 *     bun docs/spikes/flags/corpus.ts [seeds]
 *
 * Six subjects × five language arms × three fixed seeds = 90 candidates, against the live server.
 * Everything is kept: the raw reply, the spec, the flat grid, the shaded grid, the scores, and one
 * render per candidate. `sheet.ts` turns it into pages to look at.
 *
 * **The three policy switches are not arms here, and that is the saving.** `repair` is a pure
 * function of a finished volume, so it is applied to these same candidates afterwards and shown as a
 * before and after of one model rather than as two models from two seeds — which is the only way to
 * see whether a rule fired on something good. `gates` is a decision over scores, so which candidates
 * it would have thrown away is read off the table. `retryEmpty` needs to know how often a reply
 * paints nothing at all, and that is a column in this run rather than an experiment of its own —
 * `GEN_IDEAS.md` §11 says count it before building anything, and nobody has counted.
 *
 * The call is hand-rolled rather than `generateMany` for one reason: the raw reply text. The record's
 * own experiment measurement is "what the reply actually called", and a `VoxSpec` cannot answer that
 * — every experiment emits the same three ops by design. `systemFor` and `specFromCode` are the real
 * exported ones, taking the real flags, so what is sent and what is parsed is the shipped path.
 */
import {mkdir, writeFile} from 'node:fs/promises'
import {BUILT_IN_REPLIES} from '../../../src/gen/builtin'
import {specFromCode} from '../../../src/gen/code'
import {DEFAULT_FLAGS, type Flags} from '../../../src/gen/flags'
import {finish} from '../../../src/gen/finish'
import {rasterise, type VoxSpec} from '../../../src/gen/ops'
import {systemFor} from '../../../src/gen/llama'
import {overallScore, scoreModel} from '../../../src/gen/score'
import {gateReason} from '../../../src/gen/gate'
import {repair} from '../../../src/gen/repair'
import {readManifest, pickPrompt, readPicks, type Manifest} from '../../../src/gen/bank'
import {SILHOUETTE_EXAMPLES} from '../../../src/gen/shape'
import {GROW_EXAMPLES} from '../../../src/gen/grow'
import {FACE_EXAMPLES} from '../../../src/gen/face'
import {RIG_REPLIES} from '../../../src/gen/rig'
import MANIFEST from '../../../src/assets/examples/examples.json'
import {ISOMETRIC_PITCH} from '../../../src/doc/cameras'
import {basisFor, createCamera} from '../../../src/render/camera'
import {encodePng} from '../../../src/image/png'
import {render} from '../../../src/render/raycast'
import {filledBounds, type Volume} from '../../../src/render/volume'

const ENDPOINT = 'http://localhost:8080'
const OUT = 'out/flags'
const CANVAS = 32
const TEMPERATURE = 0.9
const RENDER = 200

/** The six the record already argues about, one per body plan the bank teaches, plus a prop. */
const SUBJECTS = [
    'a cat',
    'a chicken',
    'a knight',
    'a red mushroom',
    'a stone tower',
    'a Mario brick block'
] as const

/** Off, and the four languages. `auto` is deliberately not an arm: it *chooses* one of these. */
const ARMS = ['off', 'silhouette', 'procedural', 'relational', 'faces'] as const
type Arm = (typeof ARMS)[number]

const flagsFor = (arm: Arm): Flags =>
    arm === 'off' ? DEFAULT_FLAGS : {...DEFAULT_FLAGS, [arm]: true}

/**
 * The experiments' own worked examples, in front of the bank's.
 *
 * A copy of `generateMany`'s `experimentExamples`, which is not exported. It is a copy rather than
 * an export because exporting it for a spike would put a seam in shipped code that only this file
 * reads — and if the two ever disagree, this file is the one that is wrong.
 */
const experimentExamples = (flags: Flags, picked: readonly string[]) => {
    if (flags.relational) {
        return picked.flatMap(id => {
            const reply = RIG_REPLIES[id]
            return reply === undefined ? [] : [{prompt: `a ${id}`, reply}]
        })
    }
    const out: {prompt: string; reply: string}[] = []
    if (flags.silhouette) {
        for (const [subject, reply] of Object.entries(SILHOUETTE_EXAMPLES)) {
            if (reply !== undefined) out.push({prompt: `a ${subject}`, reply})
        }
    }
    if (flags.faces) {
        for (const [subject, reply] of Object.entries(FACE_EXAMPLES)) {
            if (reply !== undefined) out.push({prompt: `a ${subject}`, reply})
        }
    }
    if (flags.procedural) {
        out.push(
            {prompt: 'a pine tree', reply: GROW_EXAMPLES.tree},
            {prompt: 'a stone tower', reply: GROW_EXAMPLES.tower},
            {prompt: 'a mossy boulder', reply: GROW_EXAMPLES.rock}
        )
    }
    return out
}

interface ChatReply {
    choices?: {message?: {content?: string}}[]
}

const chat = async (messages: readonly unknown[], maxTokens: number, seed?: number, temp = 0) => {
    const response = await fetch(`${ENDPOINT}/v1/chat/completions`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            messages,
            max_tokens: maxTokens,
            temperature: temp,
            ...(seed === undefined ? {} : {seed})
        })
    })
    if (!response.ok) throw new Error(`llama-server ${String(response.status)}`)
    const body = (await response.json()) as ChatReply
    return body.choices?.[0]?.message?.content ?? ''
}

/** Every name the four languages add, plus the three the base language has. */
const CALLABLE = [
    'box',
    'ball',
    'erase',
    'mirrorX',
    'front',
    'side',
    'tree',
    'tower',
    'rock',
    'face',
    'part',
    'attach',
    'legs',
    'arms'
] as const

/** Which of them the reply actually called — the record's own measurement, as a list. */
const called = (reply: string): string[] =>
    CALLABLE.filter(name => new RegExp(`(^|[^\\w.])${name}\\s*\\(`).test(reply))

const onGrey = (rgba: Uint8Array): Uint8Array => {
    const out = new Uint8Array(rgba.length)
    for (let i = 0; i < rgba.length; i += 4) {
        const alpha = (rgba[i + 3] ?? 0) / 255
        out[i] = Math.round((rgba[i] ?? 0) * alpha + 34 * (1 - alpha))
        out[i + 1] = Math.round((rgba[i + 1] ?? 0) * alpha + 34 * (1 - alpha))
        out[i + 2] = Math.round((rgba[i + 2] ?? 0) * alpha + 38 * (1 - alpha))
        out[i + 3] = 255
    }
    return out
}

const pngOf = async (volume: Volume): Promise<Uint8Array> => {
    const bounds = filledBounds(volume)
    const camera = createCamera(volume, Math.PI / 4, ISOMETRIC_PITCH)
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
    const basis = basisFor({...camera, zoom}, volume, RENDER)
    return encodePng(RENDER, RENDER, onGrey(render(volume, basis, RENDER, RENDER).color))
}

export interface Cell {
    readonly subject: string
    readonly arm: Arm
    readonly seed: number
    /** Which bank example the picking call chose for this subject. */
    readonly taught: string
    readonly called: readonly string[]
    /** Did the reply declare its content is on its surface — `gen/face.ts`. */
    readonly surface: boolean
    readonly ops: number
    readonly voxels: number
    readonly connectivity: number
    readonly sliceUsage: number
    readonly bboxFill: number
    readonly shellColors: number
    readonly rank: number
    /** What `gates` would have said, on the scores as the batch computes them. */
    readonly gate: string | undefined
    /** What `repair` changed, applied to this same candidate afterwards. */
    readonly repaired: {
        readonly dropped: number
        readonly bridged: number
        readonly thickened: number
        readonly lifted: number
        readonly mirrored: boolean
        readonly changed: boolean
    }
    /** Empty when the reply painted nothing — the `retryEmpty` count. */
    readonly failed: string | undefined
    readonly file: string
    readonly repairedFile: string | undefined
    readonly ms: number
}

const seedsArg = (process.argv[2] ?? '4200,4201,4202').split(',').map(Number)

const manifest: Manifest = readManifest(MANIFEST) ?? {fallback: 'tower', entries: []}

/** One picking call per subject, not per cell: the answer is a property of the subject. */
const taughtBy = new Map<string, string>()
for (const subject of SUBJECTS) {
    const said = await chat(
        [
            {role: 'system', content: pickPrompt(manifest)},
            {role: 'user', content: subject}
        ],
        32
    )
    taughtBy.set(subject, readPicks(said, manifest)[0] ?? manifest.fallback)
}
process.stdout.write(
    `taught by: ${[...taughtBy].map(([s, id]) => `${s} → ${id}`).join(', ')}\n\n`
)

await mkdir(`${OUT}/png`, {recursive: true})

const jobs: {subject: string; arm: Arm; seed: number}[] = []
for (const subject of SUBJECTS) {
    for (const arm of ARMS) for (const seed of seedsArg) jobs.push({subject, arm, seed})
}

const runOne = async (job: {subject: string; arm: Arm; seed: number}): Promise<Cell> => {
    const {subject, arm, seed} = job
    const flags = flagsFor(arm)
    const taught = taughtBy.get(subject) ?? manifest.fallback
    const bankReply = BUILT_IN_REPLIES[taught]
    const examples = [
        ...experimentExamples(flags, [taught]),
        ...(bankReply === undefined ? [] : [{prompt: `a ${taught}`, reply: bankReply}])
    ]
    const key = `${subject.replace(/\W+/g, '-')}_${arm}_${String(seed)}`
    const blank = {
        dropped: 0,
        bridged: 0,
        thickened: 0,
        lifted: 0,
        mirrored: false,
        changed: false
    }
    const started = performance.now()
    let reply = ''
    try {
        reply = await chat(
            [
                {role: 'system', content: systemFor(CANVAS, flags)},
                ...examples.flatMap(example => [
                    {role: 'user', content: example.prompt},
                    {role: 'assistant', content: example.reply}
                ]),
                {role: 'user', content: subject}
            ],
            4096,
            seed,
            TEMPERATURE
        )
    } catch (error) {
        return {
            subject,
            arm,
            seed,
            taught,
            called: [],
            surface: false,
            ops: 0,
            voxels: 0,
            connectivity: 0,
            sliceUsage: 0,
            bboxFill: 0,
            shellColors: 0,
            rank: 0,
            gate: 'empty',
            repaired: blank,
            failed: error instanceof Error ? error.message : String(error),
            file: '',
            repairedFile: undefined,
            ms: performance.now() - started
        }
    }
    await writeFile(`${OUT}/png/${key}.js`, reply)

    const spec: VoxSpec | undefined = specFromCode(reply, subject, CANVAS, flags)
    const flat = spec ? rasterise(spec, CANVAS) : undefined
    const painted = flat?.data.some(value => value !== 0) === true
    if (!spec || !flat || !painted) {
        return {
            subject,
            arm,
            seed,
            taught,
            called: called(reply),
            surface: spec?.surface === true,
            ops: spec?.ops.length ?? 0,
            voxels: 0,
            connectivity: 0,
            sliceUsage: 0,
            bboxFill: 0,
            shellColors: 0,
            rank: 0,
            gate: 'empty',
            repaired: blank,
            failed: spec ? 'the reply painted no voxels' : 'the reply held no usable ops',
            file: '',
            repairedFile: undefined,
            ms: performance.now() - started
        }
    }

    const shaded = finish(flat)
    const scores = scoreModel(shaded, flat)
    const surface = spec.surface === true
    await writeFile(`${OUT}/png/${key}.png`, await pngOf(shaded))

    // `repair` runs on the flat grid, before shading — the order `generateMany` uses.
    const fixed = repair(flat)
    const changed = fixed.volume !== flat
    let repairedFile: string | undefined
    if (changed) {
        repairedFile = `${key}-repaired.png`
        await writeFile(`${OUT}/png/${repairedFile}`, await pngOf(finish(fixed.volume)))
    }

    return {
        subject,
        arm,
        seed,
        taught,
        called: called(reply),
        surface,
        ops: spec.ops.length,
        voxels: scores.voxels,
        connectivity: scores.connectivity,
        sliceUsage: scores.sliceUsage,
        bboxFill: scores.bboxFill,
        shellColors: scores.shellColors,
        rank: overallScore(scores, surface),
        gate: gateReason(scores, surface),
        repaired: {...fixed.report, changed},
        failed: undefined,
        file: `${key}.png`,
        repairedFile,
        ms: performance.now() - started
    }
}

const cells: Cell[] = new Array<Cell>(jobs.length)
let next = 0
let done = 0
const worker = async (): Promise<void> => {
    for (;;) {
        const index = next
        next += 1
        const job = jobs[index]
        if (!job) return
        cells[index] = await runOne(job)
        done += 1
        const cell = cells[index]
        process.stdout.write(
            `  ${String(done).padStart(3)}/${String(jobs.length)}  ${job.subject.padEnd(20)}${job.arm.padEnd(12)}${String(job.seed)}  ${
                cell?.failed ?? `${String(cell?.voxels ?? 0)} voxels, ${(cell?.called ?? []).join(' ')}`
            }\n`
        )
    }
}
await Promise.all([worker(), worker()])

await writeFile(`${OUT}/cells.json`, JSON.stringify(cells, null, 2))
process.stdout.write(`\nwrote ${OUT}/cells.json (${String(cells.length)} cells)\n`)
