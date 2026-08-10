import {MAX_BRUSH, SHAPES, type Axis, type Brush, type Shape} from '../doc/brush'
import {
    alignCamera,
    directions,
    eightDirections,
    focusOn,
    ISOMETRIC_PITCH,
    ringCount,
    RING_PITCHES,
    type RingPitch
} from '../doc/cameras'
import {
    captureView,
    duplicateView,
    removeView,
    reorderView,
    resetViews,
    showView,
    startViews,
    viewNamed,
    type Views
} from '../doc/views'
import {beginEdit, writeCells, writeOwned, type Draft} from '../doc/edits'
import type {GenerationRecord} from '../gen/llama'
import {drop, fade, lock, place, type Reference} from '../doc/reference'
import {DEFAULT_OUTPUT, type Document, type SavedOutput} from '../doc/save'
import {
    addObject,
    duplicateOffset,
    initialObjects,
    lockedIds,
    moveObject,
    objectAt,
    objectBounds,
    objectCells,
    removeObject,
    renameObject,
    setHidden,
    setLocked,
    soloObject,
    type Objects
} from '../doc/objects'
import {commit, EMPTY_HISTORY, redo, undo, type Step as HistoryStep} from '../doc/history'
import {
    firstColor,
    freeSlot,
    freshenPalette,
    fromHexPalette,
    remember,
    withColor
} from '../doc/palette'
import {
    cellOf,
    EMPTY_SELECTION,
    grow,
    selectColor,
    selectionBounds,
    shrink,
    type Cell,
    type Selection
} from '../doc/selection'
import {clampLayer, layerCount} from '../doc/slice'
import {canRadial, NO_SYMMETRY, type Symmetry} from '../doc/symmetry'
import {
    arrayCells,
    deleteCells,
    duplicateCells,
    fitsAfter,
    flipCells,
    mirrorCells,
    moveCells,
    paintCells,
    pasteCells,
    remapColor,
    rotateCells
} from '../doc/transform'
import {createCamera, type Camera} from '../render/camera'
import {MODE_COLOR} from '../render/raycast.glsl'
import {voxelAt, type Volume} from '../render/volume'
import {dropPreset, presetNamed, savePreset} from '../sheet/presets'
import type {SheetMap} from '../sheet/sheet'
import {
    beginSelect,
    beginStroke,
    changedAim,
    continueDrag,
    continueStroke,
    endBand,
    endDrag,
    endStroke,
    GHOST_CELLS,
    hoverAt,
    openDraft,
    previewVolume,
    SELECTS,
    slicedFor,
    TOOLS,
    WRITES,
    type Gesture,
    USES_BRUSH,
    type Band,
    type Blocked,
    type Drag,
    type Hover,
    type HoverKind,
    type Stroke,
    type Tool
} from '../doc/gesture'
import {apply as applyOrbit, type OrbitEvent, type ViewportPointer} from '../viewport/orbit'

/**
 * The whole application as a value, and one pure function that moves it.
 *
 * Every wiring bug, stale render and wrong-action bug dies in a `bun test` against this, in under a
 * millisecond each, with no DOM. React below is a projection of it and holds no logic of its own.
 *
 * Two things it deliberately does *not* hold:
 *
 * - **What the pointer does to voxels** — `doc/gesture.ts`. Those functions take `Gesture`, which
 *   `AppState` extends, so they read eighteen fields rather than fifty and cannot touch a camera
 *   list or an export preset. The rule they keep is that the outline cannot disagree with the edit.
 * - **What an export writes and what it looks like** — `app/ExportDialog.tsx` and the modules
 *   under it. The sheet is baked inside the dialog, from what is on screen, and lives exactly as
 *   long as the dialog does. It used to be held here behind a key of seven identities, because a
 *   bake outlived the click that made it and twenty-four cases had to remember not to stale it.
 */

/**
 * The brush and the pointer gestures live in `doc/` — which cells a click writes is document
 * arithmetic, and the panels here are a projection of it. Re-exported so the panels and the tests
 * keep importing their types from the state they are drawn from.
 */
export {MAX_BRUSH, SHAPES}
export type {Brush, Shape}
export {GHOST_CELLS, previewVolume, slicedFor, TOOLS, USES_BRUSH}
export type {Band, Blocked, Drag, Hover, HoverKind, Stroke, Tool}

/**
 * What the floating bar over a selection can do — `FEATURESET.md` §9, plus delete and recolour.
 *
 * One action type rather than eight, because every one of them is the same three steps: open a
 * draft, transform the selection into it, record the diff. Eight cases in the reducer would be
 * eight chances for one of them to forget the history.
 */
export type TransformOp =
    | {kind: 'move'; delta: Cell}
    | {kind: 'rotate'; axis: Axis}
    | {kind: 'flip'; axis: Axis}
    | {kind: 'mirror'; axis: Axis}
    | {kind: 'duplicate'; delta: Cell}
    | {kind: 'array'; delta: Cell; count: number}
    | {kind: 'delete'}
    | {kind: 'paint'; color: number}

/**
 * What the objects panel can do. One action for the lot, for the same reason `TransformOp` is one:
 * `remove` is the only one that touches voxels, and every other case would be a chance to forget.
 */
