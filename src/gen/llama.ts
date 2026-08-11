import {MAX_SIZE, rasterise, type VoxSpec} from './ops'
import {snapTo, type Swatches} from './palette'
import {picksFor, pickPrompt, readPicks, type Manifest, type WorkedExample} from './bank'
import {DEFAULT_FLAGS, type Flags} from './flags'
import {SILHOUETTE_EXAMPLES} from './shape'
import {GROW_EXAMPLES} from './grow'
import {FACE_EXAMPLES} from './face'
import {rigSystemFor, RIG_REPLIES} from './rig'
import {admit, NOTHING_GATED, type GateTally} from './gate'
import {repair} from './repair'
import {scoreModel, type ModelScores} from './score'
import {specFromCode} from './code'
import {finish} from './finish'
import type {Volume} from '../render/volume'

/**
 * The half of generation that talks to llama-server on `localhost:8080`.
 *
 * A port, like `doc/store.ts` and `doc/files.ts`, and for the same reason: the logic worth testing
 * is which seeds get used, what happens to a candidate that fails and whether a cancel is honoured
 * — none of which should need a 27B model loaded to check. `browserLlama` is the real one;
 * `memoryLlama` is what `bun test` drives.
 *
 * The reply is JavaScript, not schema-constrained JSON, and that is measured, not taste
 * (2026-08-08, live server): the JSON grammar starts the reply on its first op token, so the model
 * has nowhere to think, and prose rules do not survive that. Asked for code it writes a proportions
 * comment first and uses loops for repetition, and its cats were named as animals 4 of 4 against
 * 2 of 4 for the JSON path. `specFromCode` runs the reply and narrows it — see the comments there.
 *
 * No streaming and no retries. A candidate that fails is one of N and is reported as a failure
 * rather than quietly replaced, because a silent retry hides a prompt that has stopped working.
 */
export const DEFAULT_ENDPOINT = 'http://localhost:8080'

/**
 * The function the `faces` experiment adds — `gen/face.ts`.
 *
 * Two things have to be in the sentence or the language is unusable. **The solid comes first**,
 * because a face is a side of what has already been painted. And **`face` is for props**, because
 * the whole reason it exists is that a block's information is on its surface — pointing it at a cat
 * would paint a stripe down a leg and declare the candidate a prop, which turns off the gate rule
 * that a cat actually needs.
 */
const FACE_HELP = `  face("+z", s => { … })               paint a pattern on one side of what you have painted
Inside face, you draw in 2D on that side: s.width and s.height are its size, (0,0) is the bottom-left,
and v counts upward on the four side faces. The marks are
  s.rect(u0,v0, u1,v1, "#rrggbb")      s.line(u0,v0, u1,v1, "#rrggbb")      s.dot(u,v, "#rrggbb")
  s.bevel(1, light, dark)              lit top-left edge, shaded bottom-right
  s.courses(rows, cols, mortar)        staggered brickwork lines
  s.studs(inset, "#rrggbb")            four marks in from the corners
Block the solid out first, then call face — a face is a side of what is already there. Use this for
blocks, tiles, crates and props, whose whole shape is a box and whose whole content is the pattern
on it. Do not use it for a creature or a figure.
`

/**
 * The three generators the `procedural` experiment adds — §6, `gen/grow.ts`.
 *
 * Deliberately not general, and the prompt says so: finding 4 is that organic and architectural
 * subjects are the ones that work, and those two are also what L-systems and grammars solved forty
 * years ago. A tree is four numbers here and four hundred voxels of branch in code, which is the
 * only thing on this list that breaks the ~20-primitive coherence ceiling.
 */
const PROCEDURAL_HELP = `  tree({shape,height,trunk,branches,spread,leaf,bark,seed})   a whole tree
  tower({height,width,courses,windows,battlements,stone,trim}) a whole tower
  rock({width,height,depth,bumpiness,stone,moss})              a whole boulder
Each of those three draws hundreds of voxels from the numbers you give: call one, then add what
makes this subject itself with box. Every field is optional and everything is clamped to the box.
Do not pass a canvas — the size is decided for you. Use them only for what they are: a plant, a
building, a rock. Anything else is box and ball.
`

