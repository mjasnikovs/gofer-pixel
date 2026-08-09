import type {Files} from '../doc/files'
import {shownVolume} from '../doc/objects'
import {sheetMetadata} from '../sheet/metadata'
import {writeMetadata, writeSheet, writeSprite} from './download'
import {presetMaps} from '../sheet/presets'
import {currentSheet, type AppState} from './state'

/**
 * The three things an export writes, each as one call over the whole app state.
 *
 * They lived in `App.tsx` as click handlers, each opening with its own `if (!state.sheet) return`
 * and each reaching for a different combination of the state to answer "which files, from what".
 * That guard is the interesting part — a sheet can be stale, and writing a stale one is silent —
 * so it belongs somewhere it is written once rather than three times inside JSX.
 *
 * Nothing here re-renders anything. The files are cut out of the sheet the reducer baked, so what
 * lands in the downloads folder is byte-for-byte what the panel was previewing.
 *
 * `Files` comes in rather than being reached for, and it is the same port Open, Save and the palette
 * loader use — see `doc/files.ts`. It used to be an anchor built three modules down, so an export
 * was the one thing the artist ships that no test could read the bytes of.
 */

/** The sheet's maps, as the current preset asks for them — the Export button. */
export const writeExport = async (files: Files, state: AppState): Promise<void> => {
    const sheet = currentSheet(state)
    if (!sheet) return
    await writeSheet(files, sheet, presetMaps(state.output, state.output.preset))
}

/** One PNG per camera, cut out of the sheet — `FEATURESET.md` §17. */
export const writeSprites = async (files: Files, state: AppState): Promise<void> => {
    const sheet = currentSheet(state)
    if (!sheet) return
    await Promise.all(
        state.cameras.map((entry, index) => writeSprite(files, sheet, index, entry.name))
    )
}

/**
 * The JSON an engine reads next to the sheet — `FEATURESET.md` §37.
 *
 * `shownVolume` and deliberately not `slicedFor` over it — the one place in the app that measures
 * something other than the grid as the artist sees it. The bake itself honours slice mode, so a
 * sheet baked in slice mode has boxes described from a fuller model than the pixels came from.
 * Left as it was: changing it changes exported files, which is a decision about the format rather
 * than about where this code lives. It is an opt-out from `doc/gesture.ts`'s derivation, not a
 * second spelling of it.
 */
export const writeSheetMetadata = async (files: Files, state: AppState): Promise<void> => {
    const sheet = currentSheet(state)
    if (!sheet) return
    await writeMetadata(
        files,
        sheetMetadata(
            shownVolume(state.volume, state.objects),
            state.cameras,
            sheet,
            state.output.bounds
        )
    )
}