export type ObjectOp =
    | {kind: 'add'}
    | {kind: 'copy'; id: number}
    | {kind: 'active'; id: number}
    | {kind: 'rename'; id: number; name: string}
    | {kind: 'hidden'; id: number; on: boolean}
    | {kind: 'locked'; id: number; on: boolean}
    | {kind: 'solo'; id: number}
    | {kind: 'remove'; id: number}
    | {kind: 'reorder'; id: number; to: number}

/** The transforms that must end with as many voxels as they started with. See the reducer. */
const KEEPS_COUNT: ReadonlySet<TransformOp['kind']> = new Set(['move', 'rotate', 'flip'])

/**
 * What Copy took: the values, as offsets from the corner of the box they filled.
 *
 * Offsets rather than absolute cells, so a paste can land anywhere. `at` is where they came from,
 * which is where a paste puts them back — one voxel up, so the copy is visible instead of landing
 * exactly on top of the original and looking like nothing happened.
 */
export interface Clipboard {
    readonly at: Cell
    readonly cells: readonly {offset: Cell; value: number}[]
}

/**
 * Which file is open, and whether it has been written since it last changed.
 *
 * It is state rather than a prop because Save As, New and Open all rename the document, and a name
 * that only `main.tsx` can set is a name nothing can change.
 */
export interface DocumentIdentity {
    /** With its extension: `knight.gpix`, or `car.vox` for something imported. */
    readonly name: string
    /** Milliseconds since the epoch of the last successful write, or `undefined` for never. */
    readonly savedAt: number | undefined
    /** Whether there is something in this document that no file on disk holds. */
    readonly dirty: boolean
}

/**
 * What the artist sees, as opposed to what the artist ships.
 *
 * Nine fields whose whole implementation was nine reducer cases reading `{...state, x: action.x}`,
 * and nine action types to carry them. Folded into one because the *distinction* is real and was
 * only ever written down in prose: **nothing in here is in the save file, and nothing in here is in
 * the undo history.** `CHROME_IS_NOT_SAVED` below turns that sentence into something the compiler
 * checks, so a field cannot be quietly promoted into the document by adding it to two lists.
 *
 * The near-miss is worth naming, because it looks like chrome and is not. Everything in `output`
 * travels in the `.gpix` — it decides what comes out of an export, so it is document, and it got
 * this same fold for that reason. `preview` is the one that separates the two: it is the size the
 * Renders panel draws at, and it is deliberately *not* the sheet's `cell`, because the question it
 * answers is "does this detail survive 16 px" and answering it must not change what gets exported.
 */
export interface Chrome {
    /** Which of the four maps the viewport draws — the same enum the shader takes. */
    readonly map: number
    /** Edge of the sprite the Renders panel previews, in pixels — `FEATURESET.md` §15. */
    readonly preview: number
    /** What the objects panel's search box holds. */
    readonly search: string
    readonly grid: boolean
    /**
     * Whether the viewport draws the voxel lattice on the faces it renders.
     *
     * A flat face is one tone however many voxels wide it is, and counting cells on it by eye is
     * most of what placing the next voxel needs.
     */
    readonly edges: boolean
    readonly snap: boolean
    /**
     * Whether a drag turns the view the other way round — see `viewport/orbit.ts`.
     *
     * A fact about the hands at this desk, not about the model, which is exactly why it is chrome.
     */
    readonly invert: boolean
    readonly workspace: 'model' | 'render'
    readonly fps: number
    /**
     * The pitch the next direction ring is built at — see `RING_PITCHES`.
     *
     * Chrome, and it takes the definition: the cameras it produces are document and are saved with
     * their own pitch, so nothing here has to travel with them. It is a setting on a button, and it
     * lives on the state rather than inside `ViewsStrip` so that pressing 4 and then 8 stays flat.
     */
    readonly ringPitch: RingPitch
    /**
     * The row being dragged along a list, if one is — the views strip's camera and the objects
     * panel's object. `FEATURESET.md` §16.
     *
     * Chrome, and it takes the definition exactly: a half-finished gesture is never in the save
     * file and never in the undo history. The camera's half used to be a top-level field with its
     * own `drag-camera` action; the object's half was a `useState` inside `ObjectsPanel`, so one
     * gesture — pointerdown arms, pointerenter reorders, pointerup and pointerleave disarm, with
     * the same comment written twice about a drag that outlives the mouse — was tested once in
     * `state.test.ts` at four milliseconds and once through a two-hundred-millisecond window.
     */
    readonly draggingCamera: string | undefined
    readonly draggingObject: number | undefined
}

/**
 * `extends Gesture` is load-bearing, not documentation.
 *
 * It is what lets the pointer cases hand this whole value to `doc/gesture.ts` and get their own
 * type back, and it is what makes the compiler check that the eighteen fields a gesture reads are
 * still the fields this state holds. Rename one here and the gesture module stops compiling, which
 * is the failure that used to be a silently wrong outline.
 */