/**
 * The two functions the `silhouette` experiment adds — §3, `gen/shape.ts`.
 *
 * Rows and half-extents, never a grid of characters: VGBench finds open-weight models weakest at
 * low-level 2D output, and spans are arithmetic where a grid is alignment. The interpolation is the
 * whole point and so it is said out loud — five ribs are meant to describe twenty rows of curve,
 * and a model that names every row has learnt nothing the `box` language did not already do.
 */
const SILHOUETTE_HELP = `  front([[row,half],...], "#rrggbb")   outline from the front: half-width in x at that row
  side([[row,half],...])               outline from the side: half-depth in z at that row
front and side are one shape: they are extruded and intersected the moment you have called both.
Rows count up from the feet at y=0, and the outline is interpolated between the rows you give, so
four or five rows describe a smooth curve. Use the pair for the body, once per part in that part's
colour, then add the details with box. A part is centred on the middle of the model.
`

/**
 * The system prompt, with the cube it asks for.
 *
 * The size is a parameter because the canvas is a switch — see `gen/ask.ts`. Two lines carry it: the
 * bound, and an explicit instruction to *use* the box. The second exists because every worked
 * example in the bank is a model built at 32, and an example is worth more than a rule (finding 7),
 * so at 64 or 128 the model will happily draw a 30-tall figure in the corner of the grid unless it
 * is told the scale in the same breath as the bound. Whether that instruction survives the examples
 * is exactly what the switch is for finding out.
 */
export const systemFor = (canvas: number, flags: Flags = DEFAULT_FLAGS): string => {
    // §2 is a different language, not more words in this one — see `gen/rig.ts` and `gen/code.ts`.
    if (flags.relational) return rigSystemFor(canvas)
    const box = `${String(canvas)}x${String(canvas)}x${String(canvas)}`
    /*
     * The experiments each add their words here as well as to the reply's scope in `gen/code.ts`.
     * Both halves or neither: a function the prompt never mentions is one the model never calls, and
     * a function the prompt describes but nothing implements throws on the line that calls it.
     */
    const extra = [
        flags.silhouette ? SILHOUETTE_HELP : '',
        flags.procedural ? PROCEDURAL_HELP : '',
        flags.faces ? FACE_HELP : ''
    ].join('')
    return `You write JavaScript that builds a voxel model. These functions exist already:
  box(x0,y0,z0, x1,y1,z1, "#rrggbb")   solid box, inclusive integer bounds
  ball(x,y,z, rx,ry,rz, "#rrggbb")     axis-aligned ellipsoid
  erase(x0,y0,z0, x1,y1,z1)            carve empty space
  mirrorX()                            call last to mirror the model across its centre in x
${extra}
Axes: x = left/right, y = up/down (bigger y is higher), z = front/back. Feet at y=0.
Keep everything inside ${box}. The finished model should be close to ${String(canvas)} tall and fill
most of that box — scale the proportions up to it rather than drawing a small model in a corner.
Use variables and loops where they help symmetry and repetition.
Ops apply in order; later calls paint over earlier ones.
Block out the big masses first, then carve with erase, then add small details.
Use 4-8 distinct colors with real value contrast, not near-identical shades.
Plan the proportions in a short comment first, then the code.
Answer with only JavaScript, no markdown fence.`
}

/** What the model is asked for when nothing has enforced a canvas: the size everything was measured at. */
export const SYSTEM = systemFor(MAX_SIZE)

/**
 * Exactly what produced a candidate, stored with the asset it becomes.
 *
 * A generated asset whose seed and sampler were not recorded cannot be reproduced or nudged, only
 * regenerated and hoped over. It travels in the `.gpix` — see `doc/save.ts`.
 */
export interface Sampler {
    readonly temperature: number
    readonly seed: number
}

export interface GenerationRecord {
    readonly prompt: string
    readonly sampler: Sampler
    /** What the server said it was running, so a file records the model rather than the port. */
    readonly model: string
    /** ISO 8601. */
    readonly at: string
    /**
     * Which examples the batch was shown, closest first. Optional, because a file written before
     * the bank existed has no answer and inventing one would be a lie about what made the model.
     * It is recorded at all because the pick is its own model call: prompt and seed alone no
     * longer reproduce a candidate.
     *
     * A file written when the bank was five fixed body plans holds one id, which is exactly what it
     * was shown, so an old record reads as a one-element list rather than as a gap.
     */
    readonly examples?: readonly string[]
    /**
     * The cube the model was asked to draw inside, when a canvas was enforced.
     *
     * It is in the record because it is in the *system prompt*: the same prompt and the same seed at
     * 64 and at 128 are two different questions and two different answers. Absent means the canvas
     * switch was off, and the model was asked for 32 and got a grid fitted to what it painted.
     *
     * Whether the palette was enforced is deliberately not here. That happens after generation and
     * changes nothing about what the model produced, and the palette it snapped to belonged to a
     * document this file has replaced — recording a bare `true` would name an effect with no cause.
     */
    readonly canvas?: number
}

