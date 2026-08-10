import {DEFAULT_COLUMNS} from '../sheet/sheet'

/**
 * How big a sprite is drawn in the export preview, as opposed to how big it is.
 *
 * Its own file because the export dialog is a component and this is arithmetic — and because the
 * question it answers has nothing to do with React: given a strip of screen and a sheet packed a
 * certain way, how many screen pixels can one sprite pixel have without being a fraction.
 */

/** The gap between preview cells, in CSS pixels. Kept with `.export-grid`'s own `gap`. */
const PREVIEW_GAP = 4

/**
 * How many screen pixels one sprite pixel gets, as a whole number.
 *
 * Measured in Chromium before this existed: a 64 px sprite was drawn 129.856 px wide, a scale of
 * 2.029, because the canvas was `width: 100%` of a fluid grid column. Under `image-rendering:
 * pixelated` a fractional scale is most source pixels at two screen pixels and every thirty-fourth
 * at three — a stagger along every edge, and worst where two edges meet.
 *
 * That is the one thing this dialog is not allowed to do. `PixelCanvas`'s own comment says a sprite
 * preview that resamples is a lie about what the file will contain, and it was resampling in the
 * only panel whose job is to show what lands on disk.
 *
 * Never below 1: a sprite wider than its column is better clipped by the grid than shrunk, because
 * a half-scale preview is the same lie in the other direction.
 */
export const previewScale = (
    available: number,
    cellW: number,
    columns = DEFAULT_COLUMNS
): number => {
    const each = (available - PREVIEW_GAP * (columns - 1)) / columns
    return Math.max(1, Math.floor(each / cellW))
}

/**
 * The tallest a scrolling list can be without cutting a row in half.
 *
 * The map list scrolls when the dialog is short — astryx caps itself at 75vh, so a 720 px window
 * leaves it about 148 px of the 295 it wants. Left to flex it stopped wherever the space ran out,
 * which at a 900 px window was seven rows and a sliver of the eighth: a scrollbar for half an item,
 * and a row sliced through the middle reads as a rendering fault rather than as a list with more
 * in it.
 *
 * Same rule as `previewScale` one function up. Nothing on screen is a fraction of a thing.
 *
 * `edges` is where each row *ends*, cumulative, in the list's own coordinates — not a row height.
 * An average height was tried and leaves a sliver showing: the rows are separated by a one-pixel
 * rule that the first one does not carry, so the mean is a fraction of a pixel too big and eight
 * of them reach past the eighth row's real bottom.
 *
 * The first edge is the floor. A list too short for even one row is still a list, and hiding it
 * would lose the border that says so.
 */
export const wholeRows = (available: number, edges: readonly number[]): number => {
    const first = edges[0]
    if (first === undefined) return available
    let best = first
    for (const edge of edges) if (edge <= available) best = edge
    return best
}
