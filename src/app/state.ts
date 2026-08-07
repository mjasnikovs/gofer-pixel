import {
    BRUSH_KINDS,
    faceAxis,
    MAX_BRUSH,
    SHAPES,
    type Axis,
    type Brush,
    type BrushKind,
    type Offset,
    type Shape
} from '../doc/brush'
import {
    alignCamera,
    captureCamera,
    directions,
    eightDirections,
    focusOn,
    ISOMETRIC_PITCH,
    type NamedCamera
} from '../doc/cameras'
import {beginEdit, commitEdit, fillRegion, strokeCells, writeCells, type Draft} from '../doc/edits'
import {figureCells} from '../doc/figures'
import {
    addObject,
    initialObjects,
    lockedIds,
    moveObject,
    objectBounds,
    objectCells,
    ownerAt,
    removeObject,
    renameObject,
    setHidden,
    setLocked,
    shownVolume,
    soloObject,
    type Objects
} from '../doc/objects'
import {EMPTY_HISTORY, record, redo, undo, type History} from '../doc/history'
import {firstColor, freeSlot, fromHexPalette, remember, withColor} from '../doc/palette'
import {
    cellOf,
    EMPTY_SELECTION,
    grow,
    selectColor,
    selectConnectedColor,
    selectObject,
    selectRect,
    facePatch,
    selectionBounds,
    selectVoxel,
    shrink,
    type Cell,
    type Selection
} from '../doc/selection'
import {canRadial, NO_SYMMETRY, symmetryMaps, type Symmetry} from '../doc/symmetry'
import {
    arrayCells,
    deleteCells,
    duplicateCells,
    extrudeCells,
    fitsAfter,
    flipCells,
    mirrorCells,
    moveCells,
    paintCells,
    pasteCells,
    remapColor,
    rotateCells
} from '../doc/transform'
import {basisFor, createCamera, type Camera} from '../render/camera'
import {FACE_STEP} from '../render/faces'
import {pick, pickPlane, pickRay} from '../render/pick'
import {MODE_COLOR} from '../render/raycast.glsl'
import {voxelIndex, type Volume} from '../render/volume'
import {renderSheet, SHEET_MAPS, type Sheet, type SheetMap} from '../sheet/sheet'
import {
    apply as applyOrbit,
    type OrbitEvent,
    type OrbitState,
    type ViewportPointer
} from '../viewport/orbit'

/**
 * The whole application as a value, and one pure function that moves it.
 *
 * Every wiring bug, stale render and wrong-action bug dies in a `bun test` against this, in under a
 * millisecond each, with no DOM. React below is a projection of it and holds no logic of its own.
 */

/** The nine tools down the left rail of `docs/editor.png`, in the order the mockup lists them. */
export const TOOLS = [
    'draw',
    'erase',
    'fill',
    'pick',
    'move',
    'rotate',
    'scale',
    'clone',
    'measure'
] as const
export type Tool = (typeof TOOLS)[number]

/**
 * The brush lives in `doc/` — which cells a click writes is document arithmetic, and the panel
 * here is a projection of it. Re-exported so the panels keep importing their types from the state
 * they are drawn from.
 */
export {BRUSH_KINDS, MAX_BRUSH, SHAPES}
export type {Brush, BrushKind, Shape}

/**
 * The tools that take the left button in the viewport. The rest still orbit with it, because a tool
 * that has not been built yet must not silently swallow the gesture that moves the camera.
 */
const WRITES: ReadonlySet<Tool> = new Set<Tool>(['draw', 'erase', 'fill', 'pick'])

/**
 * The tools that work on a selection. Move is where selecting happens, because a selection with no
 * tool that consumes it is a highlight — `docs/editor.png` has no separate select tool, and
 * `FEATURESET.md` §39 is explicit that the rail should not grow one.
 */
const SELECTS: ReadonlySet<Tool> = new Set<Tool>(['move', 'rotate', 'scale', 'clone'])

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
 * A drag that is moving voxels rather than choosing them.
 *
 * Replayed from its start on every pointer move, never accumulated — the same pattern as
 * `viewport/orbit.ts`, and for the same three reasons: the gesture is reproducible from its start
 * plus a position, a test can jump straight to the end of a drag, and a dropped move event cannot
 * leave the model somewhere the mouse is not. Accumulating would also mean a drag that wanders
 * back and forth grinds the model up, because each step would move whatever it happened to hit.
 *
 * The cost is one grid copy per pointer move. On a 128³ document that is 2 MB of memcpy at mouse
 * rate, which is far cheaper than the alternative being wrong.
 */