export interface AppState extends Gesture, Chrome, Views {
    readonly doc: DocumentIdentity
    /**
     * What generated this model, when one did — `undefined` for everything drawn or imported.
     *
     * It travels in the `.gpix` at format version 3. A generated asset whose prompt, seed and
     * sampler were not recorded cannot be reproduced or nudged, only regenerated and hoped over.
     */
    readonly origin: GenerationRecord | undefined
    /**
     * What comes out of an export — `doc/save.ts`'s own `SavedOutput`, whole.
     *
     * One field rather than five, for the reason `Chrome` is one field rather than nine: the five
     * were flattened here, unpacked in `initialState`, rebuilt in `asDocument`, listed one by one
     * in `DOCUMENT_FIELDS` and read again by the bake — the same concept written out five times,
     * and served by four action types whose whole implementation was `{...state, x: action.x}`.
     *
     * It is the *format's* type and not a copy of it, so a field cannot be added to one and
     * forgotten in the other. Unlike `Chrome`, every field in here travels in the `.gpix` and marks
     * the document dirty — which is exactly the distinction `Chrome`'s doc comment draws.
     */
    readonly output: SavedOutput
    /** Pixel art to build against, one image per plane — `FEATURESET.md` §33. */
    readonly references: readonly Reference[]

    /** What Copy took, as offsets from the corner of what was selected, plus that corner. */
    readonly clipboard: Clipboard | undefined
    /**
     * Whether the palette refuses to be edited.
     *
     * It guards the entries, not the model: a locked palette still draws, fills and replaces
     * colours, because those move voxels between entries rather than changing what an entry is.
     * The thing being protected is a palette an artist has tuned and does not want a stray drag on
     * a colour field to undo — and a palette edit is deliberately not in the undo history, which is
     * exactly why it needs a lock instead.
     */
    readonly paletteLocked: boolean
    readonly frame: number
}

export type AppAction =
    | {type: 'orbit'; event: OrbitEvent; height: number}
    | {type: 'pointer'; event: ViewportPointer}
    | {type: 'undo'}
    | {type: 'redo'}
    | {type: 'select-color'; color?: number}
    | {type: 'grow-selection'}
    | {type: 'shrink-selection'}
    | {type: 'clear-selection'}
    | {type: 'transform'; op: TransformOp}
    | {type: 'symmetry'; axis: keyof Symmetry; on: boolean}
    | {type: 'plane'; axis: Axis | undefined}
    | {type: 'copy'}
    | {type: 'paste'}
    | {type: 'object'; op: ObjectOp}
    | {type: 'focus'}
    | {type: 'select'; id: string}
    | {type: 'directions'; count: number}
    /**
     * The pitch every ring is built at, and the ring on screen right now with it.
     *
     * Not a `chrome` action, though `ringPitch` is a chrome field: pressing it rebuilds the
     * cameras, and cameras are document. A toggle whose effect only shows the *next* time some
     * other button is pressed is a toggle nobody can see the meaning of.
     */
    | {type: 'ring-pitch'; pitch: RingPitch}
    | {type: 'align'}
    | {type: 'capture'}
    | {type: 'duplicate'}
    | {type: 'delete'; id: string}
    /**
     * Anything about what an export writes — see `AppState.output`. One action for `cell`,
     * `padding`, `bounds` and `preset`, because each of the four cases was the same assignment.
     *
     * `presets` is deliberately not set through here. Saving one and dropping one have rules — a
     * built-in name cannot be taken, saving over a name replaces it, dropping the selected one
     * falls back — and a `Partial` that could carry the whole list would let a caller past them.
     */
    | {type: 'output'; output: Omit<Partial<SavedOutput>, 'presets'>}
    | {type: 'save-preset'; name: string; maps: readonly SheetMap[]}
    | {type: 'drop-preset'; name: string}
    | {type: 'reorder-camera'; id: string; to: number}
    | {type: 'reference'; plane: Axis; url: string}
    | {type: 'reference-opacity'; plane: Axis; opacity: number}
    | {type: 'reference-lock'; plane: Axis; on: boolean}
    | {type: 'reference-drop'; plane: Axis}
    | {type: 'import-image'; volume: Volume; name: string}
    | {type: 'generate'; volume: Volume; name: string; record: GenerationRecord}
    | {type: 'open'; document: OpenedDocument}
    | {type: 'new'; volume: Volume; objects: Objects; name: string}
    | {type: 'saved'; name: string; at: number}
    | {type: 'slice'; on: boolean}
    | {type: 'slice-step'; delta: number}
    | {type: 'tool'; tool: Tool}
    | {type: 'brush'; brush: Partial<Brush>}
    | {type: 'color'; color: number}
    | {type: 'emissive'; color: number; value: number}
    | {type: 'palette-color'; color: number; css: string}
    | {type: 'palette-lock'; on: boolean}
    | {type: 'palette-add'}
    | {type: 'palette-load'; text: string}
    | {type: 'replace-color'; from: number; to: number}
    /** Anything the artist sees but does not ship — see `Chrome`. One action for all nine. */
    | {type: 'chrome'; chrome: Partial<Chrome>}
    | {type: 'unaim'}

/**
 * A document opened from somewhere other than a `.vox` file — a `.gpix` off the disk or a recovered
 * autosave, which brings its own objects, cameras, references and export settings and must not have
 * any of them regenerated over the top.
 *
 * It is `doc/save.ts`'s own `Document` plus the name the file had, so there is one shape between the
 * format and the app and no field can be added to one and forgotten in the other.
 */
