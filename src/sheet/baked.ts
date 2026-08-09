import type {Axis} from '../doc/brush'
import type {NamedCamera} from '../doc/cameras'
import type {Objects} from '../doc/objects'
import type {Volume} from '../render/volume'
import {renderSheet, type Sheet, type SheetMap} from './sheet'

/**
 * A baked sheet and the fact of what it was baked from.
 *
 * Baking is not automatic and must not become automatic: it is six renders of every camera, and the
 * artist asks for it. So the result is kept — the export panel previews it, and the sprite and
 * metadata buttons write from it — and the question "is that still the sheet for this document?"
 * has to be answerable afterwards.
 *
 * It used to be answered by hand. Twenty-four cases in the reducer wrote `sheet: undefined`, and the
 * twenty-fifth case anyone added would have exported the sprite sheet of a model that no longer
 * existed — silently, because a stale sheet renders perfectly. Nothing could have failed for it,
 * since no test can cover a case that has not been written yet.
 *
 * So the sheet carries the identity of everything it came out of, and staleness is *computed*. A new
 * action cannot forget a rule it never has to state. The same pattern as `AimKey` in
 * `app/state.ts`, and for the same reason: identity comparison over a handful of fields is cheaper
 * than the work, and every field is one the document already holds.
 */
export interface SheetKey {
    /** The document's own grid, not the visible one — see `slice`. */
    readonly volume: Volume
    /** Hiding an object hides it in the export too, so the sheet is a function of the list. */
    readonly objects: Objects
    readonly cameras: readonly NamedCamera[]
    readonly cell: number
    readonly padding: number
    /** Which maps the preset asked for. Compared element-wise; the array is rebuilt on every read. */
    readonly maps: readonly SheetMap[]
    /**
     * Slice mode, which the bake honours because it bakes what is on screen.
     *
     * The camera is deliberately *not* here. A slice's kept side depends on which way the view
     * faces, so an orbit with slice mode on can strictly speaking stale a sheet — but putting the
     * camera in the key would throw the sheet away on every mouse-drag, which is the worse of the
     * two. Baking again is one click.
     */
    readonly slice: number | undefined
    readonly plane: Axis | undefined
}

export interface Baked {
    readonly key: SheetKey
    readonly sheet: Sheet
}

const sameMaps = (a: readonly SheetMap[], b: readonly SheetMap[]): boolean =>
    a.length === b.length && a.every((map, i) => map === b[i])

export const sameKey = (a: SheetKey, b: SheetKey): boolean =>
    a.volume === b.volume
    && a.objects === b.objects
    && a.cameras === b.cameras
    && a.cell === b.cell
    && a.padding === b.padding
    && a.slice === b.slice
    && a.plane === b.plane
    && sameMaps(a.maps, b.maps)

/**
 * Bake, and stamp the result with what it came from.
 *
 * `shown` is the grid as the artist sees it — hidden objects emptied out, sliced if slice mode is
 * on. It is passed rather than derived because deriving it is the app's job and it is already
 * derived there; the key is what says which `shown` this was.
 */
export const bakeSheet = (key: SheetKey, shown: Volume): Baked => ({
    key,
    sheet: renderSheet(shown, key.cameras, key.cell, key.maps, key.padding)
})

/** The sheet, if it is still the sheet for `key`. `undefined` once anything it came from has moved. */
export const sheetFor = (baked: Baked | undefined, key: SheetKey): Sheet | undefined =>
    baked && sameKey(baked.key, key) ? baked.sheet : undefined
