import type {Raycaster} from '../render/gl'
import type {AppAction, AppState} from './state'

/**
 * The seam a browser test drives the running app through.
 *
 * It exists because of the testing law: a test must never wait for a duration, so it needs a way to
 * ask for a frame and be told when that frame landed, and a way to fire an action and read the
 * state that resulted. Both are `await`-able through here. Polling the DOM until it looks right is
 * the thing this replaces.
 *
 * It is one mutable object rather than a global registry so that nothing in the app can come to
 * depend on it — the app only ever writes.
 */
export interface AppHandle {
    raycaster: Raycaster | undefined
    state: AppState | undefined
    dispatch: ((action: AppAction) => void) | undefined
    /**
     * Resolves once the viewport's first frame has landed.
     *
     * Without this a test has nothing to await: the camera thumbnails are on screen after React's
     * first commit, but the viewport cannot draw until a `ResizeObserver` has told it how big it
     * is, which happens a beat later. A test that starts reading pixels when the thumbnails appear
     * reads an empty canvas perhaps one run in five — and the fix for that is an event, never a
     * wait, so here is the event.
     */
    firstFrame: Promise<void>
    /** Called by the app when a frame lands. Idempotent; a consumer never calls it. */
    markDrawn: () => void
}

let resolveFirstFrame: (() => void) | undefined

export const handle: AppHandle = {
    raycaster: undefined,
    state: undefined,
    dispatch: undefined,
    firstFrame: new Promise<void>(resolve => {
        resolveFirstFrame = resolve
    }),
    markDrawn: () => {
        resolveFirstFrame?.()
        resolveFirstFrame = undefined
    }
}
