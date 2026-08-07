import {captureCamera, eightDirections, ISOMETRIC_PITCH, type NamedCamera} from '../doc/cameras'
import {firstColor} from '../doc/palette'
import {createCamera, type Camera} from '../render/camera'
import {MODE_COLOR} from '../render/raycast.glsl'
import type {Volume} from '../render/volume'
import {renderSheet, type Sheet} from '../sheet/sheet'
import {apply as applyOrbit, type OrbitEvent, type OrbitState} from '../viewport/orbit'

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

/** The four brush footprints in the mockup's Shape row. */
export const SHAPES = ['square', 'circle', 'ring', 'cube'] as const
export type Shape = (typeof SHAPES)[number]

export const BRUSH_KINDS = ['voxel', 'face', 'plane'] as const
export type BrushKind = (typeof BRUSH_KINDS)[number]

/** A brush wider than eight voxels is a fill, and there is a fill tool two rows down. */
export const MAX_BRUSH = 8

export interface Brush {
    readonly kind: BrushKind
    readonly size: number
    readonly shape: Shape
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

    /*
     * From here down is the editing chrome of `docs/editor.png`. It is state the window shows and
     * remembers — which tool is armed, how big the brush is, which colour is loaded — and nothing
     * downstream of it writes voxels, because editing is on the proof of concept's do-not-build
     * list. It lives in the same value as everything else so that when a tool does start writing
     * voxels there is no second store to reconcile.
     */
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