export interface OpenedDocument extends Document {
    readonly name: string
    /**
     * Whether what is arriving is work no file on disk holds.
     *
     * True for a snapshot, false for a `.gpix`, and the distinction is the whole point. An autosave
     * is written on every *committed edit*, so a snapshot is by definition an edit that was never
     * saved — and a recovery that opened claiming to be saved would let the artist close the tab
     * without a word and lose exactly the work the recovery just handed back.
     */
    readonly unsaved?: boolean
}

export const initialState = (source: Volume, name: string, opened?: OpenedDocument): AppState => {
    /*
     * Every document opens on a palette worth painting from — see `freshenPalette`. It runs here
     * rather than in the `.vox` reader because it is an editor decision, not a format one: the
     * reader's job is to say what the file holds, and a golden-hash test of the reader must keep
     * getting the file's own bytes back.
     */
    const volume = {...source, palette: freshenPalette(source)}
    const cameras = opened?.cameras.length ? [...opened.cameras] : eightDirections(volume)
    const views = startViews(cameras)
    const first = viewNamed(views, views.selected)
    const saved = opened?.output
    return {
        doc: {name, savedAt: undefined, dirty: opened?.unsaved === true},
        volume,
        origin: opened?.origin,
        ...views,
        orbit: {
            camera: first?.camera ?? createCamera(volume, 0, ISOMETRIC_PITCH),
            gesture: undefined
        },
        map: MODE_COLOR,
        output: {
            cell: saved?.cell ?? 64,
            padding: saved?.padding ?? 0,
            bounds: saved?.bounds ?? false,
            presets: saved?.presets ?? [],
            /* An empty or missing name means the default — see `presetNamed`. */
            preset: presetNamed(saved?.preset)
        },
        references: opened?.references ?? [],
        preview: 64,
        history: EMPTY_HISTORY,
        stroke: undefined,
        selection: EMPTY_SELECTION,
        band: undefined,
        drag: undefined,
        losing: 0,
        aim: undefined,
        hover: undefined,
        symmetry: opened?.symmetry ?? NO_SYMMETRY,
        objects: opened?.objects ?? initialObjects(volume),
        search: '',
        plane: undefined,
        clipboard: undefined,
        slice: undefined,
        tool: 'draw',
        brush: {size: 2, shape: 'square', figure: 'free'},
        color: firstColor(volume),
        recent: [firstColor(volume)],
        paletteLocked: false,
        grid: true,
        edges: true,
        snap: true,
        invert: false,
        workspace: 'model',
        fps: 24,
        ringPitch: 'iso',
        draggingCamera: undefined,
        draggingObject: undefined,
        frame: 1
    }
}

/**
 * Replace the list with one ring, and look through it — the whole of what the 4, 8 and flat buttons
 * do. The viewport follows the strip, or the highlight is a claim about a view nobody is at.
 */
const ringOf = (state: AppState, count: number, pitch: RingPitch): AppState => {
    const next = resetViews(state, directions(state.volume, count, RING_PITCHES[pitch]))
    return withCamera(
        next,
        viewNamed(next, next.selected)?.camera ?? state.orbit.camera,
        next.selected
    )
}

/** Turn the view, and say which stored camera it is now — `undefined` for none. See `showView`. */
const withCamera = (state: AppState, camera: Camera, selected: string | undefined): AppState => ({
    ...showView(state, selected),
    orbit: {camera, gesture: undefined}
})

const applyTransform = (draft: Draft, state: AppState, op: TransformOp): Selection => {
    const {selection} = state
    switch (op.kind) {
        case 'move':
            return moveCells(draft, selection, op.delta)
        case 'rotate':
            return rotateCells(draft, selection, op.axis)
        case 'flip':
            return flipCells(draft, selection, op.axis)
        case 'mirror':
            return mirrorCells(draft, selection, op.axis)
        case 'duplicate':
            return duplicateCells(draft, selection, op.delta)
        case 'array':
            return arrayCells(draft, selection, op.delta, op.count)
        case 'delete':
            return deleteCells(draft, selection)
        case 'paint':
            return paintCells(draft, selection, op.color)
    }
}

/**
 * Land one step of the history.
 *
 * The object list comes back with the voxels when the step carried one, because the two are one
 * change. Undoing a delete used to restore only the cells, which left them owned by an id that had
 * no row — unhideable, unlockable, and adopted by the next object added, since ids are reused.
 *
 * The selection is dropped rather than restored. It is not in the history, so the cells it names
 * may no longer hold what the artist chose, and a stale selection is worse than none.
 */
const stepped = (state: AppState, taken: HistoryStep): AppState => ({
    ...state,
    volume: taken.volume,
    history: taken.history,
    objects: taken.objects ?? state.objects,
    selection: taken.objects ? EMPTY_SELECTION : state.selection
})

