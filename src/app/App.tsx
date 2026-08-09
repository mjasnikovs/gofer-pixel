import {useCallback, useEffect, useMemo, useReducer, useRef, useState} from 'react'
import {shownVolume} from '../doc/objects'
import {saveDocument} from '../doc/save'
import type {Files} from '../doc/files'
import {clearSnapshots, putSnapshot, snapshots, type Store} from '../doc/store'
import {browserScorer, type Scorer} from '../gen/clip'
import type {Llama} from '../gen/llama'
import {defaultLibrary, type Library} from '../gen/library'
import {browserVeto, type Veto} from '../gen/veto'
import type {Volume} from '../render/volume'
import {BrushPanel} from './BrushPanel'
import {writeExport} from './export'
import {ExportPanel} from './ExportPanel'
import {Header} from './Header'
import {ObjectsPanel} from './ObjectsPanel'
import {RendersPanel} from './RendersPanel'
import {Stage} from './Stage'
// import {Timeline} from './Timeline' — see the commented bar at the end of the layout
import {GridPanel, ToolRail} from './ToolRail'
import {ViewsStrip} from './ViewsStrip'
import {
    asDocument,
    currentSheet,
    initialState,
    reduce,
    slicedFor,
    TOOLS,
    type AppAction,
    type OpenedDocument
} from './state'
import {GenerateDialog} from './GenerateDialog'
import {NewProjectDialog} from './NewProjectDialog'
import {UnsavedDialog} from './UnsavedDialog'
import {publish} from './handle'
import {keyAction, pressOf} from './keys'
import {
    closed,
    discarded,
    dropPicture,
    guard,
    loadPalette as palettePicked,
    newProject,
    NO_DIALOG,
    openProject,
    restoreSnapshot,
    saveProject,
    savingFirst,
    type Dialog,
    type Guarded,
    type Step
} from './session'

/**
 * Frame first, as `astryx docs layout` asks. The regions and their budgets are `docs/editor.png`'s
 * own: a 96 px tool rail, a 216 px brush-and-palette column, the viewport taking whatever is left, a
 * 384 px camera-and-export rail down the side, a views strip under the viewport and an animation bar
 * across the foot. Every one is budgeted in px because a tool's panels are sized by what they hold,
 * not by a fraction of the window. The exact column arithmetic is in `app.css`.
 *
 * There is no state here. Everything is `reduce` in `state.ts`, which is why the interesting tests
 * are 1 ms functions rather than a browser driving a UI.
 *
 * **A panel takes `state` and `dispatch`, not one prop per control.** It used to take one prop per
 * value and one callback per control — `ExportPanel` alone took fifteen — and three hundred of this
 * file's lines were the one-line arrows that filled them in. That is a hand-maintained restatement
 * of `AppState` and `AppAction` in four places, and adding one control meant editing four files.
 *
 * The exceptions are the two kinds of prop that genuinely are not state:
 *
 * - **Memoised derivations.** `shown` and `sheet` are computed once here and passed down, because
 *   recomputing `shownVolume` inside a panel of switches would rebuild a whole grid on every render
 *   of it.
 * - **Anything that goes through a port.** Open, Save, the palette loader and the snapshots can be
 *   cancelled and belong to the app, so they stay callbacks — a panel must not get to decide which
 *   disk a read goes through. All of them are `session.ts`. The two panels that *write* take the
 *   `Files` itself instead, because an export has no cancel and nothing to come back and dispatch:
 *   the panel does not choose the disk, it is handed one. What it must never do is reach for a
 *   global, which is exactly what every export did before `Files.write` existed.
 *
 * That rule reaches the middle of the window too. The viewport and the eight things drawn over it
 * are `Stage.tsx`, which takes the same three props a panel does. They used to be nine children
 * threaded by hand from here, plus two derivations — the box round the selection and the name of the
 * locked object — that nothing outside them ever read.
 *
 * The keyboard is `keys.ts`; what a key means is a table, and what is here is the listener.
 */
/**
 * The two stateless ports, built once at module load rather than per render.
 *
 * They close over an endpoint string and nothing else, so a second instance is a waste rather than
 * a bug — which is exactly why they may have a default and `store` and `files` may not.
 */
