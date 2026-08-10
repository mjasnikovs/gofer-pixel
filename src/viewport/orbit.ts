import type {Camera} from '../render/camera'
import {nearestPerfectZoom, stepPerfectZoom} from '../render/perfect'
import type {Volume} from '../render/volume'

/**
 * Orbit, pan and zoom as a pure function.
 *
 * A gesture is replayed from the camera it started on every time the pointer moves, rather than
 * accumulated: `apply` never reads its own previous output, so a drag is reproducible from its
 * start plus a position, a test can jump straight to the end of a drag, and a dropped move event
 * cannot leave the camera somewhere the mouse is not. That pattern is the one idea worth keeping
 * from the old editor (`legacy/src/editor/state.ts`).
 *
 * Nothing here touches the DOM or a clock, so the whole interaction is testable at a microsecond
 * each — which is why the browser suite only has to prove that a real pointer reaches this.
 */
export interface Gesture {
    readonly mode: 'orbit' | 'pan'
    readonly x: number
    readonly y: number
    readonly from: Camera
}

export interface OrbitState {
    readonly camera: Camera
    readonly gesture: Gesture | undefined
}

export type OrbitEvent =
    | {type: 'pointerdown'; x: number; y: number; secondary: boolean}
    | {type: 'pointermove'; x: number; y: number}
    | {type: 'pointerup'}
    | {type: 'wheel'; delta: number}
    | {type: 'camera'; camera: Camera}

/**
 * What the viewport reports about a drag, before anything has decided what it means.
 *
 * Deliberately not an `OrbitEvent`: once there are tools, a drag might move the camera or it might
 * write voxels, and that choice belongs to the reducer that knows which tool is armed. The viewport
 * reports a position and which buttons were held, and nothing more.
 */
export interface ViewportPointer {
    readonly type: 'down' | 'move' | 'up'
    /** CSS pixels within the viewport element — the unit the basis must be built at to match. */
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
    readonly button: number
    readonly shift: boolean
    readonly alt: boolean
    /** Control or Command: add what this press picks to the selection instead of replacing it. */
    readonly ctrl: boolean
    /**
     * How many presses this one is the last of.
     *
     * Counted by the viewport, not read off the event: `PointerEvent.detail` is 0 on `pointerdown`
     * by specification, and reading it there made every double-click a single one for as long as
     * the tool existed. The count has to come from the press, because a selection is taken on the
     * press so that the same gesture can carry on into a drag — `click` and `dblclick`, which do
     * carry the platform's count, both arrive too late to be that.
     */
    readonly clicks: number
}

/** A 100 px drag is one radian, which is about as fast as an orbit can be and stay controllable. */
const RADIANS_PER_PIXEL = 0.01

/** Straight up and straight down are allowed: the basis snap is what makes those views safe. */
const MAX_PITCH = Math.PI / 2

export const MIN_ZOOM = 2
export const MAX_ZOOM = 512

const clamp = (value: number, low: number, high: number): number =>
    Math.min(Math.max(value, low), high)

/**
 * What a snap is measured against, or `undefined` for a camera nobody is composing a sprite from.
 *
 * `cell` and `volume` are here because SNAP is a claim about *pixels*, and a camera on its own
 * cannot make one: the zoom says how many voxels tall the frame is, and only the sprite it is
 * rendered into says how many pixels that is. An `apply` without these does not snap, which is the
 * honest reading of "I was not told what this view exports into".
 */
export interface OrbitRules {
    /** The switch labelled SNAP. */
    readonly snap: boolean
    /** Reverse the direction a drag turns the view. */
    readonly invert: boolean
    /** The edge of the sprite this camera exports into, in pixels. */
    readonly cell: number
    /** The grid, because the projection is built around its middle. */
    readonly volume: Volume
}

