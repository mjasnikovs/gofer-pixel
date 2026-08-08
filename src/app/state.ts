import {
    faceAxis,
    MAX_BRUSH,
    SHAPES,
    type Axis,
    type Brush,
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
import {
    beginEdit,
    commitEdit,
    connected,
    fillRegion,
    NO_CELLS,
    strokeCells,
    writeCells,
    writeOwned,
    type Draft
} from '../doc/edits'
import {figureCells} from '../doc/figures'
import {
    addObject,
    duplicateOffset,
    initialObjects,
    lockedIds,
    moveObject,
    objectAt,
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
import {
    EMPTY_HISTORY,
    record,
    redo,
    undo,
    type History,
    type Step as HistoryStep
} from '../doc/history'
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
import {clampLayer, layerCount, slicedVolume} from '../doc/slice'
import {canRadial, NO_SYMMETRY, symmetryMaps, type Symmetry} from '../doc/symmetry'
import {
    arrayCells,
    deleteCells,
    duplicateCells,
    lossCount,
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
import {voxelAt, voxelIndex, type Volume} from '../render/volume'
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
export {MAX_BRUSH, SHAPES}
export type {Brush, Shape}

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
 * The tools that read the brush — its size, its shape and its figure.
 *
 * Only the two that stamp a footprint. Fill floods a region, Pick samples one voxel, and the four
 * grab tools work on a selection; none of them consults the brush, so the panel greys those three
 * controls out rather than letting the artist set a size that quietly does nothing. Exported so the
 * panel and the stroke below cannot drift apart about which tools those are.
 */
export const USES_BRUSH: ReadonlySet<Tool> = new Set<Tool>(['draw', 'erase'])

/**
 * Every tool that does something with the left button, and therefore every tool that owes the artist
 * a picture of what that something is before they commit to it.
 *
 * Measure is the only one missing, because it is not built: arming it leaves the button to the
 * camera, and previewing a gesture that does not exist would be the worst lie of the lot.
 */
const AIMS: ReadonlySet<Tool> = new Set<Tool>([...WRITES, ...SELECTS])

/**
 * How many cells the overlay will draw one cube each for, before it gives up and draws the box.
 *
 * Measured, in `bun test` under happy-dom, by rendering `BrushGhost` at sizes from 64 to 14 000
 * cells: the cost is linear at 10 µs a cell from 500 cells up, so 512 is about 5 ms — one pointer
 * move's worth, and the number stays honest on the slow side of the 14× spread `CLAUDE.md` records
 * for a busy GPU.
 *
 * 512 is also exactly the largest brush there is, a `MAX_BRUSH` cube, so the brush panel on its own
 * can never push the ghost over. What does push it over is a flood fill, a whole object, or that
 * same cube under eight-way symmetry — answers that are a region rather than a footprint, and that
 * read better as a box than as four thousand wireframed cubes would.
 */
export const GHOST_CELLS = 512

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
    readonly kind: 'move' | 'clone' | 'extrude' | 'turn'
    /** The document and the selection as they were when the pointer went down. */
    readonly volume: Volume
    readonly selection: Selection
    /** The cell under the cursor at the start, on the plane of the face that was grabbed. */
    readonly from: Cell
    readonly axis: number
    readonly layer: number
    readonly face: number
    /**
     * Pointer position at the start, for the two drags that measure the hand rather than the grid:
     * the extrude, which projects onto the normal, and the turn, which counts sideways pixels.
     */
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

/**
 * A picture to build against — `FEATURESET.md` §33.
 *
 * One per plane, stretched to the grid's own box in that plane, so an artist who drew a 32×32 front
 * view gets it lined up with a 32-wide model without doing arithmetic. It is a `data:` URL rather
 * than a path, because a document that referred to a file on disk would open blank on the next
 * machine, and it is not part of the model: nothing here is ever rendered into a sprite.
 */
export interface Reference {
    readonly plane: Axis
    readonly url: string
    readonly opacity: number
    /** Locked means the panel will not change or drop it — `FEATURESET.md` §33's "lock it". */
    readonly locked: boolean
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

/**
 * What kind of change the press would be, which is what the overlay draws it as.
 *
 * The kind rather than the tool, because eight tools make five kinds of promise and the overlay
 * should be answering "what is about to happen here" rather than "which button is lit". Two tools
 * that do the same thing to the voxels — Move and Rotate both pick a selection up — have no
 * business looking different before the press.
 */
export type HoverKind =
    /** Voxels appear, in the loaded colour. Draw. */
    | 'write'
    /** Voxels go. Erase. */
    | 'clear'
    /** Voxels that are already there change colour. Fill. */
    | 'recolour'
    /** Nothing changes in the grid; a colour comes back out of it. Pick. */
    | 'sample'
    /** Nothing changes yet; these are the voxels the gesture takes hold of. Move, Rotate, Scale, Clone. */
    | 'grab'

/**
 * Where the next click would land, computed on every pointer move that is not already a gesture.
 *
 * It is not a hint and not an approximation: every tool's answer comes out of the same function the
 * press itself uses — `strokeCells` and the symmetry maps for Draw and Erase, `connected` for Fill,
 * `pressSelection` for the four that take hold of voxels — so the outline on screen cannot disagree
 * with the edit it is previewing. Without it the artist aims a one-voxel brush at a 3-pixel voxel
 * and finds out where it went afterwards — and finds out nothing at all when the answer is
 * `blocked`.
 */
export interface Hover {
    /** The cell the click would write into: in front of the face for Draw, the voxel for the rest. */
    readonly cell: Cell
    /** What the press would do to the voxels below, which is what the overlay draws. */
    readonly kind: HoverKind
    /** The face the ray struck, which is what a flat brush lies in. */
    readonly face: number
    /**
     * The grid plane the outline is drawn on, along the face's own axis.
     *
     * Decided here rather than in the overlay, because it is not the same side of the cell for every
     * tool: Draw aims at the empty cell in front of the surface and wants the near side of it, Erase
     * and Paint aim at the voxel itself and want its outer side. Both are the *struck face* — one
     * plane, arrived at from the two directions the tools approach it from.
     */
    readonly surface: number
    /**
     * Every cell the press acts on, mirrors included, as triples — which is what the overlay draws
     * one cube per. May be empty because all of them are off-grid, and may be empty because there
     * are more than `GHOST_CELLS` of them; `region` and `bounds` are the answer in that case.
     *
     * Triples rather than the flat indices `region` uses, because a brush hanging over the edge of
     * the grid has cells at negative coordinates and no index can hold one. That overhang is
     * exactly what `blocked` is reporting, so it has to survive as far as the screen.
     */
    readonly cells: readonly Offset[]
    /**
     * The same answer as flat cell indices, for the tools whose answer has no size limit: a fill can
     * be the whole grid and a grab can be a whole object. Undefined for Draw, Erase and Pick, whose
     * footprint is the brush and is never larger than `MAX_BRUSH` cubed.
     *
     * Indices rather than triples so a two-million-cell region costs one integer each instead of one
     * array each, and so `previewVolume` can write it straight into the grid.
     */
    readonly region: Selection | undefined
    /** The integer box the whole answer occupies, so a footprint too big to draw still says where it is. */
    readonly bounds: {min: Cell; max: Cell} | undefined
    /**
     * The palette index the proposal should be drawn in, or `undefined` for the kinds that put no
     * paint anywhere. Draw and Fill propose the loaded colour; Pick proposes the colour it would
     * take *out* of the model, which is not the loaded one and must not be drawn as though it were.
     */
    readonly paint: number | undefined
    /**
     * The press would change nothing — the brush is entirely off the grid, the voxels are locked, or
     * they already hold exactly what is about to be written. A press there is silent, so the outline
     * has to say it before the press rather than after.
     */
    readonly blocked: boolean
}

export interface AppState {
    readonly volume: Volume
    readonly cameras: readonly NamedCamera[]
    /** Which stored camera the viewport is currently showing, if it still matches one. */
    readonly selected: string | undefined
    /**
     * Which camera the render panel previews. The last one that was actually picked, and orbiting
     * does not clear it.
     *
     * `selected` cannot do this job. It answers "is the view still this camera", so the first
     * mouse-drag has to unset it or the views strip highlights a lie. The panel is asking a
     * different question — "which camera am I inspecting the maps of" — and that answer should
     * outlive a nudge of the view.
     */
    readonly previewed: string | undefined
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
    /** Pixel art to build against, one image per plane — `FEATURESET.md` §33. */
    readonly references: readonly Reference[]
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
    /**
     * How many voxels the drag, as it stands right now, would destroy if it were dropped.
     *
     * Zero when nothing is being dragged. Move and clone overwrite, which is right — refusing would
     * mean never sliding a voxel one step along a surface — but it is the one loss undo cannot make
     * obvious afterwards, because a drop onto air looks exactly like a drop that ate three voxels.
     * Kept on the state rather than worked out by the bar, so the number the artist reads is the
     * number the reducer is about to act on.
     */
    readonly losing: number
    /**
     * The last place the pointer was seen over the viewport, and nothing else. `undefined` once it
     * has left. Kept because `hover` is a function of it *and* of the tool, the brush, the colour
     * and the model — all of which change without the mouse moving.
     */
    readonly aim: ViewportPointer | undefined
    /** Where the next click would go. `undefined` while a gesture owns the pointer, or off the model. */
    readonly hover: Hover | undefined
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
    /**
     * Which layer slice mode is showing, or `undefined` when it is off — `FEATURESET.md` §6.
     *
     * The axis is the plane lock's; slice mode without a plane is a slice of nothing in particular,
     * so switching it on locks the XY plane if nothing is locked yet.
     */
    readonly slice: number | undefined

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
    /**
     * Whether a drag turns the view the other way round — see `viewport/orbit.ts`.
     *
     * Chrome rather than document: it is a fact about the hands at this desk, not about the model,
     * so it is deliberately not in the save file or the undo history.
     */
    readonly invert: boolean
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
    | {type: 'reference'; plane: Axis; url: string}
    | {type: 'reference-opacity'; plane: Axis; opacity: number}
    | {type: 'reference-lock'; plane: Axis; on: boolean}
    | {type: 'reference-drop'; plane: Axis}
    | {type: 'import-image'; volume: Volume; name: string}
    | {type: 'open'; document: OpenedDocument}
    | {type: 'slice'; on: boolean}
    | {type: 'slice-step'; delta: number}
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
    | {type: 'invert'; on: boolean}
    | {type: 'workspace'; workspace: 'model' | 'render'}
    | {type: 'preset'; preset: string}
    | {type: 'fps'; fps: number}
    | {type: 'unaim'}

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

/**
 * A document opened from somewhere other than a `.vox` file — a recovered autosave, which brings
 * its own objects and its own cameras and must not have them regenerated over the top.
 */
export interface OpenedDocument {
    readonly volume: Volume
    readonly objects: Objects
    readonly cameras: readonly NamedCamera[]
}

export const initialState = (source: Volume, opened?: OpenedDocument): AppState => {
    /*
     * Every document opens on a palette worth painting from — see `freshenPalette`. It runs here
     * rather than in the `.vox` reader because it is an editor decision, not a format one: the
     * reader's job is to say what the file holds, and a golden-hash test of the reader must keep
     * getting the file's own bytes back.
     */
    const volume = {...source, palette: freshenPalette(source)}
    const cameras = opened?.cameras.length ? [...opened.cameras] : eightDirections(volume)
    const first = opening(cameras)
    return {
        volume,
        cameras,
        selected: first?.id,
        previewed: first?.id,
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
        references: [],
        preview: 64,
        sheet: undefined,
        exporting: false,
        serial: 0,
        history: EMPTY_HISTORY,
        stroke: undefined,
        selection: EMPTY_SELECTION,
        band: undefined,
        drag: undefined,
        losing: 0,
        aim: undefined,
        hover: undefined,
        symmetry: NO_SYMMETRY,
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
        snap: true,
        invert: false,
        workspace: 'model',
        preset: PRESETS[0].name,
        fps: 24,
        frame: 1
    }
}

const withCamera = (state: AppState, camera: Camera, selected: string | undefined): AppState => ({
    ...state,
    selected,
    previewed: selected ?? state.previewed,
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
const visible = (state: AppState): Volume => {
    const shown = shownVolume(state.volume, state.objects)
    if (state.slice === undefined) return shown
    const axis = state.plane ?? 2
    const {forward} = basisFor(state.orbit.camera, state.volume, 1)
    return slicedVolume(shown, {axis, layer: state.slice}, forward)
}

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

/**
 * Would writing `value` here change anything? The four ways a write is silently dropped, asked in
 * one place — see `writeOwned`, which is where they are actually enforced.
 *
 * Out of bounds, owned by a locked object, or already exactly what is being written. A tool whose
 * click does nothing is not a bug on its own; a tool that gives no sign of it beforehand is.
 */
const wouldWrite = (
    state: AppState,
    locked: ReadonlySet<number>,
    [x, y, z]: Offset,
    value: number
): boolean => {
    const {sx, sy, sz, data, owner} = state.volume
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return false
    const index = voxelIndex(state.volume, x, y, z)
    const wasOwner = owner[index] ?? 0
    if (locked.has(wasOwner)) return false
    const nowOwner = value === 0 ? 0 : state.objects.active
    return (data[index] ?? 0) !== value || wasOwner !== nowOwner
}

/**
 * The grid the *viewport* draws, which is not always the grid the document holds.
 *
 * Two of the five hover kinds change voxels that are already there, and a change to a voxel that is
 * already there cannot be shown by drawing a block over it — the block would be covering the very
 * pixels whose change is the point. So those two are rendered: the grid handed to the viewport is
 * the document with the proposal already applied.
 *
 * - **`clear`.** Erasing into a solid, evenly coloured block is otherwise invisible: measured on
 *   `car.vox`, up to 18 of 41 erases left the clicked pixel byte for byte identical, the voxel
 *   exposed behind carrying the same palette entry and the same face.
 * - **`recolour`.** A fill's whole answer is *which* voxels change, and that answer is a region the
 *   artist has no other way to see. An outline round two thousand cells says where; only the paint
 *   says what.
 *
 * It costs a grid copy per pointer move, which is the same bill a stroke already pays.
 *
 * `write` is deliberately not here. Draw's new voxels sit in empty space, where the translucent
 * block in `BrushGhost` already reads correctly, and painting them into the render would make a
 * proposal look like a fact. `sample` and `grab` change no voxels at all.
 */
export const previewVolume = (state: AppState, shown: Volume): Volume => {
    const {hover} = state
    if (!hover || hover.blocked) return shown
    if (hover.kind === 'clear') {
        const data = new Uint8Array(shown.data)
        for (const [x, y, z] of hover.cells) {
            if (x < 0 || y < 0 || z < 0) continue
            if (x >= shown.sx || y >= shown.sy || z >= shown.sz) continue
            data[voxelIndex(shown, x, y, z)] = 0
        }
        return {...shown, data}
    }
    if (hover.kind === 'recolour' && hover.region) {
        const data = new Uint8Array(shown.data)
        /*
         * Indices, straight in — the region was flooded over the document, which has these same
         * dimensions, so no index can be out of range.
         *
         * Only into cells that are still occupied here. The fill floods the whole document, hidden
         * objects included, but `shown` has emptied those out; writing paint into one would make a
         * hidden voxel appear, which is a bigger lie than not previewing a change nobody can see.
         */
        for (const index of hover.region) if (data[index] !== 0) data[index] = state.color
        return {...shown, data}
    }
    return shown
}

const withHover = (state: AppState, hover: Hover | undefined): AppState =>
    state.hover === undefined && hover === undefined ? state : {...state, hover}

/**
 * Which voxels a press with a selecting tool takes hold of — `FEATURESET.md` §31's four gestures,
 * plus the surface patch a pull grabs.
 *
 * One function, called twice: by `beginSelect` when the button goes down, and by `hoverAt` a moment
 * earlier so the artist sees the answer first. Two copies of this reasoning would be two chances for
 * the outline to promise a selection the press does not make, and the whole point of the outline is
 * that it cannot.
 */
const pressSelection = (
    state: AppState,
    volume: Volume,
    hit: {x: number; y: number; z: number; face: number},
    event: {clicks: number; alt: boolean; ctrl: boolean}
): Selection => {
    /*
     * The Scale tool pulls a surface. What it grabs is the patch under the cursor rather than the
     * standing selection, because a pull is aimed at a face and the artist is pointing at one.
     */
    if (state.tool === 'scale') {
        return facePatch(volume, hit.x, hit.y, hit.z, FACE_STEP[hit.face] ?? [0, 0, 0])
    }
    /*
     * Pressing on a voxel that is *already* selected keeps the whole selection instead of collapsing
     * it to one cell, which is what makes a rubber-banded group draggable.
     */
    const already = state.selection.has(voxelIndex(state.volume, hit.x, hit.y, hit.z))
    // Alt means the *named* object, not the connected solid: with a list of objects to point at,
    // `FEATURESET.md` §31's "modifier-click = whole object" has an exact answer, and two pieces of
    // one object that do not touch are still one object.
    const owned = ownerAt(state.volume, hit.x, hit.y, hit.z)
    const picked =
        event.clicks >= 2 ? selectConnectedColor(volume, hit.x, hit.y, hit.z)
        : event.alt && owned !== 0 ? objectCells(state.volume, owned)
        : event.alt ? selectObject(volume, hit.x, hit.y, hit.z)
        : already && !event.ctrl ? state.selection
        : selectVoxel(volume, hit.x, hit.y, hit.z)

    /*
     * Control adds — `FEATURESET.md` §39's selection, built one piece at a time.
     *
     * Without it a selection can only ever be one click's worth: a press outside what is selected
     * replaces it, which is what every editor does and what an artist assembling two arms and a
     * head out of separate clicks has no answer to. It stacks with the other two, so
     * Control-double-click adds a whole colour and Control-Alt-click adds a whole object.
     *
     * Shift would be the usual key and it is spoken for: Shift always pans, whatever is armed, and
     * a modifier that means "add" over the model and "move the camera" two pixels off it is a
     * modifier nobody can trust.
     */
    if (!event.ctrl || state.selection.size === 0) return picked
    return new Set([...state.selection, ...picked])
}

/**
 * The last region a hover computed, so the pointer moving inside one voxel does not re-flood it.
 *
 * Fill and the grab tools answer with a traversal rather than with a footprint, and a traversal is
 * not free: measured, a 128³ grid of a single colour is 487 ms to flood, of which 200 ms is building
 * the `Set` — so running one per pointer move would be a two-frames-a-second editor on any document
 * that is mostly one paint. A realistic model is microseconds, but "realistic" is not a guarantee.
 *
 * The pointer is in one place at a time, so one entry is the whole cache. `reduce` stays pure: this
 * returns only what recomputing would have returned, and the key holds the identity of every input
 * the answer is derived from, so anything changing is a miss.
 */
interface AimKey {
    readonly tool: Tool
    readonly seed: number
    readonly volume: Volume
    readonly objects: Objects
    readonly selection: Selection
    readonly slice: number | undefined
    readonly plane: Axis | undefined
    readonly camera: Camera
    readonly color: number
    readonly alt: boolean
    readonly ctrl: boolean
    readonly clicks: number
    readonly face: number
}

interface AimAnswer {
    readonly region: Selection
    readonly cells: readonly Offset[]
    readonly bounds: {min: Cell; max: Cell} | undefined
    readonly blocked: boolean
}

let aimed: {key: AimKey; answer: AimAnswer} | undefined

const sameAim = (a: AimKey, b: AimKey): boolean =>
    a.tool === b.tool
    && a.seed === b.seed
    && a.volume === b.volume
    && a.objects === b.objects
    && a.selection === b.selection
    && a.slice === b.slice
    && a.plane === b.plane
    && a.camera === b.camera
    && a.color === b.color
    && a.alt === b.alt
    && a.ctrl === b.ctrl
    && a.clicks === b.clicks
    && a.face === b.face

/** A region as triples, but only when there are few enough for the overlay to draw one cube each. */
const drawable = (volume: Volume, region: Selection): readonly Offset[] =>
    region.size > GHOST_CELLS ? [] : [...region].map(index => cellOf(volume, index))

/**
 * Where the next click would land, decided by the same reasoning the press itself uses.
 *
 * Every branch below is one from `beginStroke` or `beginSelect`, deliberately: which cell Draw aims
 * at, which face orients the brush, what a plane lock and slice mode override, which grid a fill
 * floods and which one a grab selects on. The preview is worth having only for as long as it cannot
 * be more optimistic than the edit.
 *
 * It reads `aim` — the last place the pointer was seen — rather than an event, so that changing the
 * brush, the colour, the tool or the model re-aims without the artist having to jiggle the mouse.
 * `reduce` is what notices those, at the bottom of this file.
 */
const hoverAt = (state: AppState): AppState => {
    const event = state.aim
    if (!event) return withHover(state, undefined)
    // A gesture owns the pointer: a stroke is already showing its own voxels, and an outline that
    // chased an orbit would be aiming at a picture that is still moving.
    if (state.stroke || state.drag || state.band) return withHover(state, undefined)
    if (state.orbit.gesture !== undefined) return withHover(state, undefined)
    if (!AIMS.has(state.tool)) return withHover(state, undefined)
    if (event.height <= 0 || event.width <= 0) return withHover(state, undefined)
    const volume = visible(state)
    const basis = basisFor(state.orbit.camera, volume, event.height)
    const hit = pick(volume, basis, event.x, event.y, event.width, event.height)
    if (!hit) return withHover(state, undefined)

    const outward = state.tool === 'draw' && !event.alt
    const cell: Cell = outward ? hit.place : [hit.x, hit.y, hit.z]
    // The floor is a surface to draw on, and nothing to erase, recolour, sample or take hold of.
    if (!outward && hit.value === 0) return withHover(state, undefined)

    const axis = state.plane ?? faceAxis(hit.face)
    const face = state.plane === undefined ? hit.face : axis * 2 + 1
    /*
     * The struck face, as a plane. Face codes pair up odd-negative, even-positive, so a `+` face
     * sits at the far side of the voxel it belongs to and at the near side of the cell in front of
     * it — which is why `outward` flips the offset rather than the axis.
     */
    const positive = face % 2 === 0
    const surface = cell[axis] + (positive === outward ? 0 : 1)
    const at = {cell, face, surface}
    const locked = lockedIds(state.objects)

    // Pick reads the model and writes nothing, so it proposes the colour it would take out rather
    // than the one that is loaded — and it is blocked when that colour is already the loaded one,
    // which is the one press with this tool that genuinely does nothing.
    if (state.tool === 'pick') {
        return withHover(state, {
            ...at,
            kind: 'sample',
            cells: [cell],
            region: undefined,
            bounds: {min: cell, max: cell},
            paint: hit.value,
            blocked: hit.value === state.color
        })
    }

    if (USES_BRUSH.has(state.tool)) {
        const cells = mirrored(state, strokeCells(state.brush, face, cell, cell))
        const value = state.tool === 'erase' ? 0 : state.color
        return withHover(state, {
            ...at,
            kind: state.tool === 'erase' ? 'clear' : 'write',
            // The whole footprint, off-grid cells included — `blocked` is exactly the report that
            // some of them are, so it is asked before anything is trimmed.
            blocked: !cells.some(spot => wouldWrite(state, locked, spot, value)),
            cells: cells.length > GHOST_CELLS ? [] : cells,
            region: undefined,
            bounds: footprintBox(cells),
            paint: state.tool === 'erase' ? undefined : state.color
        })
    }

    /*
     * Fill and the four grab tools answer with a traversal. Both go through the cache, and both run
     * the traversal against the grid the press will run it against — which is not the same grid for
     * the two of them, and getting that wrong is how a preview starts lying:
     *
     * - **Fill** floods the *document*. `beginStroke` opens a draft over `state.volume`, so a fill
     *   crosses into hidden objects and out of the current slice, and a preview that stopped at the
     *   visible surface would under-promise.
     * - **Grab** selects on the *visible* grid, because a rubber band and a click both mean "what I
     *   can see", and `beginSelect` picks against `visible(state)` for that reason.
     */
    const seed = voxelIndex(state.volume, hit.x, hit.y, hit.z)
    const key: AimKey = {
        tool: state.tool,
        seed,
        volume: state.volume,
        objects: state.objects,
        selection: state.selection,
        slice: state.slice,
        plane: state.plane,
        camera: state.orbit.camera,
        color: state.color,
        alt: event.alt,
        ctrl: event.ctrl,
        clicks: event.clicks,
        face: hit.face
    }
    const answer =
        aimed && sameAim(aimed.key, key) ?
            aimed.answer
        :   solveRegion(state, volume, hit, event, locked)
    aimed = {key, answer}

    return withHover(state, {
        ...at,
        kind: state.tool === 'fill' ? 'recolour' : 'grab',
        cells: answer.cells,
        region: answer.region,
        bounds: answer.bounds,
        paint: state.tool === 'fill' ? state.color : undefined,
        blocked: answer.blocked
    })
}

/** The box a list of offsets occupies, off-grid ends included. `undefined` for an empty list. */
const footprintBox = (cells: readonly Offset[]): {min: Cell; max: Cell} | undefined => {
    if (cells.length === 0) return undefined
    let [x0, y0, z0] = [Infinity, Infinity, Infinity]
    let [x1, y1, z1] = [-Infinity, -Infinity, -Infinity]
    for (const [x, y, z] of cells) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        z0 = Math.min(z0, z)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
        z1 = Math.max(z1, z)
    }
    return {min: [x0, y0, z0], max: [x1, y1, z1]}
}

/** The expensive half of `hoverAt`, split out so the cache above has one thing to guard. */
const solveRegion = (
    state: AppState,
    volume: Volume,
    hit: {x: number; y: number; z: number; face: number},
    event: {clicks: number; alt: boolean; ctrl: boolean},
    locked: ReadonlySet<number>
): AimAnswer => {
    if (state.tool === 'fill') {
        // `fillRegion` is this traversal plus a write, over the document. Same seed, same grid.
        const region = connected(state.volume, hit.x, hit.y, hit.z)
        return {
            region,
            cells: drawable(state.volume, region),
            bounds: selectionBounds(state.volume, region),
            // A region that is already the loaded colour, or entirely locked, recolours to nothing.
            blocked: !someCell(state.volume, region, spot =>
                wouldWrite(state, locked, spot, state.color)
            )
        }
    }
    const region = pressSelection(state, volume, hit, event)
    return {
        region,
        cells: drawable(state.volume, region),
        bounds: selectionBounds(state.volume, region),
        // Nothing under the cursor to take hold of. A grab writes nothing by itself, so there is no
        // other way for it to be silent.
        blocked: region.size === 0
    }
}

/** `Array.some` over a region, without expanding two million indices into two million arrays. */
const someCell = (volume: Volume, region: Selection, ok: (cell: Cell) => boolean): boolean => {
    for (const index of region) if (ok(cellOf(volume, index))) return true
    return false
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
    // In slice mode the layer is the slice, not whatever the ray happened to land on: the point of
    // the mode is that the artist is working on one layer and can see it.
    const layer = state.slice ?? cell[axis]
    writeCells(draft, mirrored(state, strokeCells(brush, face, cell, cell)), value)
    return {
        ...state,
        volume: live(draft),
        stroke: {
            draft,
            base: state.volume,
            origin: cell,
            axis,
            layer,
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

    if (state.tool === 'scale') {
        const patch = pressSelection(state, volume, hit, event)
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
     * What the carrying *is* is the tool: Move slides the voxels, Clone leaves a copy behind, and
     * Rotate turns them a quarter at a time about the face that was grabbed.
     */
    const selection = pressSelection(state, volume, hit, event)

    const axis = faceAxis(hit.face)
    return {
        ...state,
        selection,
        band: undefined,
        drag: {
            kind:
                state.tool === 'clone' ? 'clone'
                : state.tool === 'rotate' ? 'turn'
                : 'move',
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

/** How far sideways the hand goes before the turn commits. */
const TURN_PIXELS = 48

/**
 * Which way one drag turns the selection: a quarter left, a quarter right, or not yet.
 *
 * Sideways pixels, not a swept angle. A turn has no length in the world to project the pointer onto
 * the way a pull does, so there is nothing to measure but how far the hand went; and a straight
 * sideways drag is the one gesture in the viewport that cannot be mistaken for an orbit.
 *
 * **One quarter per drag, however far the hand goes.** Counting a quarter every 48 px was the
 * obvious reading and it was wrong on the screen: four quarters is the identity, so a long drag
 * walked the model back to where it started, and two quarters is the identity for anything
 * symmetric — which a two-voxel bar is. Measured across a 320 px drag it flipped between exactly
 * two pictures eight times. A ratchet has one boundary instead of six and cannot flicker; turning
 * twice is two drags, which is also what the buttons on the selection bar cost.
 *
 * The sign follows the grabbed face rather than the axis. A quarter turn about `z` reads clockwise
 * from above and anticlockwise from below, so an artist who has orbited under the model and drags
 * right would otherwise watch it turn the opposite way from the one they just learned.
 */
const quartersTurned = (state: AppState, drag: Drag, event: ViewportPointer): number => {
    const dx = event.x - drag.x
    if (Math.abs(dx) < TURN_PIXELS) return 0
    const basis = basisFor(state.orbit.camera, drag.volume, event.height)
    const step = FACE_STEP[drag.face] ?? [0, 0, 0]
    const into =
        step[0] * basis.forward[0] + step[1] * basis.forward[1] + step[2] * basis.forward[2]
    const facing = into <= 0 ? 1 : -1
    return facing * Math.sign(dx)
}

const continueDrag = (state: AppState, event: ViewportPointer): AppState => {
    const {drag} = state
    if (!drag) return state
    const draft = open(state, drag.volume)

    if (drag.kind === 'turn') {
        const quarters = quartersTurned(state, drag, event)
        if (quarters === 0) {
            return {...state, volume: drag.volume, selection: drag.selection, losing: 0}
        }
        const turned = rotateCells(draft, drag.selection, faceAxis(drag.face), quarters)
        /*
         * A turn is a bijection: every voxel has exactly one destination, so an answer that came
         * back smaller lost some off the edge of the grid. Refuse it whole and leave the model where
         * it was — the same rule the keyboard transform applies, and for the same reason. The draft
         * is a throwaway copy, so dropping it costs nothing.
         */
        if (turned.size !== drag.selection.size) {
            return {...state, volume: drag.volume, selection: drag.selection, losing: 0}
        }
        return {...state, volume: draft.volume, selection: turned, sheet: undefined}
    }

    if (drag.kind === 'extrude') {
        const layers = layersPulled(state, drag, event)
        if (layers === 0) {
            return {...state, volume: drag.volume, selection: drag.selection, losing: 0}
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
        return {...state, volume: drag.volume, selection: drag.selection, losing: 0}
    }
    /*
     * Counted against the grid the drag *started* on, which is the one the drop is about to be
     * replayed over. Counting against `state.volume` would count the previous position of this same
     * gesture, and read as a warning about voxels the artist has not lost.
     */
    const losing = lossCount(drag.volume, drag.selection, delta, drag.kind !== 'clone')
    const selection =
        drag.kind === 'clone' ?
            duplicateCells(draft, drag.selection, delta)
        :   moveCells(draft, drag.selection, delta)
    return {...state, volume: draft.volume, selection, losing, sheet: undefined}
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
        // The warning was about a drop that had not happened yet. It has now.
        losing: 0,
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
    selection: taken.objects ? EMPTY_SELECTION : state.selection,
    sheet: undefined
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
                    const edit = commitEdit(draft) ?? NO_CELLS
                    return {
                        ...state,
                        objects: added,
                        volume: draft.volume,
                        selection: EMPTY_SELECTION,
                        history: record(state.history, {
                            ...edit,
                            objects: {from: objects, to: added}
                        }),
                        sheet: undefined
                    }
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
                    /*
                     * An empty object has no cells to commit, so `commitEdit` hands back nothing
                     * — and the delete still has to be undoable, because losing a name is a loss.
                     * `NO_CELLS` is the edit that says "the list changed and the grid did not".
                     */
                    const edit = commitEdit(draft) ?? NO_CELLS
                    return {
                        ...state,
                        objects: list,
                        volume: draft.volume,
                        selection: EMPTY_SELECTION,
                        history: record(state.history, {
                            ...edit,
                            objects: {from: objects, to: list}
                        }),
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
                previewed: added.id,
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
                previewed: added.id,
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
                // The panel has to point at something, so a deleted preview falls to the next
                // camera rather than to the empty message.
                previewed: state.previewed === action.id ? cameras[0]?.id : state.previewed,
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

        /*
         * One reference per plane. Dropping a second front view replaces the first, because two
         * pictures of the front stacked on each other is not something anyone asked for and the
         * artist plainly meant the new one.
         */
        case 'reference': {
            const kept = state.references.filter(entry => entry.plane !== action.plane)
            return {
                ...state,
                references: [
                    ...kept,
                    {plane: action.plane, url: action.url, opacity: 0.5, locked: false}
                ]
            }
        }

        case 'reference-opacity':
            return {
                ...state,
                references: state.references.map(entry =>
                    entry.plane === action.plane && !entry.locked ?
                        {...entry, opacity: Math.min(1, Math.max(0, action.opacity))}
                    :   entry
                )
            }

        case 'reference-lock':
            return {
                ...state,
                references: state.references.map(entry =>
                    entry.plane === action.plane ? {...entry, locked: action.on} : entry
                )
            }

        case 'reference-drop':
            return {
                ...state,
                references: state.references.filter(
                    entry => entry.plane !== action.plane || entry.locked
                )
            }

        /*
         * A PNG imported as voxels is a *new document* — `FEATURESET.md` §34 calls it a starting
         * point, and it brings its own grid size and its own palette. Merging it into the open one
         * would need a resize and a palette remap, and neither is what "instantly gives artists
         * something to sculpt from" means.
         */
        case 'import-image': {
            const opened = initialState(action.volume)
            return {...opened, references: state.references, presets: state.presets}
        }

        /*
         * Restoring a snapshot — `FEATURESET.md` §32. It replaces the document and empties the
         * history, because the history is a list of diffs against a grid that is no longer there
         * and undoing one of them would apply it to the wrong model.
         */
        case 'open': {
            const opened = initialState(action.document.volume, action.document)
            return {...opened, references: state.references, presets: state.presets}
        }

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

        case 'invert':
            return {...state, invert: action.on}

        case 'workspace':
            return {...state, workspace: action.workspace}

        case 'preset':
            return {...state, preset: action.preset}

        case 'fps':
            return {...state, fps: action.fps}
    }
}

/**
 * What `hover` depends on. Anything here changing means the outline on screen is now describing a
 * click that would do something else.
 *
 * A list rather than a `hoverAt` call in each of the fifty cases above, because the list can be
 * read and the fifty call sites could not — and a case that forgot one would leave the artist an
 * outline that is quietly lying, which is worse than the nothing this replaces.
 */
const AIMED_AT: readonly (keyof AppState)[] = [
    'aim',
    'volume',
    'tool',
    'brush',
    'color',
    'plane',
    'slice',
    'symmetry',
    'objects',
    'orbit',
    'stroke',
    'drag',
    'band',
    // The grab tools read it: a press on a voxel that is already selected keeps the whole selection
    // rather than collapsing to that one cell, so what is outlined changes when the selection does.
    'selection'
]

export const reduce = (state: AppState, action: AppAction): AppState => {
    const next = step(state, action)
    if (next === state) return state
    return AIMED_AT.some(key => next[key] !== state[key]) ? hoverAt(next) : next
}
