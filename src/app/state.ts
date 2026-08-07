import {
    BRUSH_KINDS,
    faceAxis,
    MAX_BRUSH,
    SHAPES,
    type Brush,
    type BrushKind,
    type Shape
} from '../doc/brush'
import {captureCamera, eightDirections, ISOMETRIC_PITCH, type NamedCamera} from '../doc/cameras'
import {beginEdit, commitEdit, fillRegion, stampBrush, strokeBrush, type Draft} from '../doc/edits'
import {EMPTY_HISTORY, record, redo, undo, type History} from '../doc/history'
import {firstColor} from '../doc/palette'
import {
    EMPTY_SELECTION,
    grow,
    selectColor,
    selectConnectedColor,
    selectObject,
    selectRect,
    selectVoxel,
    shrink,
    type Selection
} from '../doc/selection'
import {basisFor, createCamera, type Camera} from '../render/camera'
import {pick, pickPlane, pickRay} from '../render/pick'
import {MODE_COLOR} from '../render/raycast.glsl'
import type {Volume} from '../render/volume'
import {renderSheet, type Sheet} from '../sheet/sheet'
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
    /** `0` = x, `1` = y, `2` = z — the axis the drawing plane is perpendicular to. */
    readonly axis: number
    readonly layer: number
    /** The face the first click struck, which is what orients a flat brush. */
    readonly face: number
    readonly value: number
    readonly at: readonly [number, number, number]
}

export interface AppState {
    readonly volume: Volume
    readonly cameras: readonly NamedCamera[]
    /** Which stored camera the viewport is currently showing, if it still matches one. */
    readonly selected: string | undefined
    readonly orbit: OrbitState
    /** Which of the four maps the viewport draws — the same enum the shader takes. */
    readonly map: number
    /** Edge of one sprite in the sheet, in pixels. */
    readonly cell: number
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

    readonly tool: Tool
    readonly brush: Brush
    /** 1-based index into `volume.palette`, the `.vox` format's own convention. */
    readonly color: number
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
    | {type: 'select'; id: string}
    | {type: 'eight-directions'}
    | {type: 'capture'}
    | {type: 'duplicate'}
    | {type: 'delete'; id: string}
    | {type: 'map'; map: number}
    | {type: 'cell'; cell: number}
    | {type: 'bake'}
    | {type: 'written'}
    | {type: 'tool'; tool: Tool}
    | {type: 'brush'; brush: Partial<Brush>}
    | {type: 'color'; color: number}
    | {type: 'grid'; on: boolean}
    | {type: 'snap'; on: boolean}
    | {type: 'workspace'; workspace: 'model' | 'render'}
    | {type: 'preset'; preset: string}
    | {type: 'fps'; fps: number}

/**
 * The export presets of `docs/editor.png`. A preset is a name for a set of export choices; only the
 * first one is wired to anything, and the selector says so by disabling the rest.
 */
export const PRESETS = ['Sprite Sheet (Auto)', 'Individual Sprites', 'Godot 8-direction'] as const

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
        orbit: {
            camera: first?.camera ?? createCamera(volume, 0, ISOMETRIC_PITCH),
            gesture: undefined
        },
        map: MODE_COLOR,
        cell: 64,
        sheet: undefined,
        exporting: false,
        serial: 0,
        history: EMPTY_HISTORY,
        stroke: undefined,
        selection: EMPTY_SELECTION,
        band: undefined,
        tool: 'draw',
        brush: {kind: 'voxel', size: 2, shape: 'square'},
        color: firstColor(volume),
        grid: true,
        snap: true,
        workspace: 'model',
        preset: PRESETS[0],
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

const beginStroke = (state: AppState, event: ViewportPointer): AppState => {
    const {volume, tool, color, brush} = state
    // A viewport with no size has no pixels to cast a ray through, and `zoom / 0` would send one
    // off to infinity. happy-dom reports exactly this, so it is a real case and not a guard.
    if (event.height <= 0 || event.width <= 0) return state
    const basis = basisFor(state.orbit.camera, volume, event.height)
    const hit = pick(volume, basis, event.x, event.y, event.width, event.height)
    if (!hit) return state

    // Pick is not an edit and does not open a stroke; it loads the colour and gets out of the way.
    if (tool === 'pick') return hit.value === 0 ? state : {...state, color: hit.value}

    if (tool === 'fill') {
        const draft = beginEdit(volume)
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
    const draft = beginEdit(volume)
    const axis = faceAxis(hit.face)
    stampBrush(draft, brush, hit.face, cell[0], cell[1], cell[2], value)
    return {
        ...state,
        volume: live(draft),
        stroke: {draft, axis, layer: cell[axis] ?? 0, face: hit.face, value, at: cell},
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
    strokeBrush(stroke.draft, state.brush, stroke.face, stroke.at, cell, stroke.value)
    return {...state, volume: live(stroke.draft), stroke: {...stroke, at: cell}}
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
    const basis = basisFor(state.orbit.camera, state.volume, event.height)
    const hit = pickRay(state.volume, basis, event.x, event.y, event.width, event.height)
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
    const selection =
        event.clicks >= 2 ? selectConnectedColor(state.volume, hit.x, hit.y, hit.z)
        : event.alt ? selectObject(state.volume, hit.x, hit.y, hit.z)
        : selectVoxel(state.volume, hit.x, hit.y, hit.z)
    return {...state, selection, band: undefined}
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
            const orbit = applyOrbit(state.orbit, action.event, action.height)
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

        case 'select-color':
            return {...state, selection: selectColor(state.volume, action.color ?? state.color)}

        case 'grow-selection':
            return {...state, selection: grow(state.volume, state.selection)}

        case 'shrink-selection':
            return {...state, selection: shrink(state.volume, state.selection)}

        case 'clear-selection':
            return state.selection.size === 0 ? state : {...state, selection: EMPTY_SELECTION}

        case 'select': {
            const found = state.cameras.find(({id}) => id === action.id)
            return found ? withCamera(state, found.camera, found.id) : state
        }

        case 'eight-directions': {
            const cameras = eightDirections(state.volume)
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

        case 'bake':
            return {
                ...state,
                exporting: true,
                sheet: renderSheet(state.volume, state.cameras, state.cell)
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
            return {...state, color: action.color}

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
