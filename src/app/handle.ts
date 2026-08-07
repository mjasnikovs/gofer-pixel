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
}

export const handle: AppHandle = {
    raycaster: undefined,
    state: undefined,
    dispatch: undefined
}