const DEFAULT_SCORER = browserScorer()
const DEFAULT_VETO = browserVeto()

export const App = ({
    volume: source,
    name,
    opened,
    store,
    files,
    library = defaultLibrary,
    llama,
    scorer = DEFAULT_SCORER,
    veto = DEFAULT_VETO
}: {
    volume: Volume
    name: string
    opened?: OpenedDocument | undefined
    /**
     * Where the autosave goes — see `doc/store.ts`.
     *
     * Required, and that is the whole point. It used to default to `browserStore()`, and a default
     * parameter is evaluated on *every call to this function*, which is every render: the effect
     * below has `store` in its dependencies, so a new instance each render meant a full RLE and
     * base64 of the document on every pointer move of a stroke rather than once per committed edit.
     */
    store: Store
    /**
     * The artist's disk — see `doc/files.ts`.
     *
     * Required for a second and worse reason than `store`: a `Files` **is stateful**. It remembers
     * the handle Save writes back to, and a default parameter threw that memory away on the very
     * re-render that `dispatch({type: 'saved'})` caused — so `overwrites` promised a Save that
     * overwrote and every Ctrl-S opened the picker again. A `Files` must outlive a render, and the
     * only way to say so is to refuse to make one here.
     */
    files: Files
    /** The local model — see `src/gen/llama.ts`. A port, so a test needs no GPU. */
    llama?: Llama
    /**
     * The worked-example bank — see `src/gen/library.ts`. A thunk, not a value, because loading it
     * decomposes every model in `src/assets/examples/` and nothing should pay for that until the
     * generate dialog is actually opened.
     */
    library?: () => Promise<Library>
    /** The local CLIP service — see `src/gen/clip.ts`. Optional at runtime as well as in a test. */
    scorer?: Scorer
    /** The naming judge — see `src/gen/veto.ts`. The same server as `llama`. */
    veto?: Veto
}) => {
    const [state, dispatch] = useReducer(reduce, source, start => initialState(start, name, opened))
    // Everything below reads the *document's* volume, not the one the file was opened with. They
    // are the same object until the first stroke, and after it the difference is the whole point.
    const {volume} = state

    /*
     * The grid with hidden objects taken out of it. Everything that renders uses it: the viewport,
     * every thumbnail and the exported sheet. The panels that are about the *document* rather than
     * about the picture — the palette, the object list — keep the whole one.
     *
     * Two memos rather than one call to `visible(state)`, because they go stale against different
     * things: hiding an object rebuilds a grid and must not re-run while the view turns, and the
     * slice depends on which way the camera faces and must.
     */
    const hidden = useMemo(() => shownVolume(volume, state.objects), [volume, state.objects])

    /*
     * And in slice mode, the layers in front of the current one gone as well — `doc/gesture.ts`.
     *
     * This used to be the plain `shownVolume` above, which meant the app drew the model whole while
     * `hoverAt` picked against the sliced one and `bake` shipped the sliced one. Three derivations
     * of "the grid as the artist sees it", two of them missing a term. There is one now, and it
     * lives next to the rule it belongs to.
     */
    const shown = useMemo(() => slicedFor(state, hidden), [state, hidden])

    /*
     * The sheet the last export baked, if it is still the sheet for this document.
     *
     * Derived, never stored: nothing in the reducer has to remember to throw it away, because
     * `currentSheet` compares what it was baked from against what is there now. See `sheet/baked.ts`.
     */
    const sheet = useMemo(() => currentSheet(state), [state])

    /*
     * The file menu, the palette loader and the viewport's drop — every path that reads or writes
     * the artist's disk. All of them are `session.ts`, which needs no React and no window: each one
     * is ports in, an `AppAction` or `undefined` out, and `undefined` always means the picker was
     * cancelled. What is left here is the awaiting and the dispatching.
     */
    const [dialog, setDialog] = useState<Dialog>(NO_DIALOG)

    /**
     * Dispatch whatever a trip to the disk came back with, and nothing when it came back with
     * `undefined` — which `session.ts` guarantees means the picker was cancelled. One wrapper
     * rather than the same three lines written out beside every command.
     */
    const apply = useCallback((work: Promise<AppAction | undefined>) => {
        void work.then(action => {
            if (action) dispatch(action)
        })
    }, [])

    /** Run whichever half of a transition is not just "draw this dialog". */
    const take = useCallback(
        (step: Step) => {
            setDialog(step.dialog)
            if (step.opening) apply(openProject(files))
        },
        [apply, files]
    )

    /*
     * The latest state, readable from a callback older than it.
     *
     * Ctrl-S and the unsaved dialog can both fire from a closure built several edits ago, and
     * saving a document one stroke behind is a data loss that looks like a success. This used to
     * read `handle.state` — the seam the *browser tests* drive the app through, whose own header
     * says the app only ever writes to it. A real correctness requirement met by a testing
     * singleton is a requirement two mounted apps would silently share, and the thing they would
     * share is which document gets written to disk.
     */
    const latest = useRef(state)

    const doSave = useCallback(
        async (reuse: boolean): Promise<boolean> => {
            const action = await saveProject(files, latest.current, reuse)
            if (!action) return false
            dispatch(action)
            return true
        },
        [files]
    )

    const guarded = useCallback(
        (what: Guarded) => {
            take(guard(what, state.doc.dirty))
        },
        [state.doc.dirty, take]
    )

    const loadPalette = useCallback(() => {
        apply(palettePicked(files))
    }, [apply, files])

    /*
     * Export is one action from two places — the header button and the panel button — and both mean
     * "write the files", not "show me a preview". Both dispatch `bake`, which is what golden-hashes,
     * and this writes the PNGs off the sheet the reducer produced rather than off a second render
     * that would only be probably identical.
     */
    useEffect(() => {
        if (state.exporting) {
            dispatch({type: 'written'})
            void writeExport(files, state)
        }
        // `exporting` alone: it is set by the one action that also bakes, so a sheet is always there
        // when it is true, and re-running on every field the writer reads would write twice.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.exporting])

    /*
     * The shortcuts. Which key means what is `keys.ts` — one table, no DOM — and what is left here
     * is the listener and the four bindings that go to the disk instead of to the reducer.
     */
    const slicing = state.slice !== undefined
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            const bound = keyAction(pressOf(event), slicing)
            if (!bound) return
            if (bound.swallow) event.preventDefault()
            if (bound.kind === 'action') {
                dispatch(bound.action)
                return
            }
            if (bound.command === 'save') void doSave(true)
            else if (bound.command === 'save-as') void doSave(false)
            else guarded(bound.command)
        }
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('keydown', onKey)
        }
    }, [slicing, doSave, guarded])

    /*
     * Closing the tab with unsaved work asks first.
     *
     * An event, not a duration, so it is inside the testing law. The browser shows its own wording
     * and ignores ours — `preventDefault` is the whole of the API — which is why there is nothing
     * here to phrase.
     */
    useEffect(() => {
        if (!state.doc.dirty) return undefined
        const onClosing = (event: BeforeUnloadEvent): void => {
            event.preventDefault()
        }
        globalThis.addEventListener('beforeunload', onClosing)
        return () => {
            globalThis.removeEventListener('beforeunload', onClosing)
        }
    }, [state.doc.dirty])

    /*
     * Autosave — `FEATURESET.md` §32.
     *
     * On every committed edit rather than on a timer. The history growing *is* the event "the
     * artist changed something and meant it", and hanging a save off a clock would put a duration
     * in the one place this project has spent the most effort keeping them out of. It also means a
     * stroke in progress is never saved half-drawn.
     */
    const commits = state.history.past.length
    useEffect(() => {
        if (commits === 0) return
        putSnapshot(store, saveDocument(asDocument(state), state.doc.name))
        // Only `commits` and the store: this must fire once per committed edit, not once per
        // camera turn, and the volume it reads is whatever the latest one is when it does.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [commits, store])

    /*
     * Pushing React's latest state out to the two things that are not React: the ref the file
     * callbacks read, and the seam the browser suite drives the app through. Both are writes, and
     * `handle` is now only ever written — see `handle.ts`.
     */
    useEffect(() => {
        latest.current = state
        publish({state, dispatch})
    }, [state])

    /** What the render panel inspects. Survives orbiting; see `previewed` in `state.ts`. */
    const previewed = useMemo(
        () => state.cameras.find(({id}) => id === state.previewed),
        [state.cameras, state.previewed]
    )

    return (
        <div className='app'>
            <Header
                state={state}
                dispatch={dispatch}
                overwrites={files.overwrites}
                onNew={() => {
                    guarded('new')
                }}
                onOpen={() => {
                    guarded('open')
                }}
                onSave={() => {
                    void doSave(true)
                }}
                onSaveAs={() => {
                    void doSave(false)
                }}
                onGenerate={() => {
                    guarded('generate')
                }}
                restores={snapshots(store)}
                onRestore={key => {
                    const action = restoreSnapshot(store, key)
                    if (action) dispatch(action)
                }}
                onForget={() => {
                    clearSnapshots(store)
                }}
            />

            <div className='app-body'>
                <div className='panel rail-panel'>
                    <ToolRail
                        tools={TOOLS}
                        state={state}
                        dispatch={dispatch}
                    />
                </div>

                <div className='brush-column'>
                    <BrushPanel
                        state={state}
                        dispatch={dispatch}
                        files={files}
                        onLoad={loadPalette}
                    />
                </div>

                <Stage
                    state={state}
                    dispatch={dispatch}
                    volume={shown}
                    onPicture={(file, asVoxels) => {
                        // Onto the locked drawing plane if there is one, and Front otherwise —
                        // the artist who locked a plane is working on it.
                        apply(dropPicture(file, asVoxels, state.plane ?? 1))
                    }}
                />

                <div className='snap-column'>
                    <GridPanel
                        state={state}
                        dispatch={dispatch}
                    />
                </div>

                <ViewsStrip
                    state={state}
                    dispatch={dispatch}
                    volume={shown}
                />

                <div className='panel app-rail'>
                    <ObjectsPanel
                        state={state}
                        dispatch={dispatch}
                    />
                    <RendersPanel
                        state={state}
                        dispatch={dispatch}
                        volume={shown}
                        camera={previewed}
                    />
                    <ExportPanel
                        state={state}
                        dispatch={dispatch}
                        files={files}
                        volume={shown}
                        sheet={sheet}
                    />
                </div>
            </div>

            {/*
             * The animation bar is commented out, not deleted. One frame is all the document holds,
             * so the only live control in it was the FPS selector and nothing read the value.
             * `Timeline.tsx`, `state.fps`, `state.frame` and the `fps` action all still stand.
             * Uncomment when FEATURESET §24 comes up.
             *
             * <Timeline
             *     volume={shown}
             *     camera={previewed ?? state.cameras[0]}
             *     frame={state.frame}
             *     fps={state.fps}
             *     onFps={fps => {
             *         dispatch({type: 'chrome', chrome: {fps}})
             *     }}
             * />
             */}

            {dialog.kind === 'new' && (
                <NewProjectDialog
                    onClose={() => {
                        take(closed())
                    }}
                    onCreate={(size, fresh) => {
                        take(closed())
                        dispatch(newProject(files, size, fresh))
                    }}
                />
            )}

            {dialog.kind === 'generate' && (
                <GenerateDialog
                    library={library}
                    {...(llama ? {llama} : {})}
                    store={store}
                    files={files}
                    scorer={scorer}
                    veto={veto}
                    onClose={() => {
                        take(closed())
                    }}
                    onPick={(built, made, record) => {
                        take(closed())
                        files.forget()
                        dispatch({type: 'generate', volume: built, name: made, record})
                    }}
                />
            )}

            <UnsavedDialog
                isOpen={dialog.kind === 'unsaved'}
                name={state.doc.name}
                everSaved={state.doc.savedAt !== undefined}
                onCancel={() => {
                    take(closed())
                }}
                onDiscard={() => {
                    take(discarded(dialog))
                }}
                onSave={() => {
                    // Two steps with a picker between them, and the rule about what a cancelled
                    // picker means is `savingFirst` rather than anything written here.
                    const {now, then} = savingFirst(dialog)
                    take(now)
                    void doSave(true).then(saved => {
                        take(then(saved))
                    })
                }}
            />
        </div>
    )
}
