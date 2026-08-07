import {TOOL_PATHS} from './tool-paths'
import type {Tool} from './state'

/**
 * The mouse pointer, drawn per tool.
 *
 * The viewport used to be a hand at all times, which said "you are looking at this" while the artist
 * was drawing into it — and said the same thing whether Draw, Erase or Fill was armed. The armed tool
 * is the single most consequential piece of state in the window and it was invisible at the one place
 * the eye actually is.
 *
 * Every cursor is a crosshair with the tool's own glyph hung off the lower right, and the hotspot is
 * the middle of the crosshair in all of them. Two reasons for that shape rather than for a bare
 * pencil or bucket:
 *
 * 1. A glyph as a cursor has to nominate one of its pixels as the point, and the honest point of a
 *    paint bucket is nowhere in particular. The crosshair is where the voxel goes, and it is the same
 *    place for all nine, so switching tools never shifts where a click lands.
 * 2. Voxels are small. A pencil drawn at cursor size covers the cell it is about to write.
 *
 * The glyph is stroked twice — a dark wide pass, then a white narrow one over it — because a cursor
 * crosses a black background, a white model and everything between within one drag, and a
 * single-colour cursor disappears against half of them.
 */
const OUTLINE = '#000'
const INK = '#fff'

/** Where the crosshair sits inside the 32-unit image, and therefore where a click lands. */
const HOT = 11

const crosshair = [
    `M${String(HOT)} 2.5v6M${String(HOT)} ${String(HOT + 2.5)}v6`,
    `M2.5 ${String(HOT)}h6M${String(HOT + 2.5)} ${String(HOT)}h6`
]

/**
 * One `url(data:…)` per tool, built once at module load.
 *
 * Inline SVG rather than PNG so it stays sharp on a scaled display, and a data URI rather than a file
 * because a cursor that arrives one network round-trip after the pointer moves is a cursor that
 * flickers on first use. The whole set is about 3 kB.
 */
const cursorFor = (tool: Tool): string => {
    const glyph = TOOL_PATHS[tool].map(d => `<path d="${d}"/>`).join('')
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">`
        + `<g fill="none" stroke-linecap="round" stroke-linejoin="round">`
        // The dark pass first, wide, under everything — this is what makes the cursor readable on a
        // white model. Then the same geometry again in white, narrow, on top.
        + `<g stroke="${OUTLINE}" stroke-width="3.4" opacity="0.85">`
        + crosshair.map(d => `<path d="${d}"/>`).join('')
        + `<g transform="translate(14.5 14.5) scale(0.8)" stroke-width="4">${glyph}</g>`
        + `</g>`
        + `<g stroke="${INK}" stroke-width="1.5">`
        + crosshair.map(d => `<path d="${d}"/>`).join('')
        + `<g transform="translate(14.5 14.5) scale(0.8)" stroke-width="1.8">${glyph}</g>`
        + `</g></g></svg>`
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${String(HOT)} ${String(HOT)}, crosshair`
}

/**
 * `crosshair` is the fallback in every one of them. A browser that will not take an image cursor
 * still has to put the artist somewhere precise, and the hand it used to show is the one answer that
 * is wrong for all nine tools.
 */
export const TOOL_CURSORS: Record<Tool, string> = {
    draw: cursorFor('draw'),
    erase: cursorFor('erase'),
    fill: cursorFor('fill'),
    pick: cursorFor('pick'),
    move: cursorFor('move'),
    rotate: cursorFor('rotate'),
    scale: cursorFor('scale'),
    clone: cursorFor('clone'),
    measure: cursorFor('measure')
}