const step = (state: AppState, action: AppAction): AppState => {
    switch (action.type) {
        case 'orbit': {
            // In slice mode the wheel walks through depth, which is what §6 asks of it. Zoom is
            // still on the wheel everywhere else, and slice mode is off by default.
            if (state.slice !== undefined && action.event.type === 'wheel') {
                return reduce(state, {
                    type: 'slice-step',
                    delta: action.event.delta > 0 ? 1 : -1
                })
            }
            const orbit = applyOrbit(
                state.orbit,
                action.event,
                action.height,
                state.snap,
                state.invert
            )
            if (orbit === state.orbit) return state
            // Once the view has moved it is no longer the stored camera, and saying so is the
            // difference between a list of cameras and a list of bookmarks that quietly lie.
            const moved = orbit.camera !== state.orbit.camera
            return {...(moved ? showView(state, undefined) : state), orbit}
        }

        /*
         * One entry point for the viewport, so the choice between moving the camera and writing
         * voxels is made in the tested pure function rather than in a JSX handler. The right and
         * middle buttons and Shift always move the camera, whatever is armed — otherwise arming
         * Draw would cost the artist the ability to look at what they are drawing.
         */
        case 'pointer': {
            const {event} = action
            // Every viewport event is a sighting of the pointer, whatever else it turns out to be.
            // `reduce` re-aims the outline from it once this case has decided what happened.
            const seen: AppState = {...state, aim: event}
            if (event.type === 'down') {
                if (event.button === 0 && !event.shift) {
                    if (WRITES.has(seen.tool)) return beginStroke(seen, event)
                    if (SELECTS.has(seen.tool)) return beginSelect(seen, event)
                }
                return reduce(seen, {
                    type: 'orbit',
                    event: {
                        type: 'pointerdown',
                        x: event.x,
                        y: event.y,
                        secondary: event.shift || event.button === 1
                    },
                    height: event.height
                })
            }
            if (seen.stroke) {
                return event.type === 'move' ? continueStroke(seen, event) : endStroke(seen)
            }
            if (seen.band) {
                return event.type === 'move' ?
                        {...seen, band: {...seen.band, x1: event.x, y1: event.y}}
                    :   endBand(seen)
            }
            if (seen.drag) {
                return event.type === 'move' ? continueDrag(seen, event) : endDrag(seen)
            }
            return reduce(seen, {
                type: 'orbit',
                event:
                    event.type === 'move' ?
                        {type: 'pointermove', x: event.x, y: event.y}
                    :   {type: 'pointerup'},
                height: event.height
            })
        }

        /** The pointer has left the viewport, so there is no next click to point at. */
        case 'unaim':
            return state.aim === undefined ? state : {...state, aim: undefined}

        case 'undo': {
            // Mid-stroke there is nothing coherent to undo *to*: the draft is not an edit yet.
            if (state.stroke) return state
            const back = undo(state.volume, state.history)
            return back ? stepped(state, back) : state
        }

        case 'redo': {
            if (state.stroke) return state
            const forward = redo(state.volume, state.history)
            return forward ? stepped(state, forward) : state
        }

        /*
         * Turn the view to the nearest of the eight yaws and the nearest of the pitch stops —
         * `FEATURESET.md` §14. Nearest rather than a named view, because an artist who has orbited
         * to roughly three-quarters-left wants exactly that and not Front.
         */
        case 'align':
            return withCamera(state, alignCamera(state.orbit.camera), undefined)

        case 'select-color':
            return {...state, selection: selectColor(state.volume, action.color ?? state.color)}

        case 'grow-selection':
            return {...state, selection: grow(state.volume, state.selection)}

        case 'shrink-selection':
            return {...state, selection: shrink(state.volume, state.selection)}

        case 'clear-selection':
            return state.selection.size === 0 ? state : {...state, selection: EMPTY_SELECTION}

        case 'transform': {
            if (state.selection.size === 0) return state
            const {op} = action
            // A nudge that would push part of the selection off the grid is refused whole, rather
            // than dropping the voxels that fell off — that is the one loss undo cannot make
            // obvious, because nothing on screen says how many went.
            if (op.kind === 'move' && !fitsAfter(state.volume, state.selection, op.delta)) {
                return state
            }
            const draft = openDraft(state)
            const selection = applyTransform(draft, state, op)
            /*
             * Move, rotate and flip are bijections: every selected voxel has exactly one
             * destination, so a selection that came back smaller lost voxels off the edge of the
             * grid. Refuse the whole operation rather than half-doing it — the draft is a throwaway
             * copy, so discarding it costs nothing, and a rotate that silently keeps half a model
             * is the kind of loss undo cannot make obvious. Duplicate, array and mirror are
             * additive and may legitimately clip.
             */
            if (KEEPS_COUNT.has(op.kind) && selection.size !== state.selection.size) return state
            const landed = commit(state, draft, {selection})
            return landed ? {...state, ...landed} : state
        }

        case 'plane':
            // Leaving the plane lock leaves slice mode: a slice needs an axis to be a slice of.
            return {
                ...state,
                plane: action.axis,
                slice: action.axis === undefined ? undefined : state.slice
            }

        /*
         * Slice mode — `FEATURESET.md` §6. It opens on the middle layer of the locked plane, and
         * locks XY if nothing was locked, because a slice with no plane is a slice of nothing.
         */
        case 'slice': {
            if (!action.on) return {...state, slice: undefined}
            const axis = state.plane ?? 2
            return {
                ...state,
                plane: axis,
                slice: Math.floor(layerCount(state.volume, axis) / 2)
            }
        }

        case 'slice-step': {
            if (state.slice === undefined) return state
            const axis = state.plane ?? 2
            return {...state, slice: clampLayer(state.volume, axis, state.slice + action.delta)}
        }

        case 'copy': {
            const box = selectionBounds(state.volume, state.selection)
            if (!box) return state
            const cells = [...state.selection].map(index => {
                const [x, y, z] = cellOf(state.volume, index)
                return {
                    offset: [x - box.min[0], y - box.min[1], z - box.min[2]] as Cell,
                    value: state.volume.data[index] ?? 0
                }
            })
            return {...state, clipboard: {at: box.min, cells}}
        }

        case 'paste': {
            const {clipboard} = state
            if (!clipboard) return state
            const draft = openDraft(state)
            // One voxel up from where it was copied. Pasting exactly on top of the original looks
            // like nothing happened, and the copy comes back selected so it can be dragged.
            const selection = pasteCells(draft, clipboard.cells, [
                clipboard.at[0],
                clipboard.at[1],
                clipboard.at[2] + 1
            ])
            const landed = commit(state, draft, {selection})
            return landed ? {...state, ...landed} : state
        }

        /*
         * Every object operation but one is a change to a list of names and flags. `remove` is the
         * exception: it takes the voxels with it, so it goes through a draft and lands in the
         * history like any other edit — deleting an object the artist spent an hour on has to be
         * one Ctrl-Z away.
         */
        case 'object': {
            const {op} = action
            const {objects} = state
            switch (op.kind) {
                case 'add': {
                    const added = addObject(objects)
                    return added ? {...state, objects: added} : state
                }
                /*
                 * `FEATURESET.md` §8's duplicate. The copy lands beside the original rather than
                 * inside it, because one cell has one owner — see `duplicateOffset`. It carries
                 * voxels, so it is an edit and goes into the history with the list stamped on it.
                 */
                case 'copy': {
                    const source = objectAt(objects, op.id)
                    const delta = duplicateOffset(state.volume, objectBounds(state.volume, op.id))
                    if (!source || !delta) return state
                    const added = addObject(objects, `${source.name} copy`)
                    if (!added) return state
                    const draft = beginEdit(state.volume, added.active, lockedIds(objects))
                    const [dx, dy, dz] = delta
                    for (const index of objectCells(state.volume, op.id)) {
                        const [x, y, z] = cellOf(state.volume, index)
                        const value = voxelAt(state.volume, x, y, z)
                        writeOwned(draft, x + dx, y + dy, z + dz, value, added.active)
                    }
                    // The list moved, so this is an edit whether or not a cell did — see `commit`.
                    const landed = commit(state, draft, {objects: added})
                    return landed ? {...state, ...landed} : state
                }
                case 'active':
                    return {...state, objects: {...objects, active: op.id}}
                case 'rename':
                    return {...state, objects: renameObject(objects, op.id, op.name)}
                case 'hidden':
                    return {...state, objects: setHidden(objects, op.id, op.on)}
                case 'locked':
                    return {...state, objects: setLocked(objects, op.id, op.on)}
                case 'solo':
                    return {...state, objects: soloObject(objects, op.id)}
                case 'reorder':
                    return {...state, objects: moveObject(objects, op.id, op.to)}
                case 'remove': {
                    const list = removeObject(objects, op.id)
                    if (list === objects) return state
                    // Removing has to be able to clear a locked object: the artist is deleting it
                    // on purpose, and a lock is about stray clicks.
                    const draft = beginEdit(state.volume, list.active)
                    const gone = objectCells(state.volume, op.id)
                    for (const index of gone) {
                        const [x, y, z] = cellOf(state.volume, index)
                        writeCells(draft, [[x, y, z]], 0)
                    }
                    /*
                     * An empty object has no cells to commit, and the delete still has to be
                     * undoable — losing a name is a loss. Passing `objects` is what says "the list
                     * changed and the grid did not"; see `commit` and `NO_CELLS`.
                     */
                    const landed = commit(state, draft, {objects: list})
                    return landed ? {...state, ...landed} : state
                }
            }
            return state
        }

        /*
         * Fill the frame with the active object — `FEATURESET.md` §1. The angle is left alone,
         * because an artist who has found the three-quarter view they want to work at should not
         * lose it to a button that means "look closer".
         */
        case 'focus': {
            const box = objectBounds(state.volume, state.objects.active)
            if (!box) return state
            return withCamera(state, focusOn(state.orbit.camera, state.volume, box), undefined)
        }

        case 'symmetry': {
            if (action.axis === 'radial' && !canRadial(state.volume)) return state
            return {...state, symmetry: {...state.symmetry, [action.axis]: action.on}}
        }

        case 'select': {
            const found = viewNamed(state, action.id)
            return found ? withCamera(state, found.camera, found.id) : state
        }

        case 'directions':
            return ringOf(state, action.count, state.ringPitch)

        /*
         * Flipping the pitch re-cuts the ring under the artist, and only when there is one — see
         * `ringCount`. With cameras of their own on the list it is just the setting for next time.
         */
        case 'ring-pitch': {
            const next = {...state, ringPitch: action.pitch}
            const count = ringCount(state.cameras)
            return count === undefined ? next : ringOf(next, count, action.pitch)
        }

        case 'capture':
            return captureView(state, state.orbit.camera)

        case 'duplicate':
            return duplicateView(state)

        /* Both pointers fall where `doc/views.ts` says they fall — that rule has one home now. */
        case 'delete':
            return removeView(state, action.id)

        /*
         * What an export writes — see `AppState.output`. Four cases became one, and unlike
         * `chrome` the fold is *not* safe by being inert: every field in here travels in the
         * `.gpix`, so this action marks the document dirty. Three of the four also change the
         * sheet, which the export dialog rebakes on its own because it watches the same values.
         *
         * The padding clamp lives here rather than in the panel, so the bound is a property of the
         * document and holds however the value was set.
         */
        case 'output': {
            const {padding} = action.output
            return {
                ...state,
                output: {
                    ...state.output,
                    ...action.output,
                    ...(padding === undefined ? {} : {padding: Math.max(0, Math.round(padding))})
                }
            }
        }

        /*
         * A preset the artist saved, and one they dropped — `FEATURESET.md` §38. Both rules and
         * both fallbacks are `sheet/presets.ts`; `undefined` back means the name was refused.
         */
        case 'save-preset': {
            const output = savePreset(state.output, action.name, action.maps)
            return output ? {...state, output} : state
        }

        case 'drop-preset': {
            const output = dropPreset(state.output, action.name)
            return output ? {...state, output} : state
        }

        /*
         * The pictures the artist builds against — every rule about them is `doc/reference.ts`,
         * including the one word that used to be spelled three ways across these four cases and
         * left out of the first of them: what a lock refuses.
         */
        case 'reference':
            return {...state, references: place(state.references, action.plane, action.url)}

        case 'reference-opacity':
            return {...state, references: fade(state.references, action.plane, action.opacity)}

        case 'reference-lock':
            return {...state, references: lock(state.references, action.plane, action.on)}

        case 'reference-drop':
            return {...state, references: drop(state.references, action.plane)}

        /*
         * A PNG imported as voxels is a *new document* — `FEATURESET.md` §34 calls it a starting
         * point, and it brings its own grid size and its own palette. Merging it into the open one
         * would need a resize and a palette remap, and neither is what "instantly gives artists
         * something to sculpt from" means.
         */
        /*
         * A PNG extruded into voxels — `FEATURESET.md` §34.
         *
         * The reference art and the export presets do carry over, unlike `open` below, because this
         * is not another project arriving: it is the artist turning the sketch they are already
         * tracing into something to sculpt, in the session they are already in. It starts dirty
         * because there are voxels here that no file holds.
         */
        case 'import-image': {
            const imported = initialState(action.volume, action.name)
            return {
                ...imported,
                doc: {...imported.doc, dirty: true},
                references: state.references,
                output: state.output
            }
        }

        /*
         * A generated candidate, taken into the editor as an ordinary document — see `src/gen/`.
         *
         * It replaces rather than merges, and it has to: the spec brings its own grid size and its
         * own palette, and a grid cannot be resized. It arrives dirty and never saved, because it
         * is by definition work no file holds. The prompt, seed and sampler come with it, so the
         * artist can ask the same question again with the same answer.
         *
         * Everything after this point is drawing. A generated model has no special status in the
         * document, no lock and no second history — the whole point of the pipeline is that it
         * hands over a model, not an attachment to one.
         */
        case 'generate': {
            const made = initialState(action.volume, action.name)
            return {
                ...made,
                doc: {...made.doc, dirty: true},
                origin: action.record,
                // The artist's reference art and their saved export presets belong to the desk
                // rather than to the model, and a new model is not a reason to lose either.
                references: state.references,
                output: state.output
            }
        }

        /*
         * A document replacing this one — a `.gpix` off the disk, or a snapshot being restored
         * (`FEATURESET.md` §32). It empties the undo history, because the history is a list of
         * diffs against a grid that is no longer there and undoing one would apply it to the wrong
         * model.
         *
         * It takes the references and the export presets from the file. They used to be carried
         * over from the state being replaced, which was right when the only caller was a snapshot
         * restore inside one session. It is wrong for a file: a `.gpix` brings its own, and keeping
         * the old ones would put one project's reference art over another project's model.
         */
        case 'open':
            return initialState(action.document.volume, action.document.name, action.document)

        /*
         * A new grid, and nothing else carried over. The empty camera list is what asks
         * `initialState` to regenerate them: `eightDirections` frames the grid it is given, and a
         * new grid is a different size from the one that was open.
         */
        case 'new':
            return initialState(action.volume, action.name, {
                name: action.name,
                volume: action.volume,
                objects: action.objects,
                cameras: [],
                references: [],
                symmetry: NO_SYMMETRY,
                output: DEFAULT_OUTPUT,
                origin: undefined
            })

        case 'saved':
            return {...state, doc: {name: action.name, savedAt: action.at, dirty: false}}

        case 'reorder-camera':
            return reorderView(state, action.id, action.to)

        case 'tool':
            return {...state, tool: action.tool}

        case 'brush': {
            const brush = {...state.brush, ...action.brush}
            // Clamped here rather than in the stepper, so that the bound is a property of the
            // document and holds however the value was set.
            return {...state, brush: {...brush, size: Math.max(1, Math.min(MAX_BRUSH, brush.size))}}
        }

        case 'color':
            return {...state, color: action.color, recent: remember(state.recent, action.color)}

        /*
         * Editing a palette entry, and the four things that are *not* the same as it: replacing a
         * colour moves voxels between entries; adding takes an unused slot; loading a file replaces
         * the lot; and the lock stops the first three of those from being a stray drag.
         *
         * None of them are undo steps, for the reason `emissive` is not: history holds cell diffs,
         * and folding a second kind of change into a format built for one is how an undo stack
         * starts lying. `replace-color` *is* an undo step, because it moves voxels.
         */
        case 'palette-color': {
            if (state.paletteLocked) return state
            const palette = withColor(state.volume.palette, action.color, action.css)
            return {...state, volume: {...state.volume, palette}}
        }

        case 'palette-lock':
            return {...state, paletteLocked: action.on}

        case 'palette-add': {
            if (state.paletteLocked) return state
            const slot = freeSlot(state.volume)
            // Every slot in use is not an error; it is a palette that is full, and 255 colours is
            // more than any pixel artist has asked for.
            return slot === 0 ? state : (
                    {...state, color: slot, recent: remember(state.recent, slot)}
                )
        }

        case 'palette-load': {
            if (state.paletteLocked) return state
            const palette = fromHexPalette(action.text, state.volume.palette)
            return {...state, volume: {...state.volume, palette}}
        }

        case 'replace-color': {
            const draft = openDraft(state)
            if (remapColor(draft, action.from, action.to) === 0) return state
            const landed = commit(state, draft)
            if (!landed) return state
            return {
                ...state,
                ...landed,
                color: action.to,
                recent: remember(state.recent, action.to)
            }
        }

        /*
         * Which palette entries glow — the one part of `FEATURESET.md` §20 that survives, because
         * §18's emission map needs something to say what is in it.
         *
         * Not an undo step. History holds cell diffs, and this changes no cell: it changes what a
         * colour *is*, the same way editing the palette would. Folding a second kind of change into
         * a diff format built for one is how an undo stack starts lying.
         */
        case 'emissive': {
            const emissive = new Uint8Array(state.volume.emissive)
            emissive[action.color] = action.value
            return {...state, volume: {...state.volume, emissive}}
        }

        /*
         * Everything the artist sees and does not ship — see `Chrome`. Nine cases became one, and
         * the fold is safe precisely because none of them can forget anything: no history to
         * record, no sheet to invalidate, no file to mark dirty. An action that needs to do any of
         * those is not chrome and does not belong here.
         */
        case 'chrome':
            return {...state, ...action.chrome}
    }
}

