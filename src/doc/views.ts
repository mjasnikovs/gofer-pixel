import type {Camera} from '../render/camera'
import {captureCamera, lastSerial, type NamedCamera} from './cameras'

/**
 * The stored cameras, plus the two questions the strip and the render panel ask about them.
 *
 * Four fields that are one concept. They used to be four fields on `AppState` maintained by hand in
 * eight reducer cases: `capture` and `duplicate` were the same five lines twice, `delete` and
 * `directions` each re-derived the fallbacks, and nothing stopped `selected` from naming a camera
 * that had been removed — the invariant existed only as a habit of whoever wrote the next case.
 *
 * `Views` is extended by `AppState` for the same reason `Gesture` is: every operation below is
 * generic in the state it is handed, so a reducer case spreads the result back and the compiler
 * checks that the four fields it reads are still the four fields the app holds.
 */
export interface Views {
    readonly cameras: readonly NamedCamera[]
    /**
     * Which stored camera the viewport is currently showing, if it still matches one. Cleared by
     * the first orbit, because a list of cameras that quietly lie is worse than no highlight.
     */
    readonly selected: string | undefined
    /**
     * Which camera the render panel inspects. The last one actually picked, and orbiting does not
     * clear it — see `selected` above for why one field cannot answer both questions.
     */
    readonly previewed: string | undefined
    /** The highest serial any camera here was minted with. Ids are `cam-<serial>`. */
    readonly serial: number
}

/**
 * The three-quarter view, not the front one. A straight-on elevation of a voxel model is a
 * rectangle: a legitimate sprite, and the one angle where nothing on screen says the thing is
 * solid — so it is the wrong view to open a 3D tool on.
 */
export const opening = (cameras: readonly NamedCamera[]): NamedCamera | undefined =>
    cameras[1] ?? cameras[0]

/**
 * The one place the invariant lives: neither pointer may name a camera that is not on the list.
 *
 * A dead `selected` becomes nothing, because the strip's highlight is a claim about the view and a
 * claim about a camera that is gone is false. A dead `previewed` falls to the first camera instead,
 * because the render panel has to point at *something* or it shows its empty message while eight
 * perfectly good cameras sit next to it.
 *
 * An already-undefined `previewed` is left alone. That is not a dead pointer, it is a document with
 * no cameras at all, and filling it in here would undo `initialState`'s choice of the opening view.
 */
const pointing = <V extends Views>(views: V, cameras: readonly NamedCamera[]): V => {
    const has = (id: string | undefined): boolean =>
        id !== undefined && cameras.some(camera => camera.id === id)
    return {
        ...views,
        cameras,
        selected: has(views.selected) ? views.selected : undefined,
        previewed:
            views.previewed === undefined || has(views.previewed) ? views.previewed : cameras[0]?.id
    }
}

/**
 * A fresh set of views over a list of cameras, opened on the three-quarter one.
 *
 * `serial` is derived from the ids rather than carried, because it has to be right for a file
 * written before anyone thought about it — see `lastSerial`.
 */
export const startViews = (cameras: readonly NamedCamera[]): Views => {
    const first = opening(cameras)
    return {
        cameras,
        selected: first?.id,
        previewed: first?.id,
        serial: lastSerial(cameras)
    }
}

/** The camera with this id, if the list still holds one. */
export const viewNamed = (views: Views, id: string | undefined): NamedCamera | undefined =>
    id === undefined ? undefined : views.cameras.find(camera => camera.id === id)

/**
 * Point at a stored camera, or at none.
 *
 * `undefined` is what an orbit, an align and a focus all do: the view no longer matches anything
 * stored, so the strip stops claiming it does — but the render panel keeps inspecting whatever it
 * was inspecting, which is the whole distinction between the two fields.
 */
export const showView = <V extends Views>(views: V, id: string | undefined): V => ({
    ...views,
    selected: id,
    previewed: id ?? views.previewed
})

/**
 * Replace the whole list — a new ring of directions. Opens on the three-quarter view again.
 *
 * `serial` is deliberately not reset. The new ids are `dir-*` so there is nothing to clash with
 * today, but a counter that goes backwards is the defect `lastSerial` exists to prevent, and it is
 * not worth re-introducing for the sake of starting the next capture at one.
 */
export const resetViews = <V extends Views>(views: V, cameras: readonly NamedCamera[]): V => {
    const first = opening(cameras)
    return {...views, cameras, selected: first?.id, previewed: first?.id ?? views.previewed}
}

/** The viewport's current view, stored — the mockup's shutter button. */
export const captureView = <V extends Views>(views: V, camera: Camera): V => {
    const serial = views.serial + 1
    const added = captureCamera(camera, serial)
    return {
        ...views,
        cameras: [...views.cameras, added],
        selected: added.id,
        previewed: added.id,
        serial
    }
}

/**
 * The selected camera again, under a new id — the mockup's second camera-header button.
 *
 * It copies the transform rather than pointing at it, because two entries sharing one camera object
 * is an instance, and instances are on the postponed list in `docs/FEATURESET.md` §11.
 */
export const duplicateView = <V extends Views>(views: V): V => {
    const source = viewNamed(views, views.selected)
    if (!source) return views
    const serial = views.serial + 1
    const added = {id: `cam-${String(serial)}`, name: `${source.name} copy`, camera: source.camera}
    return {
        ...views,
        cameras: [...views.cameras, added],
        selected: added.id,
        previewed: added.id,
        serial
    }
}

export const removeView = <V extends Views>(views: V, id: string): V => {
    const cameras = views.cameras.filter(camera => camera.id !== id)
    return cameras.length === views.cameras.length ? views : pointing(views, cameras)
}

/** A row dragged along the strip. Neither pointer moves: the same cameras are still the ones. */
export const reorderView = <V extends Views>(views: V, id: string, to: number): V => {
    const from = views.cameras.findIndex(camera => camera.id === id)
    if (from < 0 || from === to) return views
    const cameras = [...views.cameras]
    const [taken] = cameras.splice(from, 1)
    if (!taken) return views
    cameras.splice(Math.max(0, Math.min(cameras.length, to)), 0, taken)
    return {...views, cameras}
}
