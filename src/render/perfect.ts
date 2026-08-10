import {basisFor, type Camera} from './camera'
import type {Volume} from './volume'

/**
 * Whether a voxel lands on whole pixels, and at which zooms it would.
 *
 * `FEATURESET.md` opens by asking for pixel-perfectness as a hard constraint of the engine rather
 * than something the artist has to remember, and §14 spells one half of it as "integer zoom". That
 * is the wrong invariant and this module exists to replace it. Zoom is how many voxels tall the
 * frame is; what an artist can see is how many *pixels* tall a voxel is, and rounding the first
 * does nothing for the second. Measured on the default camera of a 16³ model — zoom 31, cell 64 —
 * a row of voxels comes out `3 2 2 2 2 2 2 2 3`. Integer zoom, uneven staircase.
 *
 * Everything here is derived from `basisFor`, never from a second copy of the projection. The
 * renderer's snap and its `Math.fround` are part of the answer: a camera the artist calls
 * axis-aligned has to be axis-aligned to this module too, or it reports an irrational step for a
 * front view.
 */

/** Where one voxel step along a world axis lands on screen, in pixels. */
export interface Step {
    readonly dx: number
    readonly dy: number
}

/** One voxel's three edges, as the screen vectors they project to at this zoom and output size. */
export interface Steps {
    readonly x: Step
    readonly y: Step
    readonly z: Step
}

/**
 * A pixel grid is integers, so "whole" is a tolerance rather than an equality.
 *
 * Loose enough to survive `Math.fround` on the basis and the division that makes a step — that is
 * float32, so a ratio is only good to about seven digits — and tight enough that the irrationals
 * this projection actually produces are never mistaken for integers. The closest call is `√2`, at
 * 0.414 from the nearest one; nothing here lands within 1e-4 of an integer without being one.
 */
const TOLERANCE = 1e-4

export const isWhole = (value: number): boolean => Math.abs(value - Math.round(value)) < TOLERANCE

/** Pixels per voxel along the ray's own axes: the scale, read the useful way round. */
export const pixelsPerVoxel = (camera: Camera, cell: number): number => cell / camera.zoom

/**
 * The three edges of a voxel, projected.
 *
 * Built through `basisFor` at zero pan, because pan slides the whole lattice and cannot change the
 * length of an edge. The volume is needed only because a basis is built against one; the answer
 * does not depend on its size.
 */
export const voxelSteps = (camera: Camera, volume: Volume, cell: number): Steps => {
    const basis = basisFor({...camera, panX: 0, panY: 0}, volume, cell)
    const {right, up, scale} = basis
    const px = 1 / scale
    const project = (i: 0 | 1 | 2): Step => ({dx: right[i] * px, dy: up[i] * px})
    return {x: project(0), y: project(1), z: project(2)}
}

/**
 * Whether every edge of a voxel spans a whole number of pixels.
 *
 * All six components, not three: at any yaw off the axes a voxel's x edge moves across the screen
 * *and* down it, and a staircase is even only when both halves are whole. A zero component is
 * trivially whole, which is why a front view passes on two of its three axes without special
 * casing — at yaw 0 the y edge projects to nothing at all.
 */
export const isPerfect = (camera: Camera, volume: Volume, cell: number): boolean => {
    const steps = voxelSteps(camera, volume, cell)
    return [steps.x, steps.y, steps.z].every(step => isWhole(step.dx) && isWhole(step.dy))
}

/**
 * The zooms between `low` and `high` at which this camera is pixel-perfect, smallest first.
 *
 * Solved rather than swept, because the sweep is over a real number. Every step is `ppv` times a
 * fixed direction cosine, so pinning the *largest* cosine to each whole pixel in turn enumerates
 * every candidate scale there is, finely and without gaps; the other five components are then a
 * check. A camera whose cosines are in an irrational ratio — true isometric is one, `√3` apart —
 * yields nothing, and an empty list is the honest answer for it.
 */