export interface Drag {
    readonly kind: 'move' | 'clone' | 'extrude'
    /** The document and the selection as they were when the pointer went down. */
    readonly volume: Volume
    readonly selection: Selection
    /** The cell under the cursor at the start, on the plane of the face that was grabbed. */
    readonly from: Cell
    readonly axis: number
    readonly layer: number
    readonly face: number
    /** Pointer position at the start, for the extrude drag, which measures along the normal. */
    readonly x: number
    readonly y: number
}

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

/** A rubber band while the pointer is down, in the viewport's own pixels. */
export interface Band {
    readonly x0: number
    readonly y0: number
    readonly x1: number
    readonly y1: number
    readonly width: number
    readonly height: number
}

/**
 * A stroke in progress: one draft, and the layer it is pinned to.
 *
 * The layer is decided by the first click and never re-picked, which is what stops a drag climbing
 * towards the camera over the voxels it is laying down. See `pickPlane`.
 */
export interface Stroke {
    readonly draft: Draft
    /**
     * The document the stroke opened on. A figure is redrawn from here on every move — a rectangle
     * that grew by appending would leave every intermediate rectangle behind it.
     */
    readonly base: Volume
    /** Where the pointer went down. One end of the figure; the cursor is the other. */
    readonly origin: Cell
    /** `0` = x, `1` = y, `2` = z — the axis the drawing plane is perpendicular to. */
    readonly axis: Axis
    readonly layer: number
    /** The face the first click struck, which is what orients a flat brush. */
    readonly face: number
    readonly value: number
    readonly at: Cell
}

export interface AppState {
    readonly volume: Volume
    readonly cameras: readonly NamedCamera[]
    /** Which stored camera the viewport is currently showing, if it still matches one. */
    readonly selected: string | undefined
    /** The camera being dragged along the views strip, if one is — `FEATURESET.md` §16. */
    readonly dragging: string | undefined
    readonly orbit: OrbitState
    /** Which of the four maps the viewport draws — the same enum the shader takes. */
    readonly map: number
    /** Edge of one sprite in the sheet, in pixels. */
    readonly cell: number
    /** Transparent pixels between cells and around the sheet — `FEATURESET.md` §16. */
    readonly padding: number
    /** Whether the metadata JSON carries each sprite's opaque box — `FEATURESET.md` §37. */
    readonly bounds: boolean
    /** Presets the artist saved, on top of the built-in ones — `FEATURESET.md` §38. */
    readonly presets: readonly {name: string; maps: readonly SheetMap[]}[]
    /**
     * Edge of the sprite the Renders panel previews, in pixels — `FEATURESET.md` §15.
     *
     * Its own number rather than the sheet's `cell`, because the question the preview answers is
     * "does this detail survive 16 px", and answering it must not change what gets exported.
     */
    readonly preview: number
    readonly sheet: Sheet | undefined
    /**
     * Set by `bake`, cleared by `written`. Baking and writing the files are two different things —
     * a sheet can exist because the last export made it — so "the user has just asked for files"
     * has to be a fact in the state rather than something the click handler remembers.
     */
    readonly exporting: boolean
    readonly serial: number

    /** Diffs, not volumes — see `doc/history.ts`. */
    readonly history: History
    /** Non-`undefined` for exactly as long as the pointer is down on a writing tool. */
    readonly stroke: Stroke | undefined
    /** Which voxels the next transform will move — see `doc/selection.ts`. */
    readonly selection: Selection
    /** Non-`undefined` while a rubber band is being dragged over the picture. */
    readonly band: Band | undefined
    /** Non-`undefined` while voxels are being dragged — moved, cloned or pulled. */
    readonly drag: Drag | undefined
    /** Draw-time mirroring. Writes real voxels as the stroke happens — see `doc/symmetry.ts`. */
    readonly symmetry: Symmetry
    /** The flat list of named objects over the one grid — see `doc/objects.ts`. */
    readonly objects: Objects
    /** What the objects panel's search box holds. Chrome, not document. */
    readonly search: string
    /**
     * Lock drawing to one plane of the grid rather than to the face under the cursor
     * (`FEATURESET.md` §5). `undefined` is the default: the face you click is the canvas.
     */
    readonly plane: Axis | undefined
    /** What Copy took, as offsets from the corner of what was selected, plus that corner. */
    readonly clipboard: Clipboard | undefined

