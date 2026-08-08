import {useCallback, useEffect, useRef, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {NumberInput} from '@astryxdesign/core/NumberInput'
import {ProgressBar} from '@astryxdesign/core/ProgressBar'
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl'
import {Switch} from '@astryxdesign/core/Switch'
import {Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import {ISOMETRIC_PITCH} from '../doc/cameras'
import {rankAgreement, type Scorer} from '../gen/clip'
import {
    generateMany,
    randomSeed,
    type Candidate,
    type GenerationRecord,
    type Llama
} from '../gen/llama'
import {overallScore, scoreModel, type ModelScores} from '../gen/score'
import {judge, type Veto, type Verdict} from '../gen/veto'
import {rankingViews} from '../gen/views'
import {createCamera} from '../render/camera'
import type {Volume} from '../render/volume'
import {Thumbnail} from './Thumbnail'

/**
 * The local-AI pipeline behind a dialog: prompt, N candidates, a ranked grid, pick one into the
 * editor as an ordinary undoable document.
 *
 * A dialog rather than a panel, and this is the one place the mockups are silent. `docs/editor.png`
 * budgets every pixel of the window to the tools, the palette, the cameras and the export, and
 * generation is not a thing an artist is doing *while* they draw — it is a thing they do once, for
 * half a minute, before they start. A panel would take a permanent column for it.
 *
 * Nothing here is a quality gate. The built-in scores are exact and rank the broken candidates down;
 * CLIP is a better opinion when `py/clipserve.py` happens to be running, and both are sort orders
 * over one batch. The artist looks at the pictures.
 */
export interface Ranked {
    readonly candidate: Candidate
    readonly scores: ModelScores
    readonly overall: number
    readonly clip: number | null
    /**
     * What the vision model called it — see `gen/veto.ts`. `null` until it has been asked.
     *
     * A failed verdict sorts a candidate to the end and marks it. It never removes one: the judge is
     * loose enough to have called a good cat a sheep, and the artist is looking at the same picture
     * it was.
     */
    readonly veto: Verdict | null
}

/** How many candidates can be asked for at once. */
export const MAX_CANDIDATES = 12

export const DEFAULT_PROMPT = 'a stone tower'

/**
 * Four is the default because generation is *slow*: 7–20 s per candidate against the local
 * Qwen3.6-27B, measured 2026-08-08, sequentially because the server shares both GPUs with nothing
 * else. Four is about a minute, which is a wait somebody will sit through; twelve is four minutes,
 * which is why it is the ceiling rather than the default.
 */
export const DEFAULT_COUNT = 4

const percent = (value: number): string => `${String(Math.round(value * 100))}%`

const CandidateCard = ({
    entry,
    isBest,
    onPick
}: {
    entry: Ranked
    isBest: boolean
    onPick: () => void
}) => {
    const {candidate, scores, veto} = entry
    return (
        <div className='generate-card'>
            <Thumbnail
                volume={candidate.volume}
                camera={createCamera(candidate.volume, Math.PI / 4, ISOMETRIC_PITCH)}
                size={112}
                className='generate-thumb'
            />
            <Text weight='semibold'>{candidate.spec.name}</Text>
            {veto !== null && veto.word !== '' && (
                <Text
                    type='supporting'
                    color='secondary'
                >
                    {`reads as "${veto.word}"`}
                </Text>
            )}
            <Text
                type='supporting'
                color='disabled'
            >
                {`${String(scores.voxels)} voxels · ${String(scores.colorsUsed)} colours`}
                <br />
                {`joined ${percent(scores.connectivity)} · layers ${percent(scores.sliceUsage)}`}
                <br />
                {`solid ${percent(scores.bboxFill)} · rank ${entry.overall.toFixed(2)}`}
                {entry.clip === null ? '' : ` · clip ${entry.clip.toFixed(3)}`}
            </Text>
            <Button
                label='Use this one'
                size='sm'
                variant={isBest ? 'primary' : 'secondary'}
                onClick={onPick}
            />
        </div>
    )
}

export const GenerateDialog = ({
    llama,
    scorer,
    veto,
    onClose,
    onPick,
    onRunning
}: {
    llama: Llama
    scorer: Scorer
    /** The naming judge — see `gen/veto.ts`. Same server as `llama`, different question. */
    veto: Veto
    onClose: () => void
    onPick: (volume: Volume, name: string, record: GenerationRecord) => void
    /**
     * The in-flight batch, handed out the moment it starts. The same seam `Viewport` opens with
     * `renderNow()`, and for the same reason: a batch is not owned by the click that started it, so
     * a test that could only click would have to wait a duration to see the end of one — and this
     * one really is asynchronous past the microtask queue, because encoding a PNG goes through a
     * `CompressionStream`. Left running, it also carries on rendering into an unmounted tree.
     */
    onRunning?: (batch: Promise<void>) => void
}) => {
    const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
    const [count, setCount] = useState(DEFAULT_COUNT)
    const [busy, setBusy] = useState(false)
    const [done, setDone] = useState(0)
    const [status, setStatus] = useState('')
    const [vetoNote, setVetoNote] = useState('')
    const [clipNote, setClipNote] = useState('')
    const [ranked, setRanked] = useState<readonly Ranked[]>([])
    const [rankBy, setRankBy] = useState<'built-in' | 'clip'>('built-in')
    const [server, setServer] = useState<string | undefined>(undefined)
    /**
     * Off by default. It costs one extra call to the vision model per candidate and the word it
     * comes back with sorts nothing — it is worth switching on when a batch keeps coming back
     * wrong and you want to know what the model thinks it drew instead. See `gen/veto.ts`.
     */
    const [naming, setNaming] = useState(false)

    /*
     * The one AbortController, held across renders: Cancel has to reach a fetch that a *previous*
     * render started, and the run below has to be able to check it without being re-created.
     */
    const running = useRef<AbortController | undefined>(undefined)

    useEffect(() => {
        let live = true
        void llama.probe().then(found => {
            if (!live) return
            setServer(found)
            setStatus(
                found === undefined ?
                    'No local model. Start llama-server on :8080 and reopen this.'
                :   `Ready — ${found}`
            )
        })
        return () => {
            live = false
            // Leaving mid-batch must stop the batch. Without this the loop keeps asking a 27B
            // model for models nothing will ever show.
            running.current?.abort()
        }
    }, [llama])

    const run = useCallback(async (): Promise<void> => {
        const controller = new AbortController()
        running.current = controller
        // Read through a call, never as a field: the flag flips during an `await`, and a plain read
        // narrows to `false` for the rest of the function under the type-aware lint rules.
        const stopped = (): boolean => controller.signal.aborted
        setBusy(true)
        setRanked([])
        setDone(0)
        setRankBy('built-in')
        setClipNote('')
        setVetoNote('')
        setStatus(`Generating 0/${String(count)}…`)

        const landed: Ranked[] = []
        let shown = ''
        const attempts = await generateMany(llama, prompt, count, {
            seed: randomSeed(),
            signal: controller.signal,
            /*
             * Named in the status line rather than left implicit. The batch is shown one worked
             * example and it is the strongest single influence on what comes back — a chicken built
             * against the quadruped example comes back with four legs — so an artist looking at
             * twelve wrong candidates should be able to see *why* without reading the source.
             */
            onPlan: plan => {
                shown = plan
            },
            onAttempt: (attempt, at, total) => {
                setDone(at)
                if (attempt.ok) {
                    const scores = scoreModel(attempt.candidate.volume)
                    landed.push({
                        candidate: attempt.candidate,
                        scores,
                        overall: overallScore(scores),
                        clip: null,
                        veto: null
                    })
                    // A copy per attempt, so the grid fills in rather than appearing at the end.
                    setRanked([...landed])
                }
                setStatus(`Generating ${String(at)}/${String(total)}…`)
            }
        })

        const failures = attempts.filter(attempt => !attempt.ok)
        setStatus(
            `${String(landed.length)} candidates, ${String(failures.length)} failed`
                + (shown === '' ? '' : ` · built as ${shown}`)
                + (failures[0]?.ok === false ? ` — ${failures[0].error.slice(0, 90)}` : '')
        )
        setBusy(false)
        if (landed.length === 0 || stopped()) return

        /*
         * What each candidate reads as. One vision call each, sequentially, for the same reason
         * generation is sequential.
         *
         * It was built to be a veto and it is not one: measured over 8 cats and 8 knights, it threw
         * away a real cat for being called "dog" and the best knight of eight for being called
         * "santa". The word itself is honest and worth reading — a knight that reads as "santa" is
         * telling the artist exactly which part of the sprite is wrong.
         */
        const judged = [...landed]
        if (naming) {
            setVetoNote(`Naming: 0/${String(judged.length)}…`)
            for (let i = 0; i < judged.length; i += 1) {
                const entry = judged[i]
                if (!entry || stopped()) break
                judged[i] = {
                    ...entry,
                    veto: await judge(veto, entry.candidate.volume, prompt, controller.signal)
                }
                setRanked([...judged])
                setVetoNote(`Naming: ${String(i + 1)}/${String(judged.length)}…`)
            }
            const missed = judged.filter(entry => entry.veto?.pass === false)
            const asked = judged.filter(entry => entry.veto !== null && entry.veto.word !== '')
            setVetoNote(
                asked.length === 0 ?
                    'Naming: the model would not say what these are'
                :   `Naming: ${String(asked.length - missed.length)} of ${String(asked.length)} read as the subject`
            )
        }
        if (stopped()) return

        /*
         * CLIP second, and only if the service is up. It is a second opinion on an ordering that
         * already exists, so the grid must never wait on it — and the artist can pick a candidate
         * while it is being asked.
         */
        setClipNote('CLIP: ranking…')
        try {
            if (!(await scorer.probe())) {
                setClipNote('CLIP: py/clipserve.py is not running — built-in scores only')
                return
            }
            const views = await Promise.all(
                judged.map(entry => rankingViews(entry.candidate.volume))
            )
            const scores = await scorer.score(prompt, views, controller.signal)
            const withClip = judged.map((entry, i) => ({...entry, clip: scores[i] ?? null}))
            setRanked(withClip)
            setRankBy('clip')
            const agreement = rankAgreement(
                withClip.map(entry => entry.overall),
                withClip.map(entry => entry.clip)
            )
            setClipNote(
                `CLIP: ${String(scores.filter(score => score !== null).length)} ranked`
                    + ` · agreement with the built-in order ${agreement.toFixed(2)}`
            )
        } catch (error) {
            setClipNote(`CLIP: ${error instanceof Error ? error.message : String(error)}`)
        }
    }, [llama, scorer, veto, naming, prompt, count])

    /*
     * The slots still to fill. `done` counts attempts, not candidates, so a failed attempt closes
     * its own placeholder rather than leaving one shimmering for a model that will never arrive.
     */
    const pending = busy ? Math.max(0, count - done) : 0

    /** The one way a batch starts, so the button and the Enter key cannot drift apart. */
    const start = (): void => {
        const batch = run()
        onRunning?.(batch)
        void batch
    }

    const hasClip = ranked.some(entry => entry.clip !== null)
    /*
     * The naming does not touch the order, and that is a measurement rather than caution — see
     * `gen/veto.ts` and `docs/GEN_RESEARCH.md`, 2026-08-08. Sorted by it, a real cat with ears and
     * an upright tail went last for being called "dog", and the best knight of eight went last for
     * being called "santa". The word is shown because it says what the sprite reads as; it does not
     * get to move anything.
     */
    const order = [...ranked].sort((a, b) =>
        rankBy === 'clip' && hasClip ?
            (b.clip ?? -Infinity) - (a.clip ?? -Infinity)
        :   b.overall - a.overall
    )

    return (
        <Dialog
            isOpen
            purpose='form'
            width={780}
            onOpenChange={open => {
                if (!open) onClose()
            }}
        >
            <DialogHeader
                title='Generate a model'
                subtitle='A local model emits solid primitives and this turns them into voxels. Picking one replaces the open document.'
                onOpenChange={open => {
                    if (!open) onClose()
                }}
            />

            <div
                className='generate'
                data-testid='generate-dialog'
            >
                <div className='generate-ask'>
                    <TextInput
                        label='Prompt'
                        size='sm'
                        value={prompt}
                        isDisabled={busy}
                        onChange={setPrompt}
                        // Enter is what a prompt field is for. Guarded rather than unconditional:
                        // held down mid-batch it would start a second batch over the first.
                        onEnter={() => {
                            if (!busy && server !== undefined) start()
                        }}
                    />
                    <NumberInput
                        label='Candidates'
                        size='sm'
                        min={1}
                        max={MAX_CANDIDATES}
                        step={1}
                        value={count}
                        isDisabled={busy}
                        onChange={value => {
                            setCount(Math.min(MAX_CANDIDATES, Math.max(1, Math.round(value))))
                        }}
                    />
                    <Button
                        label={busy ? 'Cancel' : 'Generate'}
                        size='sm'
                        variant={busy ? 'secondary' : 'primary'}
                        isDisabled={!busy && server === undefined}
                        tooltip={
                            server === undefined ?
                                'llama-server is not answering on :8080'
                            :   'Ask the local model for candidates — about 10 s each'
                        }
                        onClick={() => {
                            if (busy) {
                                running.current?.abort()
                                return
                            }
                            start()
                        }}
                    />
                </div>

                <Switch
                    label='Ask what each result looks like'
                    description='Slower. Puts the model’s own word under each picture.'
                    size='sm'
                    value={naming}
                    isDisabled={busy}
                    onChange={setNaming}
                />

                {busy && (
                    <ProgressBar
                        label='Generating candidates'
                        isLabelHidden
                        value={done}
                        max={count}
                    />
                )}

                <div className='generate-status'>
                    <Text type='supporting'>
                        <span data-testid='generate-status'>{status}</span>
                    </Text>
                    <Text
                        type='supporting'
                        color='disabled'
                    >
                        <span data-testid='veto-status'>{vetoNote}</span>
                    </Text>
                    <Text
                        type='supporting'
                        color='disabled'
                    >
                        <span data-testid='clip-status'>{clipNote}</span>
                    </Text>
                    {hasClip && (
                        <SegmentedControl
                            label='Rank by'
                            size='sm'
                            value={rankBy}
                            onChange={value => {
                                setRankBy(value === 'clip' ? 'clip' : 'built-in')
                            }}
                        >
                            <SegmentedControlItem
                                value='built-in'
                                label='Built-in'
                            />
                            <SegmentedControlItem
                                value='clip'
                                label='CLIP'
                            />
                        </SegmentedControl>
                    )}
                </div>

                <div className='generate-grid'>
                    {order.map((entry, i) => (
                        <CandidateCard
                            key={`${entry.candidate.record.at}-${String(entry.candidate.record.sampler.seed)}`}
                            entry={entry}
                            isBest={i === 0}
                            onPick={() => {
                                onPick(
                                    entry.candidate.volume,
                                    entry.candidate.spec.name,
                                    entry.candidate.record
                                )
                            }}
                        />
                    ))}
                    {/*
                     * One empty slot per candidate still to come, so the grid has its final shape
                     * from the first second. A candidate is 7–20 s and only the *finished* ones can
                     * be drawn, so without these the artist watches an empty box for twenty seconds
                     * and cannot tell a slow model from a broken one.
                     */}
                    {Array.from({length: pending}, (_, i) => (
                        <div
                            key={`pending-${String(i)}`}
                            className='generate-card generate-pending'
                            data-testid='generate-pending'
                            aria-hidden='true'
                        >
                            <div className='generate-thumb generate-thumb-empty' />
                            <div className='generate-pending-line' />
                            <div className='generate-pending-line generate-pending-line-short' />
                        </div>
                    ))}
                </div>

                {/*
                 * The two things measured about this pipeline that an artist would otherwise find
                 * out by wasting ten minutes. Both are in `legacy/docs/DESIGN_PROGRESS.md`.
                 */}
                <Text
                    type='supporting'
                    color='disabled'
                >
                    Organic and architectural subjects work. Directional machines — a tank, a car —
                    come back front-to-back reversed, and no prompt fixes it.
                </Text>
            </div>
        </Dialog>
    )
}