const DOCUMENT_FIELDS = [
    'volume',
    'objects',
    'cameras',
    'references',
    'symmetry',
    // Everything an export writes, in one field — `SavedOutput`. It used to be five entries here.
    'output'
] as const satisfies readonly (keyof AppState)[]

/**
 * Chrome is never in the save file — as a thing the compiler holds, rather than a comment.
 *
 * Move a field into `Chrome` while it is still in `DOCUMENT_FIELDS` and this stops compiling. The
 * failure it prevents is quiet in both directions: a document field folded into chrome stops
 * marking the document dirty, and a chrome field listed as a document field makes every toggle of
 * the grid overlay claim there is unsaved work.
 */
type ChromeIsNotSaved =
    Extract<keyof Chrome, (typeof DOCUMENT_FIELDS)[number]> extends never ? true : never
const CHROME_IS_NOT_SAVED: ChromeIsNotSaved = true
void CHROME_IS_NOT_SAVED

/**
 * The state as the thing `doc/save.ts` writes down — the other half of `DOCUMENT_FIELDS`.
 *
 * One function, so a save and a dirty check can never disagree about what the document is: add a
 * field to the format and both the list above and this stop compiling until it is handled.
 */
export const asDocument = (state: AppState): Document => ({
    volume: state.volume,
    objects: state.objects,
    cameras: state.cameras,
    references: state.references,
    symmetry: state.symmetry,
    // Not in `DOCUMENT_FIELDS`, and deliberately: `origin` only ever changes in the one action that
    // replaces the whole document, so it can never be the field that makes a document unsaved.
    origin: state.origin,
    output: state.output
})

export const reduce = (state: AppState, action: AppAction): AppState => {
    const acted = step(state, action)
    if (acted === state) return state
    /*
     * An action that set the identity itself — `open`, `new`, `saved` — is left alone. Each one
     * replaces the whole document, so every field below differs and the comparison would call a
     * file that has just been opened unsaved.
     */
    const next =
        (
            acted.doc === state.doc
            && !state.doc.dirty
            && DOCUMENT_FIELDS.some(key => acted[key] !== state[key])
        ) ?
            {...acted, doc: {...acted.doc, dirty: true}}
        :   acted
    return changedAim(state, next) ? hoverAt(next) : next
}