    readonly tool: Tool
    readonly brush: Brush
    /** 1-based index into `volume.palette`, the `.vox` format's own convention. */
    readonly color: number
    /** The last few colours loaded, most recent first — `FEATURESET.md` §7. */
    readonly recent: readonly number[]
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
    readonly grid: boolean
    readonly snap: boolean
    readonly workspace: 'model' | 'render'
    readonly preset: string
    readonly fps: number
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
    | {type: 'search'; query: string}
    | {type: 'select'; id: string}
    | {type: 'directions'; count: number}
    | {type: 'align'}
    | {type: 'capture'}
    | {type: 'duplicate'}
    | {type: 'delete'; id: string}
    | {type: 'map'; map: number}
    | {type: 'cell'; cell: number}
    | {type: 'preview'; size: number}
    | {type: 'padding'; padding: number}
    | {type: 'bounds'; on: boolean}
    | {type: 'save-preset'; name: string; maps: readonly SheetMap[]}
    | {type: 'drop-preset'; name: string}
    | {type: 'reorder-camera'; id: string; to: number}
    | {type: 'drag-camera'; id: string | undefined}
    | {type: 'bake'}
    | {type: 'written'}
    | {type: 'tool'; tool: Tool}
    | {type: 'brush'; brush: Partial<Brush>}
    | {type: 'color'; color: number}
    | {type: 'emissive'; color: number; value: number}
    | {type: 'palette-color'; color: number; css: string}
    | {type: 'palette-lock'; on: boolean}
    | {type: 'palette-add'}
    | {type: 'palette-load'; text: string}
    | {type: 'replace-color'; from: number; to: number}
    | {type: 'grid'; on: boolean}
    | {type: 'snap'; on: boolean}
    | {type: 'workspace'; workspace: 'model' | 'render'}
    | {type: 'preset'; preset: string}
    | {type: 'fps'; fps: number}

/**
 * The export presets of `docs/editor.png` — `FEATURESET.md` §38.
 *
 * A preset is a name for a set of export choices, and the choice that matters today is which maps
 * get written. All six come off one render and cost nothing to *have*; what they cost is six PNG
 * encodes and six files in the downloads folder, and most engines want two. Godot's 2D lighting
 * reads a normal map and adds emission on top, so that preset writes three.
 */
export const PRESETS = [
    {name: 'Sprite Sheet (Auto)', maps: ['color', 'normal']},
    {name: 'Godot 8-direction', maps: ['color', 'normal', 'emission']},
    {name: 'Indexed colour', maps: ['color', 'index']},
    {name: 'Every map', maps: [...SHEET_MAPS]}
] as const satisfies readonly {name: string; maps: readonly SheetMap[]}[]

export const presetMaps = (state: AppState, name: string): readonly SheetMap[] =>
    [...PRESETS, ...state.presets].find(entry => entry.name === name)?.maps ?? PRESETS[0].maps

/** Built-in and saved, in the order the selector lists them. */
export const allPresets = (
    state: AppState
): readonly {name: string; maps: readonly SheetMap[]}[] => [...PRESETS, ...state.presets]

/**
 * The three-quarter view, not the front one. A straight-on elevation of a voxel model is a
 * rectangle: a legitimate sprite, and the one angle where nothing on screen says the thing is
 * solid — so it is the wrong view to open a 3D tool on.
 */
const opening = (cameras: readonly NamedCamera[]): NamedCamera | undefined =>
    cameras[1] ?? cameras[0]

export const initialState = (volume: Volume): AppState => {
    const cameras = eightDirections(volume)
    const first = opening(cameras)
    return {
        volume,
        cameras,
        selected: first?.id,
        dragging: undefined,
        orbit: {
            camera: first?.camera ?? createCamera(volume, 0, ISOMETRIC_PITCH),
            gesture: undefined
        },
        map: MODE_COLOR,
        cell: 64,
        padding: 0,
        bounds: false,
        presets: [],
        preview: 64,
        sheet: undefined,
        exporting: false,
        serial: 0,
        history: EMPTY_HISTORY,
        stroke: undefined,
        selection: EMPTY_SELECTION,
        band: undefined,
        drag: undefined,
        symmetry: NO_SYMMETRY,
        objects: initialObjects(volume),
        search: '',
        plane: undefined,
        clipboard: undefined,
        tool: 'draw',
        brush: {kind: 'voxel', size: 2, shape: 'square', figure: 'free'},
        color: firstColor(volume),
        recent: [firstColor(volume)],
        paletteLocked: false,
        grid: true,
        snap: true,
        workspace: 'model',
        preset: PRESETS[0].name,
        fps: 24,
        frame: 1
    }
}

const withCamera = (state: AppState, camera: Camera, selected: string | undefined): AppState => ({
    ...state,
    selected,
    orbit: {camera, gesture: undefined}
})

/**
 * The volume as it now stands mid-stroke: a fresh identity over the draft's own buffer.
 *
 * React and the GL uploader both watch identity, and the draft's buffer is mutated in place, so
 * without the new wrapper a stroke would be invisible until the pointer came up. Copying the bytes
 * instead would be a megabyte a mouse-move on a large model, for a copy nothing reads.
 */
const live = (draft: Draft): Volume => ({...draft.volume})

/**
 * The grid as the artist sees it: hidden objects emptied out of it.
 *
 * Everything that renders, picks or exports goes through here, so what is on screen is what can be
 * clicked and what gets written. It returns the volume itself when nothing is hidden, which is the
 * usual case and the reason this is cheap enough to call per pointer event.
 */
const visible = (state: AppState): Volume => shownVolume(state.volume, state.objects)

/** A draft that knows which object new voxels join and which objects refuse to be touched. */
const open = (state: AppState, volume: Volume = state.volume): Draft =>
    beginEdit(volume, state.objects.active, lockedIds(state.objects))

/**
 * Every cell of a stroke, plus every image of every cell.
 *
 * Cells, not stamp centres. An even-sized brush grows towards `+`, so it is not its own mirror
 * image and reflecting where it was stamped leaves the reflection one voxel over — a seam down the
 * middle of the model. Reflecting the cells themselves is exact for every brush and for the radial
 * quarter turn as well, which swaps the x and y axes a flat footprint lies in.
 */
const mirrored = (state: AppState, cells: readonly Offset[]): readonly Offset[] => {
    const maps = symmetryMaps(state.volume, state.symmetry)
    if (maps.length === 1) return cells
    return maps.flatMap(map => cells.map(map))
}

const beginStroke = (state: AppState, event: ViewportPointer): AppState => {
    const {tool, color, brush} = state
    // A viewport with no size has no pixels to cast a ray through, and `zoom / 0` would send one
    // off to infinity. happy-dom reports exactly this, so it is a real case and not a guard.
    if (event.height <= 0 || event.width <= 0) return state
    // Picked against what is on screen: a hidden object is not something the cursor can land on.
    const volume = visible(state)
    const basis = basisFor(state.orbit.camera, volume, event.height)
    const hit = pick(volume, basis, event.x, event.y, event.width, event.height)
    if (!hit) return state

    // Pick is not an edit and does not open a stroke; it loads the colour and gets out of the way.
    if (tool === 'pick') {
        return hit.value === 0 ?
                state
            :   {...state, color: hit.value, recent: remember(state.recent, hit.value)}
    }

    if (tool === 'fill') {
        const draft = open(state)
        fillRegion(draft, hit.x, hit.y, hit.z, color)
        const edit = commitEdit(draft)
        if (!edit) return state
        return {
            ...state,
            volume: draft.volume,
            history: record(state.history, edit),
            sheet: undefined
        }
    }

    /*
     * `FEATURESET.md` §4, decided one way rather than guessed at every click: Draw writes into the
     * empty cell in front of the face — the cell the artist is pointing at across the surface —
     * and Alt writes into the voxel itself, which is Paint. Erase always means the voxel itself.
     * Nothing here inspects what colour is already there, because a tool whose meaning depends on
     * the model under the cursor is a tool the artist cannot aim.
     */
    const outward = tool === 'draw' && !event.alt
    const cell = outward ? hit.place : ([hit.x, hit.y, hit.z] as const)
    // The floor is a surface to draw on, not a voxel to recolour or rub out.
    if (!outward && hit.value === 0) return state

    const value = tool === 'erase' ? 0 : color
    const draft = open(state)
    /*
     * With no plane lock the canvas is the face that was clicked — `FEATURESET.md` §5's "click a
     * face to temporarily make it your canvas", which falls out of the stroke pinning to a layer.
     * With a lock it is that plane of the grid, at whatever layer the click landed on, so drawing
     * stays flat across a surface that is not.
     */
    const axis = state.plane ?? faceAxis(hit.face)
    const face = state.plane === undefined ? hit.face : axis * 2 + 1
    writeCells(draft, mirrored(state, strokeCells(brush, face, cell, cell)), value)
    return {
        ...state,
        volume: live(draft),
        stroke: {
            draft,
            base: state.volume,
            origin: cell,
            axis,
            layer: cell[axis],
            face,
            value,
            at: cell
        },
        sheet: undefined
    }
}

const continueStroke = (state: AppState, event: ViewportPointer): AppState => {
    const {stroke} = state
    if (!stroke) return state
    const basis = basisFor(state.orbit.camera, state.volume, event.height)
    const cell = pickPlane(
        basis,
        event.x,
        event.y,
        event.width,
        event.height,
        stroke.axis,
        stroke.layer
    )
    if (!cell) return state
    const [x, y, z] = cell
    if (x === stroke.at[0] && y === stroke.at[1] && z === stroke.at[2]) return state

    /*
     * Freehand appends to the draft it already has. A figure is redrawn from the document the
     * stroke opened on, because a rectangle that grew by appending would leave every intermediate
     * rectangle behind it — and because dragging back the way you came has to shrink the figure,
     * which appending cannot do.
     */
    if (state.brush.figure === 'free') {
        const cells = strokeCells(state.brush, stroke.face, stroke.at, cell)
        writeCells(stroke.draft, mirrored(state, cells), stroke.value)
        return {...state, volume: live(stroke.draft), stroke: {...stroke, at: cell}}
    }

    const draft = open(state, stroke.base)
    const cells = figureCells(state.brush.figure, stroke.origin, cell, stroke.axis).flatMap(spot =>
        strokeCells(state.brush, stroke.face, spot, spot)
    )
    writeCells(draft, mirrored(state, cells), stroke.value)
    return {...state, volume: live(draft), stroke: {...stroke, draft, at: cell}}
}

/**
 * `FEATURESET.md` §31's four gestures, on one click.
 *
 * Click a voxel takes the voxel; double-click takes its connected colour; Alt-click takes the whole
 * connected solid. A click on air starts a rubber band instead — the only reading of a drag over
 * nothing that does not throw the current selection away by accident.
 */
const beginSelect = (state: AppState, event: ViewportPointer): AppState => {
    if (event.height <= 0 || event.width <= 0) return state
    const volume = visible(state)
    const basis = basisFor(state.orbit.camera, volume, event.height)
    const hit = pickRay(volume, basis, event.x, event.y, event.width, event.height)
    if (!hit) {
        return {
            ...state,
            band: {
                x0: event.x,
                y0: event.y,
                x1: event.x,
                y1: event.y,
                width: event.width,
                height: event.height
            }
        }
    }

    /*
     * The Scale tool pulls a surface. What it grabs is the patch under the cursor rather than the
     * standing selection, because a pull is aimed at a face and the artist is pointing at one.
     */
    if (state.tool === 'scale') {
        const patch = facePatch(volume, hit.x, hit.y, hit.z, FACE_STEP[hit.face] ?? [0, 0, 0])
        return {
            ...state,
            selection: patch,
            drag: {
                kind: 'extrude',
                volume: state.volume,
                selection: patch,
                from: [hit.x, hit.y, hit.z],
                axis: faceAxis(hit.face),
                layer: hit[AXIS_KEYS[faceAxis(hit.face)]],
                face: hit.face,
                x: event.x,
                y: event.y
            }
        }
    }

    /*
     * Selecting and dragging are the same gesture. A press picks what is under the cursor, and if
     * the pointer then moves, that is what gets carried — so moving one voxel is one gesture rather
     * than click, then aim again, then drag. A press that never moves writes nothing and commits
     * nothing, because the move only fires when the cell under the cursor changes.
     *
     * Pressing on a voxel that is *already* selected keeps the whole selection instead of collapsing
     * it to one cell, which is what makes a rubber-banded group draggable.
     */
    const already = state.selection.has(voxelIndex(state.volume, hit.x, hit.y, hit.z))
    // Alt now means the *named* object, not the connected solid: with a list of objects to point
    // at, `FEATURESET.md` §31's "modifier-click = whole object" has an exact answer, and two
    // pieces of one object that do not touch are still one object.
    const owned = ownerAt(state.volume, hit.x, hit.y, hit.z)
    const selection =
        event.clicks >= 2 ? selectConnectedColor(volume, hit.x, hit.y, hit.z)
        : event.alt && owned !== 0 ? objectCells(state.volume, owned)
        : event.alt ? selectObject(volume, hit.x, hit.y, hit.z)
        : already ? state.selection
        : selectVoxel(volume, hit.x, hit.y, hit.z)

    const axis = faceAxis(hit.face)
    return {
        ...state,
        selection,
        band: undefined,
        drag: {
            kind: state.tool === 'clone' ? 'clone' : 'move',
            volume: state.volume,
            selection,
            // The plane of the face that was grabbed: dragging follows the surface under the hand.
            from: [hit.x, hit.y, hit.z],
            axis,
            layer: hit[AXIS_KEYS[axis]],
            face: hit.face,
            x: event.x,
            y: event.y
        }
    }
}

const AXIS_KEYS = ['x', 'y', 'z'] as const

/**
 * How many voxels along the face normal a pointer has travelled.
 *
 * A world step of one voxel along `n` moves the picture by `n · right` and `-n · up` voxels, which
 * is that over `scale` in pixels. Projecting the pointer's travel back onto that direction is the
 * least-squares answer, and rounding it is what makes a pull land on whole layers. Edge-on to the
 * normal there is no answer, and the pull does nothing rather than something arbitrary.
 */
const layersPulled = (state: AppState, drag: Drag, event: ViewportPointer): number => {
    const basis = basisFor(state.orbit.camera, drag.volume, event.height)
    const step = FACE_STEP[drag.face] ?? [0, 0, 0]
    const along = step[0] * basis.right[0] + step[1] * basis.right[1] + step[2] * basis.right[2]
    const over = -(step[0] * basis.up[0] + step[1] * basis.up[1] + step[2] * basis.up[2])
    const squared = along * along + over * over
    if (squared < 1e-6) return 0
    const dx = event.x - drag.x
    const dy = event.y - drag.y
    return Math.round(((dx * along + dy * over) * basis.scale) / squared)
}

const continueDrag = (state: AppState, event: ViewportPointer): AppState => {
    const {drag} = state
    if (!drag) return state
    const draft = open(state, drag.volume)

    if (drag.kind === 'extrude') {
        const layers = layersPulled(state, drag, event)
        if (layers === 0) {
            return {...state, volume: drag.volume, selection: drag.selection}
        }
        const face = extrudeCells(draft, drag.selection, FACE_STEP[drag.face] ?? [0, 0, 0], layers)
        return {...state, volume: draft.volume, selection: face, sheet: undefined}
    }

    const basis = basisFor(state.orbit.camera, drag.volume, event.height)
    const cell = pickPlane(
        basis,
        event.x,
        event.y,
        event.width,
        event.height,
        drag.axis,
        drag.layer
    )
    if (!cell) return state
    const delta: Cell = [cell[0] - drag.from[0], cell[1] - drag.from[1], cell[2] - drag.from[2]]
    if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0) {
        return {...state, volume: drag.volume, selection: drag.selection}
    }
    const selection =
        drag.kind === 'clone' ?
            duplicateCells(draft, drag.selection, delta)
        :   moveCells(draft, drag.selection, delta)
    return {...state, volume: draft.volume, selection, sheet: undefined}
}