/**
 * What one call is asked for beyond its prompt and its sampler: the examples, and the box.
 *
 * One value rather than two parameters because both are properties of the batch rather than of the
 * candidate — they are computed once, before the loop, and every candidate is handed the same brief.
 */
export interface Brief {
    /** The cube the system prompt asks for, or `undefined` to ask for the measured 32. */
    readonly canvas: number | undefined
    readonly examples: readonly WorkedExample[]
    /**
     * Which experiments this batch runs under — see `gen/flags.ts`.
     *
     * It belongs to the brief rather than to the port because it changes what the *call* says: the
     * system prompt's vocabulary and the scope the reply is run in are the two halves of one
     * language, and the port is the only place both are known.
     */
    readonly flags?: Flags
    /**
     * What went wrong last time, when this call is the `retryEmpty` experiment's second go — §11.
     *
     * The one field here that belongs to the attempt rather than to the batch, and it is here
     * because it is another turn in the same conversation the rest of the brief builds. It carries
     * an **execution error**, never a render: 3DCodeBench measured error-feedback retry taking
     * executability from 70.2 % to 97.4 % across every model size, and measured feeding a picture
     * back as doing nothing at all for geometry — which is the loop that died here three times.
     */
    readonly retry?: string
}

export interface Candidate {
    readonly spec: VoxSpec
    readonly volume: Volume
    /**
     * The scores, computed once, here, because this is the only place both grids exist.
     *
     * `shellColors` has to be measured on the model *before* `finish` shaded it — see `scoreModel` —
     * and by the time a candidate reaches `batch.ts` the flat grid is gone. It was scored twice
     * before this field: once by the gate and once by the batch, from the same volume, so the second
     * was a duplicate of the first with no reason to disagree and one way to.
     */
    readonly scores: ModelScores
    readonly record: GenerationRecord
}

/** How many ops in a spec actually paint. A reply of nothing but `erase` is a blank slot. */
const countPainting = (spec: VoxSpec): number => spec.ops.filter(op => op.op !== 'erase').length

/** What one attempt produced: a model, or the reason there is not one. */
export type Attempt =
    | {readonly ok: true; readonly candidate: Candidate}
    | {readonly ok: false; readonly error: string}

export interface Llama {
    /** Is the server there? The dialog asks before it offers to spend a minute. */
    readonly probe: () => Promise<string | undefined>
    /**
     * Which worked examples this subject should be shown, closest first. Once per batch — the
     * answer is a property of the subject, not of the seed. See `bank.ts`'s `pickPrompt`.
     */
    readonly pick: (
        prompt: string,
        picks: number,
        signal?: AbortSignal
    ) => Promise<readonly string[]>
    readonly generate: (
        prompt: string,
        sampler: Sampler,
        brief: Brief,
        signal?: AbortSignal
    ) => Promise<{spec: VoxSpec; model: string}>
}

interface ChatReply {
    choices?: {message?: {content?: string}}[]
    model?: string
}

interface ModelList {
    data?: {id?: string}[]
}

/**
 * 4096, which is roughly ten times what a measured code reply cost (170–600 characters).
 *
 * A reply that runs out of tokens is truncated mid-line; `specFromCode` keeps the ops the whole
 * lines painted, so truncation degrades to a partial model rather than to nothing. The headroom is
 * what makes even that rare.
 */
const MAX_TOKENS = 4096

/**
 * The real one. It needs the manifest because the picking call's prompt *is* the manifest — the
 * list of ids and what each is for, rendered by `pickPrompt`.
 */
