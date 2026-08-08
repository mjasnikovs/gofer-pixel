import {useCallback, useEffect, useRef, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {NumberInput} from '@astryxdesign/core/NumberInput'
import {ProgressBar} from '@astryxdesign/core/ProgressBar'
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl'
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
    const {candidate, scores} = entry
    return (
        <div className='generate-card'>
            <Thumbnail
                volume={candidate.volume}
                camera={createCamera(candidate.volume, Math.PI / 4, ISOMETRIC_PITCH)}
                size={112}
                className='generate-thumb'
            />
            <Text weight='semibold'>{candidate.spec.name}</Text>
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
    onClose,
    onPick,
    onRunning
}: {
    llama: Llama
    scorer: Scorer
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
    const [clipNote, setClipNote] = useState('')
    const [ranked, setRanked] = useState<readonly Ranked[]>([])
    const [rankBy, setRankBy] = useState<'built-in' | 'clip'>('built-in')
    const [server, setServer] = useState<string | undefined>(undefined)

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
        setBusy(true)
        setRanked([])
        setDone(0)
        setRankBy('built-in')
        setClipNote('')
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
                        clip: null
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
        if (landed.length === 0 || controller.signal.aborted) return

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
                landed.map(entry => rankingViews(entry.candidate.volume))
            )
            const scores = await scorer.score(prompt, views, controller.signal)
            const withClip = landed.map((entry, i) => ({...entry, clip: scores[i] ?? null}))
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
    }, [llama, scorer, prompt, count])

    const hasClip = ranked.some(entry => entry.clip !== null)
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
                            const batch = run()
                            onRunning?.(batch)
                            void batch
                        }}
                    />
                </div>

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
