import type {SavedOutput} from '../doc/save'
import {SHEET_MAPS, type SheetMap} from './sheet'

/**
 * A named set of export choices, and the four rules a list of them keeps.
 *
 * The rules — a built-in name cannot be taken, saving over a name replaces it, dropping the
 * selected one falls back to the first, an empty name is refused — were four `PRESETS.some(...)`
 * and `.filter(...)` expressions scattered through `app/state.ts`, each one a chance for the next
 * case to spell the fallback differently.
 *
 * Everything here works on `SavedOutput` rather than on `AppState`, because a preset is something
 * the `.gpix` holds. It has no idea an app exists.
 */
export interface Preset {
    readonly name: string
    readonly maps: readonly SheetMap[]
}

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
] as const satisfies readonly Preset[]

/** The one a document falls back to — when a name is dropped, and when a file names none. */
export const DEFAULT_PRESET: Preset = PRESETS[0]

/** Built-in and saved, in the order the selector lists them. */
export const allPresets = (output: SavedOutput): readonly Preset[] => [
    ...PRESETS,
    ...output.presets
]

/** Which maps a name writes. An unknown name writes the default's, rather than nothing at all. */
export const presetMaps = (output: SavedOutput, name: string): readonly SheetMap[] =>
    allPresets(output).find(entry => entry.name === name)?.maps ?? DEFAULT_PRESET.maps

/**
 * Save the current choices under a name, and select it.
 *
 * An empty name is refused because it cannot be picked again, and a built-in name is refused
 * because a list with two `Every map` rows in it is a list nobody can use. Saving over a name that
 * is already the artist's replaces it: they typed it twice and meant the second one.
 *
 * `undefined` means the name was refused, so the caller can leave the state exactly as it was.
 */
const savePreset = (
    output: SavedOutput,
    name: string,
    maps: readonly SheetMap[]
): SavedOutput | undefined => {
    const trimmed = name.trim()
    if (trimmed === '' || PRESETS.some(entry => entry.name === trimmed)) return undefined
    return {
        ...output,
        presets: [...output.presets.filter(entry => entry.name !== trimmed), {name: trimmed, maps}],
        preset: trimmed
    }
}

/**
 * Drop a saved preset. Dropping the selected one falls back to the default, because a document
 * whose selected preset names nothing exports the default's maps anyway — better to say so.
 *
 * `undefined` means there was nothing by that name, including every built-in: those cannot be
 * dropped, and the reason is the same as why they cannot be overwritten.
 */
const dropPreset = (output: SavedOutput, name: string): SavedOutput | undefined => {
    const presets = output.presets.filter(entry => entry.name !== name)
    if (presets.length === output.presets.length) return undefined
    return {
        ...output,
        presets,
        preset: output.preset === name ? DEFAULT_PRESET.name : output.preset
    }
}

/** Saving one and dropping one — the two things the export dialog does to the list. */
export type PresetOp =
    {kind: 'save'; name: string; maps: readonly SheetMap[]} | {kind: 'drop'; name: string}

/**
 * The one way anything outside this file changes the list.
 *
 * `undefined` still means refused, and that is the whole of the interface: the caller leaves the
 * state exactly as it was and does not get to invent a different fallback. One entry point rather
 * than two exports for the same reason `applyReference` is one — a reducer case per operation is a
 * place for the next one to answer "refused" differently.
 */
export const applyPreset = (output: SavedOutput, op: PresetOp): SavedOutput | undefined =>
    op.kind === 'save' ? savePreset(output, op.name, op.maps) : dropPreset(output, op.name)

/**
 * The preset a file's `preset` field means.
 *
 * A version-1 file, and every document that was never saved, carries the empty string — the format
 * may not know the app's preset names. That empty string becomes the default here, which is the one
 * place that mapping belongs.
 */
export const presetNamed = (name: string | undefined): string =>
    name === undefined || name === '' ? DEFAULT_PRESET.name : name