export const browserLlama = (manifest: Manifest, endpoint: string = DEFAULT_ENDPOINT): Llama => ({
    probe: async () => {
        try {
            const response = await fetch(`${endpoint}/v1/models`)
            if (!response.ok) return undefined
            const body = (await response.json()) as ModelList
            return body.data?.[0]?.id ?? 'unknown'
        } catch {
            // Not running, or not reachable. Both are "no local model" as far as the artist cares.
            return undefined
        }
    },
    pick: async (prompt, picks, signal) => {
        try {
            const response = await fetch(`${endpoint}/v1/chat/completions`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                ...(signal ? {signal} : {}),
                body: JSON.stringify({
                    messages: [
                        {role: 'system', content: pickPrompt(manifest, picks)},
                        {role: 'user', content: prompt}
                    ],
                    // A short list of ids. The headroom below is for a model that draws.
                    max_tokens: 32,
                    temperature: 0
                })
            })
            if (!response.ok) return [manifest.fallback]
            const body = (await response.json()) as ChatReply
            return readPicks(body.choices?.[0]?.message?.content ?? '', manifest, picks)
        } catch {
            // A failed pick must not sink the batch: the fallback still generates, just generically.
            return [manifest.fallback]
        }
    },
    generate: async (prompt, sampler, brief, signal) => {
        const response = await fetch(`${endpoint}/v1/chat/completions`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            ...(signal ? {signal} : {}),
            body: JSON.stringify({
                messages: [
                    {role: 'system', content: systemFor(brief.canvas ?? MAX_SIZE, brief.flags)},
                    // Each example is a completed exchange. The last one sits against the prompt,
                    // which is the position the model imitates hardest — see `Library.teach`.
                    ...brief.examples.flatMap(example => [
                        {role: 'user', content: example.prompt},
                        {role: 'assistant', content: example.reply}
                    ]),
                    {role: 'user', content: prompt},
                    // The failed reply is deliberately not quoted back. What is fed back is the
                    // error, because the model re-emits what it is shown — see the `retry` note.
                    ...(brief.retry === undefined ?
                        []
                    :   [
                            {
                                role: 'assistant' as const,
                                content: '// (that reply painted no voxels)'
                            },
                            {
                                role: 'user' as const,
                                content: `${brief.retry}. Answer again, with JavaScript that calls box(...) at least once. No prose, no markdown fence.`
                            }
                        ])
                ],
                max_tokens: MAX_TOKENS,
                temperature: sampler.temperature,
                seed: sampler.seed
            })
        })
        if (!response.ok) {
            throw new Error(`llama-server ${String(response.status)}: ${await response.text()}`)
        }
        const body = (await response.json()) as ChatReply
        const content = body.choices?.[0]?.message?.content
        if (content === undefined || content === '') throw new Error('the server returned nothing')
        const spec = specFromCode(content, prompt, brief.canvas ?? MAX_SIZE, brief.flags)
        if (!spec) throw new Error('the reply held no usable ops')
        return {spec, model: body.model ?? 'unknown'}
    }
})

/** What `memoryLlama` recorded about one call, so a test can assert on what was sent. */
export interface SeenCall {
    readonly prompt: string
    readonly sampler: Sampler
    readonly brief: Brief
}

/** A canned server, for tests and for nothing else. Replies are handed back in order. */
export const memoryLlama = (
    replies: readonly (VoxSpec | Error)[],
    model = 'memory',
    picks: readonly string[] = ['dog']
): Llama & {readonly seen: SeenCall[]; readonly asked: number[]} => {
    const seen: SeenCall[] = []
    /** The cap each picking call was made with, so a test can see the `onePick` flag reach the wire. */
    const asked: number[] = []
    let next = 0
    return {
        seen,
        asked,
        probe: () => Promise.resolve(model),
        pick: (_prompt, cap) => {
            asked.push(cap)
            return Promise.resolve(picks.slice(0, Math.max(1, cap)))
        },
        generate: (prompt, sampler, brief, signal) => {
            seen.push({prompt, sampler, brief})
            if (signal?.aborted === true) return Promise.reject(new Error('cancelled'))
            const reply = replies[next % Math.max(1, replies.length)]
            next += 1
            if (reply === undefined) return Promise.reject(new Error('no reply'))
            if (reply instanceof Error) return Promise.reject(reply)
            return Promise.resolve({spec: reply, model})
        }
    }
}

