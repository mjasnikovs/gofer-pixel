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
import {browserFiles, type Files} from '../doc/files'
import {browserStore, type Store} from '../doc/store'
import type {WorkedExample} from '../gen/bank'
import {choose, forget, recall, takeFile, type Outcome} from '../gen/reference'
import {
    clipNote,
    generateNote,
    hasClip,
    idleBatch,
    namingNote,
    ordered,
    pendingSlots,
    runBatch,
    type BatchState,
    type Ranked
} from '../gen/batch'
import type {Scorer} from '../gen/clip'
import {browserLlama, randomSeed, type GenerationRecord, type Llama} from '../gen/llama'
import type {Library} from '../gen/library'
import type {Veto} from '../gen/veto'
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
 * **The batch itself is not here.** Stage order, cancellation and every measured rule about what may
 * re-rank what live in `gen/batch.ts`, which needs no DOM; this holds one `BatchState` and draws it.
 * What is left in this file is the dialog: the prompt, the count, the dropped reference, and which
 * of the two orders the artist is looking at.
 *
 * Nothing here is a quality gate. The built-in scores are exact and rank the broken candidates down;
 * CLIP is a better opinion when `py/clipserve.py` happens to be running, and both are sort orders
 * over one batch. The artist looks at the pictures.
 */
