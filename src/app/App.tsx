import {useCallback, useEffect, useMemo, useReducer, useState} from 'react'
import {canRemove, initialObjects, objectAt, shownVolume} from '../doc/objects'
import type {Axis} from '../doc/brush'
import {voxelsFromImage} from '../doc/import'
import {toHexPalette} from '../doc/palette'
import {loadDocument, saveDocument} from '../doc/save'
import {browserFiles, projectName, PROJECT_ACCEPT, type Files} from '../doc/files'
import {newDocument} from '../doc/templates'
import {readVox} from '../vox/vox-file'
import {browserStore, clearSnapshots, putSnapshot, snapshots, type Store} from '../doc/store'
import {browserScorer, type Scorer} from '../gen/clip'
import type {Llama} from '../gen/llama'
import {defaultLibrary, type Library} from '../gen/library'
import {browserVeto, type Veto} from '../gen/veto'
import {sheetMetadata} from '../sheet/metadata'
import {selectionBounds} from '../doc/selection'
import {canRadial} from '../doc/symmetry'
import type {Raycaster} from '../render/gl'
import type {Volume} from '../render/volume'
import {Viewport} from '../viewport/Viewport'
import type {OrbitEvent, ViewportPointer} from '../viewport/orbit'
import {BrushPanel} from './BrushPanel'
import {TOOL_CURSORS} from './cursors'
import {writeMetadata, writePalette, writeSheet, writeSprite} from './download'
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
    allPresets,
    asDocument,
    initialState,
    presetMaps,
    previewVolume,
    reduce,
    TOOLS,
    type OpenedDocument
} from './state'
import {GenerateDialog} from './GenerateDialog'
import {NewProjectDialog} from './NewProjectDialog'
import {UnsavedDialog} from './UnsavedDialog'
import {handle} from './handle'

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
 * Arrow keys move the selection by one voxel along a grid axis; see the key handler for Shift.
 */
/**
 * How thick a PNG comes in — `FEATURESET.md` §34's "choose extrusion depth".
 *
 * Four, because one voxel deep is a sheet of paper that looks wrong from every angle but the one
 * it was drawn at, and the point of importing is to have something to sculpt.
 */
const DEFAULT_EXTRUSION = 4

/**
 * A blob as a `data:` URL.
 *
 * `FileReader` rather than `btoa` over the bytes, because the base64 of a megabyte of PNG through
 * `String.fromCharCode` is the argument-stack blowout `doc/save.ts` already comments on, and the
 * platform has a reader that does not have the problem.
 */
const dataUrl = async (blob: Blob): Promise<string> =>
    new Promise<string>(resolve => {
        const reader = new FileReader()
        reader.addEventListener('load', () => {
            resolve(typeof reader.result === 'string' ? reader.result : '')
        })
        reader.readAsDataURL(blob)
    })

/** The three things that replace the open document, and therefore have to ask about it first. */
type Guarded = 'new' | 'open' | 'generate'