const endDrag = (state: AppState): AppState => {
    const {drag} = state
    if (!drag) return state
    // The document already shows the result, so the commit is only about the history: replay the
    // whole gesture once against the volume it started from and record that as one diff.
    const draft = open(state, drag.volume)
    draft.volume.data.set(state.volume.data)
    draft.volume.owner.set(state.volume.owner)
    for (let i = 0; i < draft.volume.data.length; i += 1) {
        const was = drag.volume.data[i] ?? 0
        const owned = drag.volume.owner[i] ?? 0
        if (was === (draft.volume.data[i] ?? 0) && owned === (draft.volume.owner[i] ?? 0)) continue
        draft.before.set(i, was)
        draft.beforeOwner.set(i, owned)
    }
    const edit = commitEdit(draft)
    return {
        ...state,
        drag: undefined,
        history: edit ? record(state.history, edit) : state.history
    }
}

const endBand = (state: AppState): AppState => {
    const {band} = state
    if (!band) return state
    const basis = basisFor(state.orbit.camera, state.volume, band.height)
    // A band that never moved is a click on air, and a click on air deselects.
    const moved = Math.abs(band.x1 - band.x0) > 1 || Math.abs(band.y1 - band.y0) > 1
    return {
        ...state,
        band: undefined,
        selection:
            moved ? selectRect(state.volume, basis, band, band.width, band.height) : EMPTY_SELECTION
    }
}

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

