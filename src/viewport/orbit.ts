import type {Camera} from '../render/camera'

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
}

/** A 100 px drag is one radian, which is about as fast as an orbit can be and stay controllable. */
const RADIANS_PER_PIXEL = 0.01

/** Straight up and straight down are allowed: the basis snap is what makes those views safe. */
const MAX_PITCH = Math.PI / 2

const MIN_ZOOM = 2
const MAX_ZOOM = 512

const clamp = (value: number, low: number, high: number): number =>
    Math.min(Math.max(value, low), high)

export const apply = (state: OrbitState, event: OrbitEvent, height: number): OrbitState => {
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
                return {
                    ...state,
                    camera: {
                        ...gesture.from,
                        yaw: gesture.from.yaw + dx * RADIANS_PER_PIXEL,
                        pitch: clamp(
                            gesture.from.pitch - dy * RADIANS_PER_PIXEL,
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
                camera: {
                    ...gesture.from,
                    panX: gesture.from.panX - dx * voxelsPerPixel,
                    panY: gesture.from.panY + dy * voxelsPerPixel
                }
            }
        }

        case 'wheel':
            // Exponential, so a notch is the same proportion of the view at every zoom level.
            return {
                ...state,
                camera: {
                    ...state.camera,
                    zoom: clamp(
                        state.camera.zoom * Math.exp(event.delta * 0.001),
                        MIN_ZOOM,
                        MAX_ZOOM
                    )
                }
            }
    }
}