export interface GenerateOptions {
    readonly temperature?: number
    /** The seed of the first candidate. The rest count up from it — see below. */
    readonly seed?: number
    readonly signal?: AbortSignal
    /** Called as each attempt lands, so the grid fills in rather than appearing all at once. */
    readonly onAttempt?: (attempt: Attempt, done: number, total: number) => void
    /** Called once, with the ids of the examples the whole batch will be shown. */
    readonly onPick?: (ids: readonly string[]) => void
    /**
     * Called after each candidate the gate looked at — see `gen/gate.ts`, and only when `gates` is
     * on. It carries the running tally rather than one verdict, because the line the dialog draws
     * is about the batch: how many were kept, how many seeds went on rejects, and whether the
     * budget ran out.
     */
    readonly onGate?: (tally: GateTally) => void
    /**
     * Ids into the examples they teach with, in the order they should be sent.
     *
     * A function rather than the bank itself, because the app composes two sources: the bank on
     * disk and whatever model the artist dropped on the dialog. Defaults to teaching nothing, which
     * is a worse model and never a broken one.
     */
    readonly teach?: (ids: readonly string[]) => readonly WorkedExample[]
    /**
     * The cube every candidate is asked for and gets — see `gen/ops.ts`'s `gridFor`.
     *
     * `undefined` is the switch turned off: the model is asked for 32, which is what every finding
     * on the record was measured at, and the grid is fitted to what it painted.
     */
    readonly canvas?: number | undefined
    /**
     * The project's colours, when the palette is being enforced — see `gen/palette.ts`.
     *
     * Applied after `finish`, so the shading is snapped along with the base colours and a candidate
     * carries no colour the artist has not already got.
     */
    readonly swatches?: Swatches | undefined
    /**
     * Which experiments are on — see `gen/flags.ts` and `docs/GEN_IDEAS.md`.
     *
     * Defaulted to all off rather than made required, and that default is the point: every finding
     * in `docs/GEN_RESEARCH.md` was measured against this function with none of them on, so a caller
     * that says nothing gets the generator those numbers describe.
     */
    readonly flags?: Flags
    readonly now?: () => Date
}

/**
 * The examples that teach an experiment's own language, or none at all.
 *
 * Keyed by subject so each reads as an ordinary exchange: the model is shown "a fish" answered in
 * the new words, which is what an example is for.
 */