const endStroke = (state: AppState): AppState => {
    const {stroke} = state
    if (!stroke) return state
    const edit = commitEdit(stroke.draft)
    return {
        ...state,
        stroke: undefined,
        history: edit ? record(state.history, edit) : state.history
    }
}

export const reduce = (state: AppState, action: AppAction): AppState => {
    switch (action.type) {
        case 'orbit': {
            const orbit = applyOrbit(state.orbit, action.event, action.height, state.snap)
            if (orbit === state.orbit) return state
            // Once the view has moved it is no longer the stored camera, and saying so is the
            // difference between a list of cameras and a list of bookmarks that quietly lie.
            const moved = orbit.camera !== state.orbit.camera
            return {...state, orbit, selected: moved ? undefined : state.selected}
        }

        /*
         * One entry point for the viewport, so the choice between moving the camera and writing
         * voxels is made in the tested pure function rather than in a JSX handler. The right and
         * middle buttons and Shift always move the camera, whatever is armed — otherwise arming
         * Draw would cost the artist the ability to look at what they are drawing.
         */
        case 'pointer': {
            const {event} = action
            if (event.type === 'down') {
                if (event.button === 0 && !event.shift) {
                    if (WRITES.has(state.tool)) return beginStroke(state, event)
                    if (SELECTS.has(state.tool)) return beginSelect(state, event)
                }
                return reduce(state, {
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
            if (state.stroke) {
                return event.type === 'move' ? continueStroke(state, event) : endStroke(state)
            }
            if (state.band) {
                return event.type === 'move' ?
                        {...state, band: {...state.band, x1: event.x, y1: event.y}}
                    :   endBand(state)
            }
            if (state.drag) {
                return event.type === 'move' ? continueDrag(state, event) : endDrag(state)
            }
            return reduce(state, {
                type: 'orbit',
                event:
                    event.type === 'move' ?
                        {type: 'pointermove', x: event.x, y: event.y}
                    :   {type: 'pointerup'},
                height: event.height
            })
        }

        case 'undo': {
            // Mid-stroke there is nothing coherent to undo *to*: the draft is not an edit yet.
            if (state.stroke) return state
            const back = undo(state.volume, state.history)
            return back ? {...state, ...back, sheet: undefined} : state
        }

        case 'redo': {
            if (state.stroke) return state
            const forward = redo(state.volume, state.history)
            return forward ? {...state, ...forward, sheet: undefined} : state
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
            const draft = open(state)
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
            const edit = commitEdit(draft)
            if (!edit) return state
            return {
                ...state,
                volume: draft.volume,
                selection,
                history: record(state.history, edit),
                sheet: undefined
            }
        }

        case 'plane':
            return {...state, plane: action.axis}

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
            const draft = open(state)
            // One voxel up from where it was copied. Pasting exactly on top of the original looks
            // like nothing happened, and the copy comes back selected so it can be dragged.
            const selection = pasteCells(draft, clipboard.cells, [
                clipboard.at[0],
                clipboard.at[1],
                clipboard.at[2] + 1
            ])
            const edit = commitEdit(draft)
            if (!edit) return state
            return {
                ...state,
                volume: draft.volume,
                selection,
                history: record(state.history, edit),
                sheet: undefined
            }
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
                case 'active':
                    return {...state, objects: {...objects, active: op.id}}
                case 'rename':
                    return {...state, objects: renameObject(objects, op.id, op.name)}
                case 'hidden':
                    // The sheet was baked from what was on screen, and that has just changed.
                    return {
                        ...state,
                        objects: setHidden(objects, op.id, op.on),
                        sheet: undefined
                    }
                case 'locked':
                    return {...state, objects: setLocked(objects, op.id, op.on)}
                case 'solo':
                    return {...state, objects: soloObject(objects, op.id), sheet: undefined}
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
                    const edit = commitEdit(draft)
                    return {
                        ...state,
                        objects: list,
                        volume: edit ? draft.volume : state.volume,
                        selection: EMPTY_SELECTION,
                        history: edit ? record(state.history, edit) : state.history,
                        sheet: undefined
                    }
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
            return {
                ...state,
                selected: undefined,
                orbit: {
                    camera: focusOn(state.orbit.camera, state.volume, box),
                    gesture: undefined
                }
            }
        }

        case 'search':
            return {...state, search: action.query}

        case 'symmetry': {
            if (action.axis === 'radial' && !canRadial(state.volume)) return state
            return {...state, symmetry: {...state.symmetry, [action.axis]: action.on}}
        }

        case 'select': {
            const found = state.cameras.find(({id}) => id === action.id)
            return found ? withCamera(state, found.camera, found.id) : state
        }

        case 'directions': {
            const cameras = directions(state.volume, action.count)
            const first = opening(cameras)
            return withCamera(
                {...state, cameras, sheet: undefined},
                first?.camera ?? state.orbit.camera,
                first?.id
            )
        }

        case 'capture': {
            const serial = state.serial + 1
            const added = captureCamera(state.orbit.camera, serial)
            return {
                ...state,
                serial,
                cameras: [...state.cameras, added],
                selected: added.id,
                sheet: undefined
            }
        }

        /*
         * The mockup's second camera-header button. It copies the transform rather than pointing at
         * it, because two entries sharing one camera object is an instance, and instances are on the
         * postponed list in `docs/FEATURESET.md` §11.
         */
        case 'duplicate': {
            const source = state.cameras.find(({id}) => id === state.selected)
            if (!source) return state
            const serial = state.serial + 1
            const added = {
                id: `cam-${String(serial)}`,
                name: `${source.name} copy`,
                camera: source.camera
            }
            return {
                ...state,
                serial,
                cameras: [...state.cameras, added],
                selected: added.id,
                sheet: undefined
            }
        }

        case 'delete': {
            const cameras = state.cameras.filter(({id}) => id !== action.id)
            if (cameras.length === state.cameras.length) return state
            return {
                ...state,
                cameras,
                selected: state.selected === action.id ? undefined : state.selected,
                sheet: undefined
            }
        }

        case 'map':
            return {...state, map: action.map}

        case 'cell':
            return {...state, cell: action.cell, sheet: undefined}

        case 'preview':
            return {...state, preview: action.size}

        case 'padding':
            return {...state, padding: Math.max(0, Math.round(action.padding)), sheet: undefined}

        case 'bounds':
            // Only the JSON changes, so the baked sheet is still good.
            return {...state, bounds: action.on}

        /*
         * A preset the artist saved — `FEATURESET.md` §38. Saving over one that exists replaces it,
         * because two presets with one name is a list nobody can use, and the artist who typed the
         * same name twice meant the second one.
         */
        case 'save-preset': {
            const name = action.name.trim()
            if (name === '' || PRESETS.some(entry => entry.name === name)) return state
            const kept = state.presets.filter(entry => entry.name !== name)
            return {...state, presets: [...kept, {name, maps: action.maps}], preset: name}
        }

        case 'drop-preset': {
            const presets = state.presets.filter(entry => entry.name !== action.name)
            if (presets.length === state.presets.length) return state
            return {
                ...state,
                presets,
                preset: state.preset === action.name ? PRESETS[0].name : state.preset
            }
        }

        /*
         * Reordering the camera list is reordering the *sheet*: the cells are laid out in list
         * order, so this is `FEATURESET.md` §16's "drag to reorder" and it invalidates the bake.
         */
        case 'drag-camera':
            return {...state, dragging: action.id}

        case 'reorder-camera': {
            const from = state.cameras.findIndex(({id}) => id === action.id)
            if (from < 0 || from === action.to) return state
            const cameras = [...state.cameras]
            const [taken] = cameras.splice(from, 1)
            if (!taken) return state
            cameras.splice(Math.max(0, Math.min(cameras.length, action.to)), 0, taken)
            return {...state, cameras, sheet: undefined}
        }

        case 'bake':
            return {
                ...state,
                exporting: true,
                // Baked from what is on screen: a hidden object is hidden in the export too, which
                // is what makes hiding a way to render one piece of a model on its own.
                sheet: renderSheet(
                    visible(state),
                    state.cameras,
                    state.cell,
                    presetMaps(state, state.preset),
                    state.padding
                )
            }

        case 'written':
            return state.exporting ? {...state, exporting: false} : state

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
            return {...state, volume: {...state.volume, palette}, sheet: undefined}
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
            return {...state, volume: {...state.volume, palette}, sheet: undefined}
        }

        case 'replace-color': {
            const draft = open(state)
            if (remapColor(draft, action.from, action.to) === 0) return state
            const edit = commitEdit(draft)
            if (!edit) return state
            return {
                ...state,
                volume: draft.volume,
                color: action.to,
                recent: remember(state.recent, action.to),
                history: record(state.history, edit),
                sheet: undefined
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
            return {...state, volume: {...state.volume, emissive}, sheet: undefined}
        }

        case 'grid':
            return {...state, grid: action.on}

        case 'snap':
            return {...state, snap: action.on}

        case 'workspace':
            return {...state, workspace: action.workspace}

        case 'preset':
            return {...state, preset: action.preset}

        case 'fps':
            return {...state, fps: action.fps}
    }
}
