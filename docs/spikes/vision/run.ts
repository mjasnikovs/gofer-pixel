/*
 * The runner. One stage per invocation, a CSV per stage, and a summary printed as it goes.
 *
 *     bun docs/spikes/vision/run.ts corpus      # build the shapes, write contact sheets, print the truth
 *     bun docs/spikes/vision/run.ts control     # no pictures at all — the floor every score is read against
 *     bun docs/spikes/vision/run.ts size        # 64 … 448 px, one three-quarter view
 *     bun docs/spikes/vision/run.ts grid <px>   # 8³ … 64³ at the winning pixel size
 *     bun docs/spikes/vision/run.ts views <px>  # one / two / four / four-iso / six, separate and as a strip
 *     bun docs/spikes/vision/run.ts examples <px> <views>   # 0, 3 and 6 labelled example pictures
 *
 * Two slots on the server, so two calls in flight. Accuracy is what is being measured and
 * contention cannot move it; wall clock is halved.
 */
import {mkdir, writeFile} from 'node:fs/promises'
import {build, CORPUS, truthOf, type Stimulus, type Truth} from './shapes'
import {partsFor, QUESTIONS, readAnswer, type Condition, type Mode, type Question} from './probe'
import {askOnce, probeServer} from './server'
import {pngFor, stripFor, VIEW_SETS} from './views'

const OUT = 'out/vision'

interface Row {
    readonly stimulus: string
    readonly question: string
    readonly views: string
    readonly size: number
    readonly grid: number
    readonly mode: Mode
    readonly examples: number
    readonly grammar: boolean
    readonly truth: string
    readonly parsed: string
    readonly said: string
    readonly correct: boolean
    readonly ms: number
}

interface Job {
    readonly stimulus: Stimulus
    readonly truth: Truth
    readonly question: Question
    readonly condition: Condition
    readonly grid: number
}

/** Every (shape, question) pair the shape actually answers, at one grid size. */
const jobsFor = (condition: Condition, grid: number, only?: readonly string[]): Job[] => {
    const out: Job[] = []
    for (const stimulus of CORPUS) {
        const truth = truthOf(stimulus, build(stimulus, grid))
        for (const question of QUESTIONS) {
            if (only && !only.includes(question.id)) continue
            // A shape answers only the question its family was built for, and only when its own
            // geometry has an answer — a cube has no longest axis and is not asked for one.
            if (!stimulus.asks.includes(question.id)) continue
            if (question.answer(truth) === undefined) continue
            out.push({stimulus, truth, question, condition, grid})
        }
    }
    return out
}

/** Up to `examples` other named shapes, never the one being asked about. */
const examplesFor = (job: Job): {label: string; volume: ReturnType<typeof build>}[] => {
    if (job.condition.examples === 0) return []
    const pool = CORPUS.filter(s => s.name !== undefined && s.id !== job.stimulus.id)
    return pool
        .slice(0, job.condition.examples)
        .map(s => ({label: s.name ?? s.id, volume: build(s, job.grid)}))
}

const runJob = async (job: Job): Promise<Row> => {
    const volume = build(job.stimulus, job.grid)
    const parts = await partsFor(volume, job.question, job.condition, examplesFor(job))
    const truth = job.question.answer(job.truth) ?? ''
    let said = ''
    let ms = 0
    try {
        const reply = await askOnce(
            parts,
            job.question.maxTokens,
            job.condition.grammar === true ? job.question.options : undefined
        )
        said = reply.said
        ms = reply.ms
    } catch (error) {
        said = `ERROR ${error instanceof Error ? error.message : String(error)}`
    }
    const parsed = readAnswer(said, job.question.options)
    return {
        stimulus: job.stimulus.id,
        question: job.question.id,
        views: job.condition.views,
        size: job.condition.size,
        grid: job.grid,
        mode: job.condition.mode,
        examples: job.condition.examples,
        grammar: job.condition.grammar === true,
        truth,
        parsed: parsed ?? 'unparsed',
        said: said.replace(/\s+/g, ' ').slice(0, 80),
        correct: parsed === truth,
        ms
    }
}

/** Two in flight, in order out. */
const runAll = async (jobs: readonly Job[], label: string): Promise<Row[]> => {
    const rows: Row[] = new Array<Row>(jobs.length)
    let next = 0
    let done = 0
    const worker = async (): Promise<void> => {
        for (;;) {
            const index = next
            next += 1
            const job = jobs[index]
            if (!job) return
            rows[index] = await runJob(job)
            done += 1
            if (done % 20 === 0 || done === jobs.length) {
                process.stdout.write(`  ${label}: ${String(done)}/${String(jobs.length)}\n`)
            }
        }
    }
    await Promise.all([worker(), worker()])
    return rows
}

const pct = (rows: readonly Row[]): string =>
    rows.length === 0 ?
        '  —  '
    :   `${((100 * rows.filter(row => row.correct).length) / rows.length).toFixed(0).padStart(3)}%`

