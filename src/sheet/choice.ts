import type {SavedOutput} from '../doc/save'
import {presetMaps} from './presets'
import {SHEET_MAPS, type SheetMap} from './sheet'

/**
 * Which maps this export is going to write, while the artist is deciding.
 *
 * A preset is a *saved* answer to that question and lives in the `.gpix` (`presets.ts`). This is the
 * unsaved one: the ticks in the export dialog, seeded from the selected preset and thrown away when
 * the dialog closes. That asymmetry is deliberate — the preset is the memory, and a set of ticks
 * that quietly outlived the dialog would be a second, invisible place the answer was stored.
 *
 * It is a module rather than four `useState`s because three of its rules are the kind that get
 * spelled twice and then differently:
 *
 * - **Colour is never optional.** `renderSheet` adds it back whatever it is asked for, so a dialog
 *   that let it be unticked would show an unticked box and write the file anyway.
 * - **An empty map is not written**, even when the preset names it. Otherwise `Every map` ships a
 *   black emission PNG for every model that has nothing glowing in it, which is most of them.
 * - **Choosing a preset replaces the ticks.** Anything else makes the selector a control whose
 *   effect depends on what the artist happened to touch before it.
 */
export interface Choice {
    /**
     * The preset these ticks came from.
     *
     * Carried so that `reseeded` can tell "the artist picked a preset" from "the artist re-rendered"
     * without an effect. A dialog that reset its ticks from an effect would show one frame of the
     * old ones.
     */
    readonly preset: string
    readonly maps: readonly SheetMap[]
}

/** The ticks a freshly opened dialog starts with: whatever the selected preset names. */
export const seeded = (output: SavedOutput): Choice => ({
    preset: output.preset,
    maps: presetMaps(output, output.preset)
})

/** The same ticks, unless the selected preset has changed underneath them. */
export const reseeded = (choice: Choice, output: SavedOutput): Choice =>
    choice.preset === output.preset ? choice : seeded(output)

/**
 * Tick or untick one map, keeping `SHEET_MAPS` order so the saved preset reads the way the list did.
 *
 * Unticking colour does nothing. It is refused here rather than by disabling the control, because a
 * disabled tickbox on a permanently ticked row is a control that says "you may not" about something
 * nobody would want; the row simply does not respond.
 */
export const toggled = (choice: Choice, map: SheetMap, on: boolean): Choice => {
    if (map === 'color' && !on) return choice
    const wanted = new Set(choice.maps)
    if (on) wanted.add(map)
    else wanted.delete(map)
    return {...choice, maps: SHEET_MAPS.filter(entry => wanted.has(entry))}
}

/**
 * What actually gets written: the ticks, minus anything this sheet would write blank.
 *
 * One derivation, read by the zip, by the loose PNGs and by the line that counts them, so the
 * number the dialog reports cannot disagree with the number of files that land.
 */
export const shipped = (choice: Choice, empty: ReadonlySet<SheetMap>): readonly SheetMap[] =>
    choice.maps.filter(map => !empty.has(map))
