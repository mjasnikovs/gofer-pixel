import type {Sheet, SheetMap} from './sheet'

/**
 * Which of a sheet's maps carry nothing, so the export can stop offering them.
 *
 * Two of the eight can come out blank through no fault of the render. **Emission** is black unless
 * a palette entry the model actually uses has a glow set, and most models have none. **Object id**
 * is one flat value until the artist splits the model, and a freshly opened `.vox` is one object
 * holding everything. Shipping either is a PNG the engine loads, samples and gets nothing from.
 *
 * The question is asked of the *baked sheet* rather than of the volume, and that is the design
 * decision in this file. "No voxel glows" and "this sheet's emission map is black" are not the same
 * question: a glowing object can be hidden, sliced away, or simply behind the model from every
 * camera on the list. The sheet is what would be written, so the sheet is what gets measured, and
 * the answer cannot disagree with the file.
 *
 * The other six are left alone. Colour, normal, depth, height and occlusion are never uniform for
 * anything with geometry in it, and the palette index is data even when the palette has one entry
 * in it — an engine reading indices wants the index, not an opinion about how many there are.
 */

/** Every pixel black, whatever its alpha: the emission map of a model with nothing glowing in it. */
const unlit = (plane: Uint8Array): boolean => {
    for (let at = 0; at < plane.length; at += 4) {
        if (plane[at] !== 0 || plane[at + 1] !== 0 || plane[at + 2] !== 0) return false
    }
    return true
}

/**
 * One id across every pixel the model painted.
 *
 * Transparent pixels are skipped rather than counted as a second value: the gaps between sprites
 * are padding, and a map is not informative because it has a background.
 */
const uniform = (plane: Uint8Array): boolean => {
    let seen: number | undefined
    for (let at = 0; at < plane.length; at += 4) {
        if (plane[at + 3] === 0) continue
        const value = plane[at]
        if (seen === undefined) seen = value
        else if (value !== seen) return false
    }
    return true
}

/**
 * The maps of this sheet that would be written blank.
 *
 * A map the sheet was not baked with is **not** in the set. Absent and empty are different answers,
 * and the one thing this must never do is report a map as blank because nobody rendered it.
 */
export const emptyMaps = (sheet: Sheet): ReadonlySet<SheetMap> => {
    const empty = new Set<SheetMap>()
    const emission = sheet.maps.emission
    if (emission && unlit(emission)) empty.add('emission')
    const object = sheet.maps.object
    if (object && uniform(object)) empty.add('object')
    return empty
}
