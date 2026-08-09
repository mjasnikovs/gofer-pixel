import {useCallback, useEffect, useMemo, useReducer, useState} from 'react'
import {objectAt, shownVolume} from '../doc/objects'
import {saveDocument} from '../doc/save'
import {browserFiles, type Files} from '../doc/files'
import {browserStore, clearSnapshots, putSnapshot, snapshots, type Store} from '../doc/store'
import {browserScorer, type Scorer} from '../gen/clip'
import type {Llama} from '../gen/llama'
import {defaultLibrary, type Library} from '../gen/library'
import {browserVeto, type Veto} from '../gen/veto'
import {selectionBounds} from '../doc/selection'
import type {Raycaster} from '../render/gl'
import type {Volume} from '../render/volume'
import {Viewport} from '../viewport/Viewport'
import type {OrbitEvent, ViewportPointer} from '../viewport/orbit'
import {BrushPanel} from './BrushPanel'
import {TOOL_CURSORS} from './cursors'
import {writeExport} from './export'
import {ExportPanel} from './ExportPanel'
import {Header} from './Header'
import {ObjectsPanel} from './ObjectsPanel'
import {ReferenceLayer} from './ReferenceLayer'
import {RendersPanel} from './RendersPanel'
import {SelectionBar} from './SelectionBar'
// import {Timeline} from './Timeline' — see the commented bar at the end of the layout
import {GridPanel, ToolRail} from './ToolRail'
import {AxisGizmo, BrushGhost, GroundGrid, HintBar, SelectionBox, ViewCube} from './ViewportOverlay'
import {ViewsStrip} from './ViewsStrip'
import {
    asDocument,
    currentSheet,
    initialState,
    previewVolume,
    reduce,
    TOOLS,
    type OpenedDocument
} from './state'
import {GenerateDialog} from './GenerateDialog'
import {NewProjectDialog} from './NewProjectDialog'
import {UnsavedDialog} from './UnsavedDialog'
import {handle} from './handle'
import {keyAction, pressOf} from './keys'
import {
    asking as askingAbout,
    closed,
    dropPicture,
    guard,
    loadPalette as palettePicked,
    newProject,
    NO_DIALOG,
    openProject,
    proceed,
    restoreSnapshot,
    saveProject,
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
 * - **Memoised derivations.** `shown`, `drawn` and `sheet` are computed once here and passed down,
 *   because recomputing `shownVolume` inside a panel of switches would rebuild a whole grid on every
 *   render of it.
 * - **Anything that goes through a port.** Open, Save, the palette loader and the snapshots can be
 *   cancelled and belong to the app, so they stay callbacks — a panel must not get to decide which
 *   disk a read goes through. All of them are `session.ts`.
 *
 * The keyboard is `keys.ts`; what a key means is a table, and what is here is the listener.
 */
export const App = ({
    volume: source,
    name,
    opened,
    store = browserStore(),
    files = browserFiles(),
    library = defaultLibrary,
    llama,
    scorer = browserScorer(),
    veto = browserVeto()
}: {
    volume: Volume
    name: string
    opened?: OpenedDocument | undefined
    store?: Store
    files?: Files
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
     * What is drawn is the grid with hidden objects taken out of it, and everything that renders
     * uses it: the viewport, every thumbnail and the exported sheet. The panels that are about the
     * *document* rather than about the picture — the palette, the object list — keep the whole one.
     */
    const shown = useMemo(() => shownVolume(volume, state.objects), [volume, state.objects])

    // What the viewport draws — see `previewVolume`. Erase shows its hole and Fill its new paint
    // before the press, because neither change is visible from the outside of a block.
    const drawn = useMemo(() => previewVolume(state, shown), [state, shown])

    /*
     * The sheet the last export baked, if it is still the sheet for this document.
     *
     * Derived, never stored: nothing in the reducer has to remember to throw it away, because
     * `currentSheet` compares what it was baked from against what is there now. See `sheet/baked.ts`.
     */
    const sheet = useMemo(() => currentSheet(state), [state])

    const onOrbit = useCallback((event: OrbitEvent, height: number) => {
        dispatch({type: 'orbit', event, height})
    }, [])

    const onPointer = useCallback((event: ViewportPointer) => {
        dispatch({type: 'pointer', event})
    }, [])

    const onLeave = useCallback(() => {
        dispatch({type: 'unaim'})
    }, [])

    const onReady = useCallback((raycaster: Raycaster) => {
        handle.raycaster = raycaster
    }, [])

    const onFrame = useCallback(() => {
        handle.markDrawn()
    }, [])

    const capture = useCallback(() => {
        dispatch({type: 'capture'})
    }, [])

    /*
     * The file menu, the palette loader and the viewport's drop — every path that reads or writes
     * the artist's disk. All of them are `session.ts`, which needs no React and no window: each one
     * is ports in, an `AppAction` or `undefined` out, and `undefined` always means the picker was
     * cancelled. What is left here is the awaiting and the dispatching.
     */
    const [dialog, setDialog] = useState<Dialog>(NO_DIALOG)

    /** Run whichever half of a transition is not just "draw this dialog". */
    const take = useCallback(
        (step: Step) => {
            setDialog(step.dialog)
            if (step.opening) {
                void openProject(files).then(action => {
                    if (action) dispatch(action)
                })
            }
        },
        [files]
    )

    /*
     * Save reads `handle.state` rather than the `state` this render closed over. Ctrl-S and the
     * unsaved dialog can both fire from a callback older than the last edit, and saving a document
     * one stroke behind is a data loss that looks like a success.
     */
    const doSave = useCallback(
        async (reuse: boolean): Promise<boolean> => {
            const action = await saveProject(files, handle.state ?? state, reuse)
            if (!action) return false
            dispatch(action)
            return true
        },
        [files, state]
    )

    const guarded = useCallback(
        (what: Guarded) => {
            take(guard(what, state.doc.dirty))
        },
        [state.doc.dirty, take]
    )

    const loadPalette = useCallback(() => {
        void palettePicked(files).then(action => {
            if (action) dispatch(action)
        })
    }, [files])

    /*
     * Export is one action from two places — the header button and the panel button — and both mean
     * "write the files", not "show me a preview". Both dispatch `bake`, which is what golden-hashes,
     * and this writes the PNGs off the sheet the reducer produced rather than off a second render
     * that would only be probably identical.
     */
    useEffect(() => {
        if (state.exporting) {
            dispatch({type: 'written'})
            void writeExport(state)
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

    // Publishing to the browser-test seam is exactly what an effect is for: pushing React's latest
    // state out to something that is not React.
    useEffect(() => {
        handle.state = state
        handle.dispatch = dispatch
    }, [state])

    /** What the render panel inspects. Survives orbiting; see `previewed` in `state.ts`. */
    const previewed = useMemo(
        () => state.cameras.find(({id}) => id === state.previewed),
        [state.cameras, state.previewed]
    )

    const bounds = useMemo(
        () => selectionBounds(volume, state.selection),
        [volume, state.selection]
    )

    /*
     * The locked object standing between the cursor and the edit — the one thing the artist can act
     * on when a press is about to be silent. It goes to the hint bar as a name and to the object
     * list as a row to light up, so "why did nothing happen" and "here is the switch" are the same
     * answer seen twice.
     */
    const blockingId =
        state.hover?.blocked?.reason === 'locked' ? state.hover.blocked.object : undefined
    const blocking =
        blockingId === undefined ? undefined : objectAt(state.objects, blockingId)?.name

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
                        onLoad={loadPalette}
                    />
                </div>

                <div
                    className='stage'
                    onDragOver={event => {
                        event.preventDefault()
                    }}
                    onDrop={event => {
                        event.preventDefault()
                        // Onto the locked drawing plane if there is one, and Front otherwise —
                        // the artist who locked a plane is working on it.
                        void dropPicture(
                            event.dataTransfer.files[0],
                            event.shiftKey,
                            state.plane ?? 1
                        ).then(action => {
                            if (action) dispatch(action)
                        })
                    }}
                >
                    <ReferenceLayer
                        volume={shown}
                        camera={state.orbit.camera}
                        references={state.references}
                    />
                    <Viewport
                        volume={drawn}
                        camera={state.orbit.camera}
                        map={state.map}
                        edges={state.edges}
                        cursor={TOOL_CURSORS[state.tool]}
                        isMovingCamera={state.orbit.gesture !== undefined}
                        onOrbit={onOrbit}
                        onPointer={onPointer}
                        onLeave={onLeave}
                        onReady={onReady}
                        onFrame={onFrame}
                    />
                    {state.grid ?
                        <GroundGrid
                            volume={volume}
                            camera={state.orbit.camera}
                        />
                    :   undefined}
                    <BrushGhost
                        volume={shown}
                        camera={state.orbit.camera}
                        hover={state.hover}
                    />
                    <SelectionBox
                        volume={shown}
                        camera={state.orbit.camera}
                        bounds={bounds}
                        band={state.band}
                        losing={state.losing}
                    />
                    <AxisGizmo
                        volume={shown}
                        camera={state.orbit.camera}
                    />
                    <ViewCube
                        volume={shown}
                        camera={state.orbit.camera}
                    />
                    <SelectionBar
                        count={state.selection.size}
                        onTransform={op => {
                            dispatch({type: 'transform', op})
                        }}
                        onClear={() => {
                            dispatch({type: 'clear-selection'})
                        }}
                    />
                    <HintBar
                        tool={`${(state.tool[0] ?? '').toUpperCase()}${state.tool.slice(1)}`}
                        hover={state.hover}
                        blocking={blocking}
                        height={volume.sz}
                        losing={state.losing}
                        onCapture={capture}
                    />
                </div>

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
                    take(proceed(askingAbout(dialog)))
                }}
                onSave={() => {
                    const what = askingAbout(dialog)
                    take(closed())
                    // Only on a save that actually happened. A cancelled picker must not be a
                    // silent Discard — that is the exact click that loses the work.
                    void doSave(true).then(saved => {
                        if (saved) take(proceed(what))
                    })
                }}
            />
        </div>
    )
}