/**
 * Pixel snapping, as `FEATURESET.md` §14 asks for it — and it is the switch labelled SNAP.
 *
 * §14 words it as "integer zoom" and **that is the wrong invariant**, which is the one thing worth
 * knowing about this function. Zoom is voxels-tall of the frame; what lands on the grid is
 * `cell / zoom`, pixels-tall of a voxel. Rounding the first does nothing for the second: the
 * camera every new 16³ document opens on is zoom 31, an integer, and 64 / 31 is 2.06, so a row of
 * voxels exports as `3 2 2 2 2 2 2 2 3`. `render/perfect.ts` holds the real question and this
 * asks it.
 *
 * Pan is still rounded to whole voxels, and for the reason it always was: pan slides the lattice
 * without stretching it, so whole voxels keep the alignment the zoom just bought.
 *
 * A zoom is left alone when the angle has no whole-pixel lattice at all — most do not, true
 * isometric among them. Moving it to *something* would be the old defect wearing a new name.
 */
const snapCamera = (camera: Camera, rules: OrbitRules | undefined): Camera => {
    if (!rules?.snap) return camera
    const zoom = nearestPerfectZoom(camera, rules.volume, rules.cell, MIN_ZOOM, MAX_ZOOM)
    return {
        ...camera,
        zoom: zoom ?? camera.zoom,
        panX: Math.round(camera.panX),
        panY: Math.round(camera.panY)
    }
}

/**
 * Which way a drag turns the model.
 *
 * Off, dragging right turns the model as if you had a hand on it. On, it swings the camera the other
 * way round. Both conventions are in wide use and neither is more correct, so this is a setting
 * rather than an opinion — and it flips orbit only. Pan is unaffected on purpose: panning drags the
 * *picture* under a fixed frame, which is the one gesture everybody already agrees about, and
 * inverting it would break the direct correspondence between the cursor and the thing under it.
 */
export const apply = (
    state: OrbitState,
    event: OrbitEvent,
    height: number,
    rules?: OrbitRules
): OrbitState => {
    switch (event.type) {
        case 'camera':
            return {camera: event.camera, gesture: undefined}

        case 'pointerdown':
            return {
                ...state,
                gesture: {
                    mode: event.secondary ? 'pan' : 'orbit',
                    x: event.x,
                    y: event.y,
                    from: state.camera
                }
            }

        case 'pointerup':
            return {...state, gesture: undefined}

        case 'pointermove': {
            const {gesture} = state
            if (!gesture) return state
            const dx = event.x - gesture.x
            const dy = event.y - gesture.y
            if (gesture.mode === 'orbit') {
                const sense = rules?.invert === true ? -1 : 1
                return {
                    ...state,
                    camera: {
                        ...gesture.from,
                        yaw: gesture.from.yaw + sense * dx * RADIANS_PER_PIXEL,
                        pitch: clamp(
                            gesture.from.pitch - sense * dy * RADIANS_PER_PIXEL,
                            -MAX_PITCH,
                            MAX_PITCH
                        )
                    }
                }
            }
            // Panning drags the model, so the centre of view moves the other way.
            const voxelsPerPixel = gesture.from.zoom / height
            return {
                ...state,
                camera: snapCamera(
                    {
                        ...gesture.from,
                        panX: gesture.from.panX - dx * voxelsPerPixel,
                        panY: gesture.from.panY + dy * voxelsPerPixel
                    },
                    rules
                )
            }
        }

        case 'wheel': {
            // Exponential, so a notch is the same proportion of the view at every zoom level.
            const zoomed = state.camera.zoom * Math.exp(event.delta * 0.001)
            /*
             * Snapped, the wheel walks the stops at which a voxel is a whole number of pixels
             * rather than the integers, and it walks *past* where it started so a notch always
             * moves — rounding to nearest leaves a slow wheel stuck on the stop it is sitting on.
             * An angle with no stops at all falls back to the free zoom, because a wheel that
             * refuses to turn is a worse answer than one that turns off the grid.
             */
            const stepped =
                rules?.snap === true ?
                    (stepPerfectZoom(
                        state.camera,
                        rules.volume,
                        rules.cell,
                        zoomed > state.camera.zoom,
                        MIN_ZOOM,
                        MAX_ZOOM
                    ) ?? zoomed)
                :   zoomed
            return {
                ...state,
                camera: {...state.camera, zoom: clamp(stepped, MIN_ZOOM, MAX_ZOOM)}
            }
        }
    }
}
