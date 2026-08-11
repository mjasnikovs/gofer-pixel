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
import type {Files} from '../doc/files'
import type {Store} from '../doc/store'
import type {WorkedExample} from '../gen/bank'
import {choose, forget, recall, takeFile, type Outcome} from '../gen/reference'
import {
    gateNote,
    generateNote,
    idleBatch,
    namingNote,
    ordered,
    pendingSlots,
    runBatch,
    type BatchState,
    type Ranked
} from '../gen/batch'
import {randomSeed, type GenerationRecord, type Llama} from '../gen/llama'
import {asking, CANVAS_SIZES, FIRST_ASK, MAX_CANDIDATES, startable, type Ask} from '../gen/ask'
import {
    experimenting,
    FLAG_NOTES,
    flagsOn,
    flip,
    readFlags,
    resetFlags,
    type Flags
} from '../gen/flags'
import {swatchesOf} from '../gen/palette'
import {clientOf, connect, CONNECTING, type Connection} from '../gen/connect'
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
 * Nothing here is a quality gate. The scores in `gen/score.ts` are exact and rank the broken
 * candidates down, and that is all they are — a sort order over one batch. The artist looks at the
 * pictures. There was a CLIP scorer behind a second order until 2026-08-11; it was removed because a
 * sort order is all it could ever be, and it could not be looped against without rewarding damage.
 */