const NUDGES: Record<string, readonly [number, number, number] | undefined> = {
    ArrowRight: [1, 0, 0],
    ArrowLeft: [-1, 0, 0],
    ArrowUp: [0, 1, 0],
    ArrowDown: [0, -1, 0]
}

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
     * Reading a file is the one thing that needs an element rather than an action: a browser will
     * only open a picker from a real click on a real `<input type=file>`. It is created, clicked
     * and dropped rather than kept in the tree, because a hidden input that lives in the layout is
     * one more thing for the bounding-box test to trip over.
     */
    /*
     * A PNG dropped on the viewport. Which of the two things `FEATURESET.md` asks for it becomes is
     * decided by the modifier: plain is §33's reference to build against, Shift is §34's import,
     * where every opaque pixel becomes a voxel. Both need the browser's own decoder, which is what
     * `createImageBitmap` and a scratch canvas are.
     */
    const dropImage = useCallback((file: File | undefined, asVoxels: boolean, onto: Axis) => {
        if (!file?.type.startsWith('image/')) return
        void (async () => {
            const blob = new Blob([await file.arrayBuffer()], {type: file.type})
            let bitmap: ImageBitmap
            try {
                bitmap = await createImageBitmap(blob)
            } catch {
                // A file the browser cannot decode is not a picture, whatever it was named.
                return
            }
            if (!asVoxels) {
                /*
                 * A `data:` URL, not `URL.createObjectURL`. An object URL is a handle into this
                 * page's memory: it is dead on the next reload and it cannot be written into a
                 * `.gpix`, so a project saved with reference art would have opened blank. The cost
                 * is the PNG's own bytes, base64'd, inside the file.
                 */
                dispatch({type: 'reference', plane: onto, url: await dataUrl(blob)})
                return
            }
            const canvas = document.createElement('canvas')
            canvas.width = bitmap.width
            canvas.height = bitmap.height
            const context = canvas.getContext('2d')
            if (!context) return
            context.drawImage(bitmap, 0, 0)
            const {data} = context.getImageData(0, 0, bitmap.width, bitmap.height)
            const {volume: built} = voxelsFromImage(
                new Uint8Array(data),
                bitmap.width,
                bitmap.height,
                DEFAULT_EXTRUSION
            )
            dispatch({type: 'import-image', volume: built, name: file.name})
        })()
    }, [])

    /*
     * The file menu — New, Open, Save, Save As.
     *
     * All four go through the `Files` port rather than touching the browser, for the same reason
     * the snapshots go through `Store`: the logic that can lose an artist's work is *which* file
     * gets written and whether the picker was cancelled, and that has to be testable without a
     * browser. See `doc/files.ts`.
     */
    const doSave = useCallback(
        async (reuse: boolean): Promise<boolean> => {
            const current = handle.state ?? state
            const suggested = projectName(current.doc.name)
            const text = JSON.stringify(saveDocument(asDocument(current), suggested))
            const written = await files.save(suggested, text, reuse)
            // A cancelled picker leaves the document exactly as it was, still dirty. It must not
            // report a save that did not happen.
            if (written === undefined) return false
            dispatch({type: 'saved', name: written, at: Date.now()})
            return true
        },
        [files, state]
    )

    /*
     * A `.gpix` is ours; a `.vox` is MagicaVoxel's and arrives as an untitled document. Anything
     * else that will not parse is refused without touching what is open — a half-loaded document
     * is the one outcome `doc/save.ts` exists to prevent.
     */
    const doOpen = useCallback(async () => {
        const picked = await files.open(PROJECT_ACCEPT)
        if (!picked) return
        if (picked.name.toLowerCase().endsWith('.vox')) {
            try {
                const built = readVox(picked.bytes)
                dispatch({
                    type: 'new',
                    volume: built,
                    objects: initialObjects(built),
                    name: picked.name
                })
            } catch {
                // Not a `.vox` whatever it was called. The open document is untouched.
            }
            return
        }
        const loaded = loadDocument(picked.text)
        if (loaded) dispatch({type: 'open', document: {...loaded, name: picked.name}})
    }, [files])

    const doNew = useCallback(
        (size: readonly [number, number, number], fresh: string) => {
            const {volume: built, objects} = newDocument(size)
            files.forget()
            dispatch({
                type: 'new',
                volume: built,
                objects,
                name: projectName(fresh)
            })
        },
        [files]
    )

    /*
     * The guard in front of New and Open — what stops an hour of work leaving without being asked
     * about. It is the *pending* action rather than a boolean, so the dialog's Discard knows what
     * the artist was trying to do and does it, instead of dismissing itself and making them click
     * the menu a second time.
     */
    const [pending, setPending] = useState<Guarded | undefined>(undefined)
    const [asking, setAsking] = useState(false)
    const [generating, setGenerating] = useState(false)

    const continueWith = useCallback(
        (what: Guarded | undefined) => {
            if (what === 'new') setAsking(true)
            else if (what === 'open') void doOpen()
            // Generation is guarded at the *dialog*, not at the pick: the dialog is modal and the
            // pick inside it is the last click of a minute-long wait, which is the worst possible
            // moment to be asked whether the work it is about to replace matters.
            else if (what === 'generate') setGenerating(true)
        },
        [doOpen]
    )

    const guarded = useCallback(
        (what: Guarded) => {
            if (state.doc.dirty) setPending(what)
            else continueWith(what)
        },
        [state.doc.dirty, continueWith]
    )

    const loadPalette = useCallback(() => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.hex,.txt,text/plain'
        input.addEventListener('change', () => {
            const file = input.files?.[0]
            if (!file) return
            void file.text().then(text => {
                dispatch({type: 'palette-load', text})
            })
        })
        input.click()
    }, [])

    /*
     * Export is one action from two places — the header button and the panel button — and both mean
     * "write the files", not "show me a preview". So it bakes through the reducer, which is what
     * golden-hashes, and writes the PNGs off the sheet the reducer produced rather than off a
     * second render that would only be probably identical.
     */
    const onExport = useCallback(() => {
        dispatch({type: 'bake'})
    }, [])

    useEffect(() => {
        if (state.sheet && state.exporting) {
            dispatch({type: 'written'})
            void writeSheet(state.sheet, presetMaps(state, state.preset))
        }
    }, [state.sheet, state.exporting, state.preset])

    // The mockup's `C`, and the two shortcuts nobody looks up. A shortcut that only exists in the
    // hint bar's caption is a caption.
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            const target = event.target
            const isTyping =
                target instanceof HTMLElement
                && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))
            if (isTyping) return
            if (event.metaKey || event.ctrlKey) {
                const key = event.key.toLowerCase()
                if (key === 'z') dispatch({type: event.shiftKey ? 'redo' : 'undo'})
                else if (key === 'c') dispatch({type: 'copy'})
                else if (key === 'v') dispatch({type: 'paste'})
                // `Ctrl+S` must be swallowed or the browser opens its own Save Page dialog over
                // the top of ours. Shift is Save As, which always asks.
                else if (key === 's') void doSave(!event.shiftKey)
                else if (key === 'o') guarded('open')
                else if (key === 'n') guarded('new')
                else return
                event.preventDefault()
                return
            }
            if (event.altKey) return
            if (event.key === 'c' || event.key === 'C') capture()
            if (event.key === 'Escape') dispatch({type: 'clear-selection'})
            // The two brackets that every editor uses for "more of this" and "less of this".
            if (event.key === 'f' || event.key === 'F') dispatch({type: 'focus'})
            // `FEATURESET.md` §6's "press a key". S for slice, and it toggles.
            if (event.key === 's' || event.key === 'S') {
                dispatch({type: 'slice', on: state.slice === undefined})
            }
            if (event.key === ']') dispatch({type: 'grow-selection'})
            if (event.key === '[') dispatch({type: 'shrink-selection'})
            if (event.key === 'Delete' || event.key === 'Backspace') {
                dispatch({type: 'transform', op: {kind: 'delete'}})
            }
            /*
             * Nudging is along the axes of the *model*, not of the screen: a voxel-safe move is by
             * whole cells of the grid, and mapping a screen direction onto a grid axis would have
             * to round somewhere. Shift swaps the horizontal pair for the vertical one, which is
             * the third axis a two-dimensional keyboard cannot otherwise reach.
             */
            const nudge = NUDGES[event.key]
            if (nudge) {
                event.preventDefault()
                const [dx, dy, dz] = nudge
                dispatch({
                    type: 'transform',
                    op: {kind: 'move', delta: event.shiftKey ? [0, 0, dx + dy] : [dx, dy, dz]}
                })
            }
        }
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('keydown', onKey)
        }
    }, [capture, state.slice, doSave, guarded])

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
                onWorkspace={workspace => {
                    dispatch({type: 'workspace', workspace})
                }}
                onExport={onExport}
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
                onUndo={() => {
                    dispatch({type: 'undo'})
                }}
                onRedo={() => {
                    dispatch({type: 'redo'})
                }}
                restores={snapshots(store)}
                onRestore={key => {
                    const text = store.get(key)
                    const back = text ? loadDocument(text) : undefined
                    // `unsaved`, because a snapshot is an edit that was autosaved and never
                    // written to disk. Restoring one and calling it saved would let the artist
                    // close the tab without a word.
                    if (back) dispatch({type: 'open', document: {...back, unsaved: true}})
                }}
                onForget={() => {
                    clearSnapshots(store)
                }}
            />

            <div className='app-body'>
                <div className='panel rail-panel'>
                    <ToolRail
                        tools={TOOLS}
                        tool={state.tool}
                        onTool={tool => {
                            dispatch({type: 'tool', tool})
                        }}
                    />
                </div>

                <div className='brush-column'>
                    <BrushPanel
                        volume={volume}
                        brush={state.brush}
                        color={state.color}
                        tool={state.tool}
                        onBrush={brush => {
                            dispatch({type: 'brush', brush})
                        }}
                        onColor={color => {
                            dispatch({type: 'color', color})
                        }}
                        onEmissive={value => {
                            dispatch({type: 'emissive', color: state.color, value})
                        }}
                        recent={state.recent}
                        isLocked={state.paletteLocked}
                        onLock={on => {
                            dispatch({type: 'palette-lock', on})
                        }}
                        onAdd={() => {
                            dispatch({type: 'palette-add'})
                        }}
                        onEyedropper={() => {
                            dispatch({type: 'tool', tool: 'pick'})
                        }}
                        onPaletteColor={css => {
                            dispatch({type: 'palette-color', color: state.color, css})
                        }}
                        onReplace={(from, to) => {
                            dispatch({type: 'replace-color', from, to})
                        }}
                        onSelectColor={index => {
                            dispatch({type: 'select-color', color: index})
                        }}
                        onLoad={loadPalette}
                        onSave={() => {
                            writePalette(toHexPalette(volume.palette))
                        }}
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
                        dropImage(event.dataTransfer.files[0], event.shiftKey, state.plane ?? 1)
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
                        grid={state.grid}
                        edges={state.edges}
                        snap={state.snap}
                        invert={state.invert}
                        voxelSize={Math.max(1, Math.round(state.cell / state.orbit.camera.zoom))}
                        symmetry={state.symmetry}
                        canRadial={canRadial(volume)}
                        plane={state.plane}
                        onGrid={on => {
                            dispatch({type: 'grid', on})
                        }}
                        onEdges={on => {
                            dispatch({type: 'edges', on})
                        }}
                        onSnap={on => {
                            dispatch({type: 'snap', on})
                        }}
                        onInvert={on => {
                            dispatch({type: 'invert', on})
                        }}
                        onSymmetry={(axis, on) => {
                            dispatch({type: 'symmetry', axis, on})
                        }}
                        onPlane={axis => {
                            dispatch({type: 'plane', axis})
                        }}
                        references={state.references}
                        onReference={(plane, op) => {
                            const found = state.references.find(entry => entry.plane === plane)
                            if (!found) return
                            if (op === 'lock') {
                                dispatch({type: 'reference-lock', plane, on: !found.locked})
                            } else if (op === 'drop') {
                                dispatch({type: 'reference-drop', plane})
                            } else {
                                dispatch({
                                    type: 'reference-opacity',
                                    plane,
                                    opacity: found.opacity + (op === 'brighter' ? 0.15 : -0.15)
                                })
                            }
                        }}
                    />
                </div>

                <ViewsStrip
                    volume={shown}
                    cameras={state.cameras}
                    selected={state.selected}
                    dragging={state.dragging}
                    onSelect={id => {
                        dispatch({type: 'select', id})
                    }}
                    onCapture={capture}
                    onDuplicate={() => {
                        dispatch({type: 'duplicate'})
                    }}
                    onDelete={id => {
                        dispatch({type: 'delete', id})
                    }}
                    onDirections={count => {
                        dispatch({type: 'directions', count})
                    }}
                    onAlign={() => {
                        dispatch({type: 'align'})
                    }}
                    onDragStart={id => {
                        dispatch({type: 'drag-camera', id})
                    }}
                    onDragOver={to => {
                        if (state.dragging !== undefined) {
                            dispatch({type: 'reorder-camera', id: state.dragging, to})
                        }
                    }}
                    onDragEnd={() => {
                        if (state.dragging !== undefined) {
                            dispatch({type: 'drag-camera', id: undefined})
                        }
                    }}
                />

                <div className='panel app-rail'>
                    <ObjectsPanel
                        objects={state.objects}
                        // The whole grid, not `shown`: a hidden object still has a voxel count,
                        // and a row that read "empty" because it was hidden would be a lie.
                        volume={volume}
                        query={state.search}
                        canRemove={canRemove(state.objects)}
                        blocking={blockingId}
                        onQuery={query => {
                            dispatch({type: 'search', query})
                        }}
                        onOp={op => {
                            dispatch({type: 'object', op})
                        }}
                    />
                    <RendersPanel
                        volume={shown}
                        camera={previewed}
                        map={state.map}
                        size={state.preview}
                        onMap={map => {
                            dispatch({type: 'map', map})
                        }}
                        onSize={size => {
                            dispatch({type: 'preview', size})
                        }}
                    />
                    <ExportPanel
                        volume={shown}
                        cameras={state.cameras}
                        cell={state.cell}
                        sheet={state.sheet}
                        preset={state.preset}
                        presets={allPresets(state)}
                        padding={state.padding}
                        bounds={state.bounds}
                        onPreset={preset => {
                            dispatch({type: 'preset', preset})
                        }}
                        onCell={cell => {
                            dispatch({type: 'cell', cell})
                        }}
                        onExport={onExport}
                        onPadding={padding => {
                            dispatch({type: 'padding', padding})
                        }}
                        onBounds={on => {
                            dispatch({type: 'bounds', on})
                        }}
                        onSprites={() => {
                            if (!state.sheet) return
                            for (const [index, entry] of state.cameras.entries()) {
                                void writeSprite(state.sheet, index, entry.name)
                            }
                        }}
                        onMetadata={() => {
                            if (!state.sheet) return
                            writeMetadata(
                                sheetMetadata(shown, state.cameras, state.sheet, state.bounds)
                            )
                        }}
                        onSavePreset={() => {
                            const chosen = globalThis.prompt('Name this preset')
                            if (chosen === null) return
                            dispatch({
                                type: 'save-preset',
                                name: chosen,
                                maps: presetMaps(state, state.preset)
                            })
                        }}
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
             *         dispatch({type: 'fps', fps})
             *     }}
             * />
             */}

            {asking && (
                <NewProjectDialog
                    onClose={() => {
                        setAsking(false)
                    }}
                    onCreate={(size, fresh) => {
                        setAsking(false)
                        doNew(size, fresh)
                    }}
                />
            )}

            {generating && (
                <GenerateDialog
                    library={library}
                    {...(llama ? {llama} : {})}
                    scorer={scorer}
                    veto={veto}
                    onClose={() => {
                        setGenerating(false)
                    }}
                    onPick={(built, made, record) => {
                        setGenerating(false)
                        files.forget()
                        dispatch({type: 'generate', volume: built, name: made, record})
                    }}
                />
            )}

            <UnsavedDialog
                isOpen={pending !== undefined}
                name={state.doc.name}
                everSaved={state.doc.savedAt !== undefined}
                onCancel={() => {
                    setPending(undefined)
                }}
                onDiscard={() => {
                    const what = pending
                    setPending(undefined)
                    continueWith(what)
                }}
                onSave={() => {
                    const what = pending
                    setPending(undefined)
                    // Only on a save that actually happened. A cancelled picker must not be a
                    // silent Discard — that is the exact click that loses the work.
                    void doSave(true).then(saved => {
                        if (saved) continueWith(what)
                    })
                }}
            />
        </div>
    )
}