const summarise = (rows: readonly Row[], by: (row: Row) => string): void => {
    const keys = [...new Set(rows.map(by))]
    const questions = [...new Set(rows.map(row => row.question))]
    process.stdout.write(
        `\n${'condition'.padEnd(22)}${questions.map(q => q.padStart(9)).join('')}${'all'.padStart(9)}${'unparsed'.padStart(10)}\n`
    )
    for (const key of keys) {
        const mine = rows.filter(row => by(row) === key)
        const cells = questions.map(q => pct(mine.filter(row => row.question === q)).padStart(9))
        const unparsed = mine.filter(row => row.parsed === 'unparsed').length
        process.stdout.write(
            `${key.padEnd(22)}${cells.join('')}${pct(mine).padStart(9)}${String(unparsed).padStart(10)}\n`
        )
    }
    process.stdout.write('\n')
}

const writeCsv = async (name: string, rows: readonly Row[]): Promise<void> => {
    const head =
        'stimulus,question,views,size,grid,mode,examples,grammar,truth,parsed,correct,ms,said\n'
    const body = rows
        .map(row =>
            [
                row.stimulus,
                row.question,
                row.views,
                String(row.size),
                String(row.grid),
                row.mode,
                String(row.examples),
                String(row.grammar),
                row.truth,
                row.parsed,
                String(row.correct),
                row.ms.toFixed(0),
                `"${row.said.replace(/"/g, "'")}"`
            ].join(',')
        )
        .join('\n')
    await mkdir(OUT, {recursive: true})
    await writeFile(`${OUT}/${name}.csv`, head + body + '\n')
    process.stdout.write(`wrote ${OUT}/${name}.csv (${String(rows.length)} rows)\n`)
}

const corpus = async (grid: number): Promise<void> => {
    await mkdir(`${OUT}/corpus`, {recursive: true})
    process.stdout.write(
        `${'id'.padEnd(16)}${'name'.padEnd(12)}${'voxels'.padStart(7)}${'parts'.padStart(6)}${'float'.padStart(6)}${'longest'.padStart(8)}${'extents'.padStart(12)}${'mark'.padStart(7)}\n`
    )
    for (const stimulus of CORPUS) {
        const volume = build(stimulus, grid)
        const truth = truthOf(stimulus, volume)
        process.stdout.write(
            `${truth.id.padEnd(16)}${(truth.name ?? '—').padEnd(12)}${String(truth.voxels).padStart(7)}${String(truth.parts).padStart(6)}${String(truth.floating).padStart(6)}${(truth.longest ?? '—').padStart(8)}${truth.extents.join('x').padStart(12)}${(truth.mark ?? '—').padStart(7)}\n`
        )
        const view = VIEW_SETS.one?.[0]
        if (view) await writeFile(`${OUT}/corpus/${stimulus.id}.png`, await pngFor(volume, view, 224))
        await writeFile(
            `${OUT}/corpus/${stimulus.id}-four.png`,
            await stripFor(volume, VIEW_SETS.four ?? [], 112)
        )
    }

    /*
     * The balance, printed rather than believed. Every question's most common answer is the score a
     * model with its eyes shut can reach; the first corpus had 89 % sitting in this table and nobody
     * had looked.
     */
    process.stdout.write('\nanswer balance — the ceiling for a model that never looks:\n')
    for (const question of QUESTIONS) {
        const counts = new Map<string, number>()
        for (const stimulus of CORPUS) {
            if (!stimulus.asks.includes(question.id)) continue
            const answer = question.answer(truthOf(stimulus, build(stimulus, grid)))
            if (answer === undefined) continue
            counts.set(answer, (counts.get(answer) ?? 0) + 1)
        }
        const total = [...counts.values()].reduce((sum, value) => sum + value, 0)
        const worst = Math.max(0, ...counts.values())
        const spread = [...counts.entries()].map(([key, value]) => `${key}:${String(value)}`).join(' ')
        process.stdout.write(
            `  ${question.id.padEnd(9)}${String(total).padStart(3)} asked   majority ${((100 * worst) / Math.max(1, total)).toFixed(0).padStart(3)}%   ${spread}\n`
        )
    }
    process.stdout.write(`\nwrote ${OUT}/corpus/*.png\n`)
}

const stage = process.argv[2] ?? 'corpus'
const arg = (i: number, fallback: number): number => Number(process.argv[i] ?? fallback)