export const perfectZooms = (
    camera: Camera,
    volume: Volume,
    cell: number,
    low: number,
    high: number
): number[] => {
    const steps = voxelSteps(camera, volume, cell)
    const parts = [steps.x.dx, steps.x.dy, steps.y.dx, steps.y.dy, steps.z.dx, steps.z.dy]
    // At the zoom the steps were measured at, so a ratio against it is a ratio of cosines.
    const at = pixelsPerVoxel(camera, cell)
    const cosines = parts.map(part => Math.abs(part) / at)
    const widest = Math.max(...cosines)
    if (widest < TOLERANCE) return []

    const found: number[] = []
    // One entry per whole pixel of the widest edge. Beyond `cell` pixels a voxel fills the frame.
    for (let pixels = 1; pixels <= cell; pixels += 1) {
        const ppv = pixels / widest
        const zoom = cell / ppv
        if (zoom < low || zoom > high) continue
        if (cosines.every(cosine => isWhole(cosine * ppv))) found.push(zoom)
    }
    return found.sort((a, b) => a - b)
}

/**
 * The pixel-perfect zoom nearest `camera.zoom`, or `undefined` when this angle has none.
 *
 * `undefined` rather than a fallback, because there is no honest fallback: a true-isometric camera
 * cannot be made to staircase evenly at any zoom, and quietly moving it to the nearest *integer*
 * would be the bug this module replaces, wearing a new name.
 */
export const nearestPerfectZoom = (
    camera: Camera,
    volume: Volume,
    cell: number,
    low: number,
    high: number
): number | undefined => {
    const zooms = perfectZooms(camera, volume, cell, low, high)
    if (zooms.length === 0) return undefined
    return zooms.reduce((best, zoom) =>
        Math.abs(zoom - camera.zoom) < Math.abs(best - camera.zoom) ? zoom : best
    )
}

/**
 * The next pixel-perfect zoom past `camera.zoom`, in the direction the wheel turned.
 *
 * Strictly past it, so a notch always moves. Rounding to nearest would leave a slow wheel stuck on
 * the stop it is already sitting on, which is the same defect the old integer snap had and fixed
 * the same way. Off the end of the list, the end of the list.
 */
export const stepPerfectZoom = (
    camera: Camera,
    volume: Volume,
    cell: number,
    up: boolean,
    low: number,
    high: number
): number | undefined => {
    const zooms = perfectZooms(camera, volume, cell, low, high)
    if (zooms.length === 0) return undefined
    const past = up ? zooms.find(zoom => zoom > camera.zoom + TOLERANCE) : undefined
    if (up) return past ?? zooms[zooms.length - 1]
    const under = zooms.filter(zoom => zoom < camera.zoom - TOLERANCE)
    return under[under.length - 1] ?? zooms[0]
}

/**
 * The cell size out of `sizes` that makes this camera perfect, nearest to `cell` first.
 *
 * The other way to fix a mismatched export: leave the view the artist composed alone and change
 * what it is rendered into. `undefined` when none of the offered sizes helps, which is every size
 * for an angle with no whole-pixel lattice at all.
 */
export const perfectCell = (
    camera: Camera,
    volume: Volume,
    cell: number,
    sizes: readonly number[]
): number | undefined =>
    [...sizes]
        .sort((a, b) => Math.abs(a - cell) - Math.abs(b - cell))
        .find(size => isPerfect(camera, volume, size))

/**
 * How many cameras on a list would export an uneven staircase at this sprite size.
 *
 * A count rather than a list, because what the export dialog has to say is how much of the sheet
 * is affected — and it is asked of every camera separately on purpose. A ring shares one zoom and
 * one pitch, so it answers as a block; a captured camera has neither, and a sheet with one
 * hand-composed view on it can be perfect in seven cells and not in the eighth.
 */
export const unevenCount = (cameras: readonly Camera[], volume: Volume, cell: number): number =>
    cameras.filter(camera => !isPerfect(camera, volume, cell)).length

/**
 * The sprite size out of `sizes` at which *every* camera on the list lands on whole pixels.
 *
 * Every one, not most: a sheet is one file and an artist offered "use 128 px" has been promised the
 * whole sheet, not five cells of it. `undefined` when no offered size fixes all of them, which is
 * the common case for every three-quarter angle the app offers.
 */
export const evenCell = (
    cameras: readonly Camera[],
    volume: Volume,
    cell: number,
    sizes: readonly number[]
): number | undefined =>
    cameras.length === 0 ?
        undefined
    :   [...sizes]
            .sort((a, b) => Math.abs(a - cell) - Math.abs(b - cell))
            .find(size => size !== cell && unevenCount(cameras, volume, size) === 0)
