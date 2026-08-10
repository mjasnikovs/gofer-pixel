import type {Files} from '../doc/files'
import {shownVolume} from '../doc/objects'
import {sheetMetadata, type SheetMetadata} from '../sheet/metadata'
import type {Sheet, SheetMap} from '../sheet/sheet'
import {writeMetadata, writePack, writeSheet, writeSprite} from './download'
import type {AppState} from './state'

/**
 * The four things an export writes, each as one call over the state and the sheet on screen.
 *
 * They lived in `App.tsx` as click handlers, each opening with its own `if (!state.sheet) return`
 * and each reaching for a different combination of the state to answer "which files, from what".
 *
 * The sheet comes **in** rather than being fetched out of the state, and that changed when export
 * became a dialog. It used to be `currentSheet(state)`, which existed because a bake outlived the
 * click that made it and could therefore go stale — twenty-four reducer cases and a key comparison
 * to answer "is that still the sheet for this document?". The dialog rebakes on every change it can
 * see, so the sheet it hands over is by construction the one it is showing. There is no staleness
 * left to detect, and nothing here has to detect it.
 *
 * `Files` comes in rather than being reached for, and it is the same port Open, Save and the palette
 * loader use — see `doc/files.ts`. It used to be an anchor built three modules down, so an export
 * was the one thing the artist ships that no test could read the bytes of.
 */

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
export const exportMetadata = (state: AppState, sheet: Sheet): SheetMetadata =>
    sheetMetadata(
        shownVolume(state.volume, state.objects),
        state.cameras,
        sheet,
        state.output.bounds
    )

/** Everything the artist ticked, in one `.zip` — the dialog's primary button. */
export const writeExportPack = async (
    files: Files,
    state: AppState,
    sheet: Sheet,
    maps: readonly SheetMap[]
): Promise<void> => {
    await writePack(files, sheet, maps, exportMetadata(state, sheet), state.doc.name)
}

/** The same maps, loose in the downloads folder, for anyone who does not want an archive. */
export const writeLoose = async (
    files: Files,
    sheet: Sheet,
    maps: readonly SheetMap[]
): Promise<void> => {
    await writeSheet(files, sheet, maps)
}

/** One PNG per camera, cut out of the sheet — `FEATURESET.md` §17. */
export const writeSprites = async (files: Files, state: AppState, sheet: Sheet): Promise<void> => {
    await Promise.all(
        state.cameras.map((entry, index) => writeSprite(files, sheet, index, entry.name))
    )
}

/** The metadata JSON on its own, for a sheet the artist already has. */
export const writeSheetMetadata = async (
    files: Files,
    state: AppState,
    sheet: Sheet
): Promise<void> => {
    await writeMetadata(files, exportMetadata(state, sheet))
}