if (stage === 'corpus') {
    await corpus(arg(3, 32))
} else {
    const model = await probeServer()
    if (model === undefined) {
        process.stdout.write('llama-server is not answering on :8080\n')
        process.exit(1)
    }
    process.stdout.write(`model: ${model}\n`)

    if (stage === 'control') {
        const condition: Condition = {views: 'one', size: 0, mode: 'blind', examples: 0}
        const rows = await runAll(jobsFor(condition, 32), 'control')
        summarise(rows, () => 'no picture')
        await writeCsv('control', rows)
    } else if (stage === 'size') {
        const rows: Row[] = []
        const sizes = (process.argv[3] ?? '64,96,128,224,320,448').split(',').map(Number)
        for (const size of sizes) {
            const condition: Condition = {views: 'one', size, mode: 'separate', examples: 0}
            rows.push(...(await runAll(jobsFor(condition, 32), `${String(size)}px`)))
        }
        summarise(rows, row => `${String(row.size)} px`)
        await writeCsv('size', rows)
    } else if (stage === 'grid') {
        const size = arg(3, 224)
        const rows: Row[] = []
        for (const grid of [8, 16, 32, 64]) {
            const condition: Condition = {views: 'one', size, mode: 'separate', examples: 0}
            rows.push(...(await runAll(jobsFor(condition, grid), `${String(grid)}^3`)))
        }
        summarise(rows, row => `${String(row.grid)}^3 grid`)
        await writeCsv('grid', rows)
    } else if (stage === 'views') {
        const size = arg(3, 224)
        const rows: Row[] = []
        const plan: {views: keyof typeof VIEW_SETS; mode: Mode}[] = [
            {views: 'one', mode: 'separate'},
            {views: 'two', mode: 'separate'},
            {views: 'four', mode: 'separate'},
            {views: 'fourIso', mode: 'separate'},
            {views: 'six', mode: 'separate'},
            {views: 'four', mode: 'strip'},
            {views: 'six', mode: 'strip'}
        ]
        for (const {views, mode} of plan) {
            const condition: Condition = {views, size, mode, examples: 0}
            rows.push(...(await runAll(jobsFor(condition, 32), `${views}/${mode}`)))
        }
        summarise(rows, row => `${row.views} ${row.mode}`)
        await writeCsv('views', rows)
    } else if (stage === 'recheck') {
        /*
         * The repair pass. Two conditions and two arms each:
         *
         * - the six-view cell whose 42 % on "floating" was four truncated replies, now with room to
         *   answer;
         * - the four-three-quarter cell that won overall, as the control on that change;
         * - each of them free-form and grammar-constrained, because a grammar removes the parsing
         *   question entirely and the only way to know what it costs is to run both.
         */
        const size = arg(3, 96)
        const rows: Row[] = []
        for (const views of ['fourIso', 'six'] as const) {
            for (const grammar of [false, true]) {
                const condition: Condition = {
                    views,
                    size,
                    mode: 'separate',
                    examples: 0,
                    grammar
                }
                rows.push(
                    ...(await runAll(jobsFor(condition, 32), `${views}/${grammar ? 'gbnf' : 'free'}`))
                )
            }
        }
        summarise(rows, row => `${row.views} ${row.grammar ? 'grammar' : 'free'}`)
        await writeCsv('recheck', rows)
    } else if (stage === 'final') {
        /*
         * The candidate configuration, and the one variable left on it.
         *
         * `fiveIso` is `fourIso` plus the view from above — the hybrid the views stage pointed at.
         * Three labelled examples is what the examples stage measured as the win. Both arms run so
         * the examples claim is retested on the set it would actually ship with.
         */
        const size = arg(3, 96)
        const rows: Row[] = []
        for (const examples of [0, 3]) {
            const condition: Condition = {
                views: 'fiveIso',
                size,
                mode: 'separate',
                examples
            }
            rows.push(...(await runAll(jobsFor(condition, 32), `fiveIso/${String(examples)}ex`)))
        }
        summarise(rows, row => `fiveIso ${String(row.examples)} examples`)
        await writeCsv('final', rows)
    } else if (stage === 'finalg') {
        /*
         * The winning configuration with parsing taken out of the loop.
         *
         * Three replies to "is anything floating" came back `unparsed` at five views, and the raw
         * text is why: the model writes a paragraph that says both "yes" and "no" before it commits.
         * Counting that wrong is honest — it was asked for one word — but it leaves the question of
         * what it would have said. Under the grammar it can only say one of them.
         */
        const condition: Condition = {
            views: 'fiveIso',
            size: arg(3, 96),
            mode: 'separate',
            examples: 0,
            grammar: true
        }
        const rows = await runAll(jobsFor(condition, 32), 'fiveIso/gbnf')
        summarise(rows, () => 'fiveIso grammar')
        await writeCsv('finalg', rows)
    } else if (stage === 'examples') {
        const size = arg(3, 224)
        const views = (process.argv[4] ?? 'one') as keyof typeof VIEW_SETS
        const rows: Row[] = []
        for (const examples of [0, 3, 6]) {
            const condition: Condition = {views, size, mode: 'separate', examples}
            rows.push(...(await runAll(jobsFor(condition, 32), `${String(examples)} examples`)))
        }
        summarise(rows, row => `${String(row.examples)} examples`)
        await writeCsv('examples', rows)
    } else {
        process.stdout.write(`unknown stage: ${stage}\n`)
        process.exit(1)
    }
}