export type {Ranked}

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
    library,
    llama,
    store = browserStore(),
    files = browserFiles(),
    scorer,
    veto,
    onClose,
    onPick,
    onRunning
}: {
    /** The worked-example bank, loaded on open — see `src/gen/library.ts`. */
    library: () => Promise<Library>
    /** Overridden by tests. Left out, it is built from the bank's manifest once that has loaded. */
    llama?: Llama
    /** Where the dropped reference is remembered across reloads. */
    store?: Store
    /**
     * Where "Choose a model" reads from — see `doc/files.ts`.
     *
     * Its own instance, not the app's. This port remembers which file Save writes back to, and a
     * reference model is not the document.
     */
    files?: Files
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
    /** The batch, whole, as `gen/batch.ts` last published it. */
    const [batch, setBatch] = useState<BatchState>(() => idleBatch(DEFAULT_COUNT))
    /**
     * Which order the artist has asked for, or `undefined` to follow the batch.
     *
     * The batch decides the *default* — it flips to CLIP once CLIP has actually ranked — and this
     * only exists so that a click on the segmented control outlives the next thing the batch says.
     */
    const [rankBy, setRankBy] = useState<'built-in' | 'clip' | undefined>(undefined)
    const [status, setStatus] = useState('')
    const [server, setServer] = useState<string | undefined>(undefined)
    /**
     * Off by default. It costs one extra call to the vision model per candidate and the word it
     * comes back with sorts nothing — it is worth switching on when a batch keeps coming back
     * wrong and you want to know what the model thinks it drew instead. See `gen/veto.ts`.
     */
    const [naming, setNaming] = useState(false)
    /** The bank and the client built from it. Both `undefined` until the load lands. */
    const [lib, setLib] = useState<Library | undefined>(undefined)
    const [client, setClient] = useState<Llama | undefined>(llama)
    /**
     * A model the artist dropped, as the example it teaches with.
     *
     * One at a time, and it goes *last* — nearest the prompt, the position the model imitates
     * hardest. An artist who drops a model has said which teacher they want more clearly than any
     * picking call can.
     */
    const [reference, setReference] = useState<WorkedExample | undefined>(() => recall(store))
    const [referenceNote, setReferenceNote] = useState('')

    /**
     * Land whatever `gen/reference.ts` came back with.
     *
     * `undefined` is a cancelled picker or an empty drop: nothing happened, so nothing is said. A
     * *failed* outcome keeps the teacher that was already there and only replaces the note — a bad
     * drop is not a reason to forget the good model the artist chose ten minutes ago.
     */
    const landed = useCallback((outcome: Outcome | undefined) => {
        if (!outcome) return
        setReferenceNote(outcome.note)
        if (outcome.ok) setReference(outcome.example)
    }, [])

    /*
     * The one AbortController, held across renders: Cancel has to reach a fetch that a *previous*
     * render started, and the run below has to be able to check it without being re-created.
     */
    const running = useRef<AbortController | undefined>(undefined)

    /*
     * Load the bank, then build the client from it, then ask whether the server is there.
     *
     * In that order because the picking call's prompt *is* the manifest — `browserLlama` cannot be
     * constructed before the bank has loaded. A supplied `llama` skips the middle step, which is
     * how the tests drive this without a bank.
     */
    useEffect(() => {
        let live = true
        // Read through a call, never as a field: it flips during an `await`, and a plain read
        // narrows to `true` for the rest of the function under the type-aware lint rules.
        const gone = (): boolean => !live
        void (async () => {
            const loaded = await library()
            if (gone()) return
            setLib(loaded)
            const built = llama ?? browserLlama(loaded.manifest)
            setClient(built)
            const found = await built.probe()
            if (gone()) return
            setServer(found)
            setStatus(
                found === undefined ?
                    'No local model. Start llama-server on :8080 and reopen this.'
                :   `Ready — ${found}`
            )
        })()
        return () => {
            live = false
            // Leaving mid-batch must stop the batch. Without this the loop keeps asking a 27B
            // model for models nothing will ever show.
            running.current?.abort()
        }
    }, [library, llama])

    const dropReference = useCallback(
        (file: File | undefined) => {
            void takeFile(store, file, prompt).then(landed)
        },
        [store, prompt, landed]
    )

    /**
     * Choosing a model, through the same port Open, Save and the palette loader use.
     *
     * Its own `Files` by default rather than the app's, and deliberately: this instance must not
     * remember anything about what Save writes back to. A reference model is not the document.
     */
    const pickFile = useCallback(() => {
        void choose(store, files, prompt).then(landed)
    }, [store, files, prompt, landed])

    const clearReference = useCallback(() => {
        landed(forget(store))
    }, [store, landed])

    /**
     * Start a batch and pipe its snapshots into the one piece of state that holds it.
     *
     * Everything that used to be here — the stage order, the abort checks, the wording of the three
     * status lines — is `gen/batch.ts`. What is left is React.
     */
    const run = useCallback(async (): Promise<void> => {
        if (!client) return
        const controller = new AbortController()
        running.current = controller
        setRankBy(undefined)
        await runBatch(
            {llama: client, scorer, veto},
            {
                prompt,
                count,
                naming,
                seed: randomSeed(),
                teach: ids => lib?.teach(ids) ?? [],
                ...(reference ? {reference} : {})
            },
            setBatch,
            controller.signal
        )
    }, [client, lib, reference, scorer, veto, naming, prompt, count])

    const busy = batch.stage === 'generating'
    const pending = pendingSlots(batch)

    /** The one way a batch starts, so the button and the Enter key cannot drift apart. */
    const start = (): void => {
        const started = run()
        onRunning?.(started)
        void started
    }

    const clipRanked = hasClip(batch)
    const order = ordered(batch, rankBy ?? batch.rankBy)

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

                <div
                    className='generate-reference'
                    data-testid='generate-reference'
                    onDragOver={event => {
                        event.preventDefault()
                    }}
                    onDrop={event => {
                        event.preventDefault()
                        dropReference(event.dataTransfer.files[0])
                    }}
                >
                    <Text type='supporting'>
                        {reference === undefined ?
                            'Drop a .vox or .gpix here to teach from your own model'
                        :   `Teaching from your model — ${String(reference.reply.split('\n').length)} lines`
                        }
                    </Text>
                    <div className='generate-reference-actions'>
                        <Button
                            label='Choose a model'
                            size='sm'
                            variant='secondary'
                            isDisabled={busy}
                            onClick={() => {
                                pickFile()
                            }}
                        />
                        {reference !== undefined && (
                            <Button
                                label='Clear'
                                size='sm'
                                variant='ghost'
                                isDisabled={busy}
                                onClick={clearReference}
                            />
                        )}
                    </div>
                    {referenceNote !== '' && (
                        <Text
                            type='supporting'
                            color='secondary'
                        >
                            {referenceNote}
                        </Text>
                    )}
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
                        value={batch.done}
                        max={batch.count}
                    />
                )}

                <div className='generate-status'>
                    <Text type='supporting'>
                        {/* The server message until there is a batch to report on, then the batch. */}
                        <span data-testid='generate-status'>
                            {batch.stage === 'idle' ? status : generateNote(batch)}
                        </span>
                    </Text>
                    <Text
                        type='supporting'
                        color='disabled'
                    >
                        <span data-testid='veto-status'>{namingNote(batch)}</span>
                    </Text>
                    <Text
                        type='supporting'
                        color='disabled'
                    >
                        <span data-testid='clip-status'>{clipNote(batch)}</span>
                    </Text>
                    {clipRanked && (
                        <SegmentedControl
                            label='Rank by'
                            size='sm'
                            value={rankBy ?? batch.rankBy}
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