const experimentExamples = (flags: Flags, picked: readonly string[]): readonly WorkedExample[] => {
    /*
     * §2 replaces the bank's replies rather than joining them: they are written in the language it
     * takes away, and a batch shown both would be taught two answers to the same question. The
     * *pick* still stands — `RIG_REPLIES` is keyed by the same five ids — so the same subject gets
     * the same teacher, rewritten. That is also why the record's `examples` stay honest.
     */
    if (flags.relational) {
        return picked.flatMap(id => {
            const reply = RIG_REPLIES[id]
            return reply === undefined ? [] : [{prompt: `a ${id}`, reply}]
        })
    }
    const out: WorkedExample[] = []
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

export const randomSeed = (): number => Math.floor(Math.random() * 2 ** 31)

/**
 * N candidates for one prompt, in sequence.
 *
 * Sequentially, not in parallel: the server has two slots and shares both GPUs with nothing else,
 * so firing N requests at once buys queueing rather than throughput.
 *
 * Each candidate gets `seed + i` rather than the seed it was given. One seed across N calls at one
 * temperature is one candidate rendered N times — the whole point of generate-and-rank is that the
 * candidates differ — and a caller that pins a seed to reproduce a result gets the same N back,
 * which is what pinning it was for.
 */
export const generateMany = async (
    llama: Llama,
    prompt: string,
    count: number,
    options: GenerateOptions = {}
): Promise<readonly Attempt[]> => {
    const {
        temperature = 0.9,
        seed = randomSeed(),
        signal,
        onAttempt,
        onPick,
        onGate,
        teach = () => [],
        canvas,
        swatches,
        flags = DEFAULT_FLAGS,
        now = () => new Date()
    } = options
    const attempts: Attempt[] = []
    // Once, before the loop: which example fits belongs to the subject, not to the seed.
    const picked = await llama.pick(prompt, picksFor(flags.onePick), signal)
    onPick?.(picked)
    /*
     * The worked examples, with the experiments' own in front of the bank's when one is on.
     *
     * In *front*, so the bank's pick still sits nearest the prompt — the position the model imitates
     * hardest (finding 7). They are examples rather than more prose because that is the whole of
     * finding 7: one worked example took "a cat" from 0 recognisable of 12 to 4 of 4, and no rule in
     * the system prompt has ever done anything of the sort.
     */
    const brief: Brief = {
        canvas,
        examples:
            flags.relational ?
                experimentExamples(flags, picked)
            :   [...experimentExamples(flags, picked), ...teach(picked)],
        flags
    }
    /*
     * Two counters, not one, and only the `gates` experiment can part them: `spent` is how many
     * seeds have been asked for and `attempts.length` is how many candidates the artist will see.
     * With the gate off they are equal on every pass, which is what keeps the measured behaviour —
     * N asked, N reported, a failure never quietly replaced — exactly what it was.
     */
    let spent = 0
    let tally = NOTHING_GATED
    while (attempts.length < count) {
        if (signal?.aborted === true) break
        const sampler: Sampler = {temperature, seed: seed + spent}
        spent += 1
        let attempt: Attempt
        try {
            let asked = brief
            let answer = await llama.generate(prompt, sampler, asked, signal)
            /*
             * §11 — one retry, carrying the error. `specFromCode` keeps whatever the reply painted
             * before it crashed, so this fires only for a reply that painted *nothing*: ten seconds
             * spent and a blank slot. One, not a loop: the measured win is the first retry.
             */
            if (flags.retryEmpty && countPainting(answer.spec) === 0) {
                asked = {...brief, retry: 'That reply produced no voxels'}
                answer = await llama.generate(prompt, sampler, asked, signal)
            }
            const {spec, model} = answer
            const painted = rasterise(spec, canvas)
            /*
             * Repaired before it is shaded, so `finish` shades the model that survived — see
             * `gen/repair.ts`, §1. Off, `repair` is not called at all rather than called and
             * ignored: the identity of the volume is what the caller compares.
             */
            const volume = flags.repair ? repair(painted).volume : painted
            /*
             * Shaded here, not stored: the spec stays flat-coloured, and rasterise-then-finish
             * reproduces the asset from the record exactly.
             *
             * The palette snap comes *after* the shading, so the two invented tones per colour are
             * held to the project's palette along with the colour they came from. Snapping first
             * would enforce the palette on the one third of the colours that never reaches a voxel
             * on its own.
             */
            const shaded = swatches ? snapTo(finish(volume), swatches) : finish(volume)
            attempt =
                volume.data.some(value => value !== 0) ?
                    {
                        ok: true,
                        candidate: {
                            spec,
                            volume: shaded,
                            // Both grids, and only here: `shellColors` is a fact about what the
                            // reply painted, and `finish` has invented two tones per colour in the
                            // one above.
                            scores: scoreModel(shaded, volume),
                            record: {
                                prompt,
                                sampler,
                                model,
                                examples: picked,
                                ...(canvas === undefined ? {} : {canvas}),
                                at: now().toISOString()
                            }
                        }
                    }
                :   {ok: false, error: 'the model produced no voxels'}
        } catch (error) {
            attempt = {ok: false, error: error instanceof Error ? error.message : String(error)}
        }
        /*
         * The gate, §4 — rejection sampling and nothing else. Nothing is fed back, the prompt does
         * not change and the model is never told it failed, which is what keeps this off the dead
         * revision loop's list. A rejected candidate costs a seed and not a slot; once the budget is
         * gone `admit` keeps the failures, because an empty grid after a spent minute is worse than
         * a wrong sprite the artist can look at.
         */
        if (flags.gates && attempt.ok) {
            /*
             * The spec's own declaration decides which rules apply — see `gen/face.ts`. A reply that
             * called `face` said its content is on its surface, so the brick rule stands down and the
             * flat rule takes over. Without that, the gate rejects a correct block: measured live on
             * "a Mario brick block" at 83 % and 95 % solid.
             */
            const surface = attempt.candidate.spec.surface === true
            const admission = admit(scoreModel(attempt.candidate.volume), tally, count, surface)
            tally = admission.tally
            onGate?.(tally)
            if (!admission.keep) {
                onAttempt?.(
                    {ok: false, error: admission.failure ?? 'the gate rejected it'},
                    attempts.length,
                    count
                )
                continue
            }
        }
        attempts.push(attempt)
        onAttempt?.(attempt, attempts.length, count)
    }
    return attempts
}