export type {Ranked}
export {MAX_CANDIDATES}

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
    store,
    files,
    volume,
    veto,
    onClose,
    onPick,
    onRunning
}: {
    /** The worked-example bank, loaded on open — see `src/gen/library.ts`. */
    library: () => Promise<Library>
    /** Overridden by tests. Left out, it is built from the bank's manifest once that has loaded. */
    llama?: Llama
    /** Where the dropped reference is remembered across reloads. Required — see `App`. */
    store: Store
    /**
     * Where "Choose a model" reads from — see `doc/files.ts`.
     *
     * The app's own instance, and it may be, because the read passes no `remember`. It used to be a
     * second port built here precisely so a reference model could not become the file Save writes
     * back to; that rule now lives at the seam instead of in a duplicated construction.
     */
    files: Files
    /**
     * The open document, for its palette and for nothing else — see `gen/palette.ts`.
     *
     * The whole volume rather than the palette bytes, because "the project's colours" is the
     * derivation `projectPalette` makes and that one needs the voxels: a slot counts when the model
     * paints with it or when somebody chose it, and filler counts as neither.
     */
    volume: Volume
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
    /**
     * What is being asked for, as one value — see `gen/ask.ts`. It was four `useState`s and four
     * rules written inline below, two of them written twice.
     */
    const [ask, setAsk] = useState<Ask>(FIRST_ASK)
    const {prompt, count, naming, enforcePalette, canvas} = ask
    /** The batch, whole, as `gen/batch.ts` last published it. */
    const [batch, setBatch] = useState<BatchState>(() => idleBatch(FIRST_ASK.count))
    /**
     * How far this dialog has got in reaching the local model — see `gen/connect.ts`.
     *
     * One value, not four. The bank, the client built from it, whether the server answered and what
     * to say about it were four `useState`s set in sequence inside the effect below, with thirteen
     * combinations that could never happen and no way to test the offline path without a mount.
     */
    const [connection, setConnection] = useState<Connection>(CONNECTING)
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
     * Which experiments are switched on — see `gen/flags.ts`.
     *
     * Read from the store the way the dropped teacher above is, and for a stronger reason: half a
     * measurement is three seeds before a reload against three seeds after it, and a switch that
     * forgot itself in between would compare an experiment against itself without saying so.
     */
    const [flags, setFlags] = useState<Flags>(() => readFlags(store))

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
     * Reach the local model. The order the three steps go in is a rule and it lives behind the
     * seam — see `gen/connect.ts`. What is left here is dropping the answer if the dialog has gone.
     */
    useEffect(() => {
        let live = true
        // Read through a call, never as a field: it flips during an `await`, and a plain read
        // narrows to `true` for the rest of the function under the type-aware lint rules.
        const gone = (): boolean => !live
        void connect(library, llama).then(reached => {
            if (!gone()) setConnection(reached)
        })
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
        const client = clientOf(connection)
        if (!client) return
        const controller = new AbortController()
        running.current = controller
        await runBatch(
            {llama: client, veto},
            {
                prompt,
                count,
                naming,
                canvas,
                // Read at the moment the batch starts, not on every render: the palette a candidate
                // is held to is the one that was open when the artist pressed Generate.
                ...(enforcePalette ? {swatches: swatchesOf(volume)} : {}),
                seed: randomSeed(),
                // Which experiments this batch runs under — see `gen/flags.ts`. Read at the moment
                // the batch starts, the same as the palette above.
                flags,
                teach: ids => (connection.kind === 'loading' ? [] : connection.library.teach(ids)),
                ...(reference ? {reference} : {})
            },
            setBatch,
            controller.signal
        )
    }, [connection, reference, veto, naming, prompt, count, canvas, enforcePalette, flags, volume])

    const busy = batch.stage === 'generating'
    const ready = startable(connection, busy)
    const pending = pendingSlots(batch)

    /** The one way a batch starts, so the button and the Enter key cannot drift apart. */
    const start = (): void => {
        const started = run()
        onRunning?.(started)
        void started
    }

    const order = ordered(batch)

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
                        onChange={value => {
                            setAsk(held => asking(held, {prompt: value}))
                        }}
                        // Enter is what a prompt field is for. Guarded rather than unconditional:
                        // held down mid-batch it would start a second batch over the first. The
                        // guard and the button below are the same call, so they cannot drift.
                        onEnter={() => {
                            if (ready) start()
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
                        // The bound is `asking`'s, not this field's: `min` and `max` are what a
                        // mouse obeys, and a typed 40 is not a mouse.
                        onChange={value => {
                            setAsk(held => asking(held, {count: value}))
                        }}
                    />
                    <Button
                        label={busy ? 'Cancel' : 'Generate'}
                        size='sm'
                        variant={busy ? 'secondary' : 'primary'}
                        isDisabled={!busy && !ready}
                        tooltip={
                            connection.kind !== 'ready' ?
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

                {/*
                 * The two things that constrain a candidate rather than describe it. Both are
                 * rules about the document that comes out, so they sit above the pictures rather
                 * than beside the prompt.
                 */}
                <div className='generate-limits'>
                    <SegmentedControl
                        label='Canvas'
                        size='sm'
                        value={canvas === undefined ? 'off' : String(canvas)}
                        isDisabled={busy}
                        onChange={value => {
                            setAsk(held =>
                                asking(held, {canvas: value === 'off' ? undefined : Number(value)})
                            )
                        }}
                    >
                        <SegmentedControlItem
                            value='off'
                            label='Off'
                        />
                        {CANVAS_SIZES.map(size => (
                            <SegmentedControlItem
                                key={size}
                                value={String(size)}
                                label={`${String(size)}³`}
                            />
                        ))}
                    </SegmentedControl>
                    <Switch
                        label='Keep to the project palette'
                        description='Every colour snapped to the nearest one you already have.'
                        size='sm'
                        value={enforcePalette}
                        isDisabled={busy}
                        onChange={value => {
                            setAsk(held => asking(held, {enforcePalette: value}))
                        }}
                    />
                    <Switch
                        label='Ask what each result looks like'
                        description='Slower. Puts the model’s own word under each picture.'
                        size='sm'
                        value={naming}
                        isDisabled={busy}
                        onChange={value => {
                            setAsk(held => asking(held, {naming: value}))
                        }}
                    />
                </div>

                {/*
                 * The experiments, folded away — `gen/flags.ts` and `docs/GEN_IDEAS.md`.
                 *
                 * Collapsed by default and last in the column, because none of them is measured and
                 * the two switches above are. A `<details>` rather than a panel: eight switches is
                 * more vertical space than the prompt and the pictures together, and a dialog whose
                 * unmeasured half is the tallest thing in it is telling the artist the wrong story.
                 */}
                <details
                    className='generate-experiments'
                    data-testid='generate-experiments'
                >
                    <summary>
                        Experiments
                        {experimenting(flags) ? ` — ${String(flagsOn(flags).length)} on` : ''}
                    </summary>
                    <div className='generate-experiments-body'>
                        <Text
                            type='supporting'
                            color='secondary'
                        >
                            Unmeasured ideas from docs/GEN_IDEAS.md. Off is the ground every finding
                            on the record was measured on, so turn one on at a time and render the
                            same seeds before and after.
                        </Text>
                        {FLAG_NOTES.map(note => (
                            <Switch
                                key={note.key}
                                label={note.title}
                                description={`${note.note} — ${note.where}`}
                                size='sm'
                                value={flags[note.key]}
                                isDisabled={busy}
                                onChange={value => {
                                    // Written outside the updater on purpose: `flip` puts the value
                                    // in `localStorage`, and React may call an updater twice.
                                    setFlags(flip(store, flags, note.key, value))
                                }}
                            />
                        ))}
                        <Button
                            label='All off'
                            size='sm'
                            variant='ghost'
                            isDisabled={busy || !experimenting(flags)}
                            tooltip='Back to the generator every finding on the record was measured with'
                            onClick={() => {
                                setFlags(resetFlags(store))
                            }}
                        />
                    </div>
                </details>

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
                            {batch.stage === 'idle' ? connection.note : generateNote(batch)}
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
                        <span data-testid='gate-status'>{gateNote(batch)}</span>
                    </Text>
                    {/*
                     * What is switched on, next to the pictures rather than only inside the folded
                     * block that switched it on. A batch judged by eye without knowing which
                     * generator made it is not a measurement, and the block above is closed by the
                     * time the pictures land.
                     */}
                    {experimenting(flags) && (
                        <Text
                            type='supporting'
                            color='secondary'
                        >
                            <span data-testid='flags-status'>
                                {`Experiments: ${flagsOn(flags).join(', ')}`}
                            </span>
                        </Text>
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
