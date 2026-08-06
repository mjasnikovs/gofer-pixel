import {createImage, type RgbaImage} from '../image/rgba'
import {flattenFrame, type Document} from '../doc/document'
import type {Volume} from '../doc/volume'
import type {GridSize} from '../vox/grid'
import {EMPTY} from '../vox/palette'

/**
 * The three orthographic views of `PRODUCTION_PLAN.md` §6, and the picking that makes them
 * editable. All of it is pure: a view is a mapping from volume axes to screen axes plus a depth
 * order, and every question the 3D mode asks — what did I click on, where does a new voxel go —
 * is answered by walking one ray in that order.
 *
 * Screen y runs down, volume z runs up and volume y runs away from the camera, so two of the three
 * views flip an axis. That flipping lives here and nowhere else, exactly as `flipY` does for the
 * slice canvas.
 */
export type OrthoView = 'top' | 'front' | 'side'

export type Axis = 'x' | 'y' | 'z'

export interface ViewMapping {
    /** Volume axis drawn left→right. */
    h: Axis
    /** Volume axis drawn top→bottom, after `flipV`. */
    v: Axis
    /** Volume axis running away from the camera. */
    d: Axis
    /** The v axis counts down the screen rather than up. */
    flipV: boolean
    /** The nearest voxel is the one with the *largest* d, not the smallest. */
    nearIsMax: boolean
}

export const VIEWS: Record<OrthoView, ViewMapping> = {
    // looking straight down: x right, y away from the viewer up the screen, nearest is the top
    top: {h: 'x', v: 'y', d: 'z', flipV: true, nearIsMax: true},
    // looking at the front face: x right, z up the screen, nearest is the smallest depth
    front: {h: 'x', v: 'z', d: 'y', flipV: true, nearIsMax: false},
    // looking from +x: y right, z up the screen
    side: {h: 'y', v: 'z', d: 'x', flipV: true, nearIsMax: true}
}

const extent = (size: GridSize, axis: Axis): number =>
    axis === 'x' ? size.sx
    : axis === 'y' ? size.sy
    : size.sz

export const viewSize = (view: OrthoView, size: GridSize): {width: number; height: number} => {
    const mapping = VIEWS[view]
    return {width: extent(size, mapping.h), height: extent(size, mapping.v)}
}

export type Voxel = [number, number, number]

const compose = (mapping: ViewMapping, h: number, v: number, d: number): Voxel => {
    const out: Record<Axis, number> = {x: 0, y: 0, z: 0}
    out[mapping.h] = h
    out[mapping.v] = v
    out[mapping.d] = d
    return [out.x, out.y, out.z]
}

/** The voxel a screen cell looks through, ordered nearest first. */
export const rayFor = (view: OrthoView, h: number, v: number, size: GridSize): Voxel[] => {
    const mapping = VIEWS[view]
    const depth = extent(size, mapping.d)
    const height = extent(size, mapping.v)
    const vv = mapping.flipV ? height - 1 - v : v
    return Array.from({length: depth}, (_unused, i) =>
        compose(mapping, h, vv, mapping.nearIsMax ? depth - 1 - i : i)
    )
}

export interface PickOptions {
    /** Restrict the ray to one z slice — §6's slice lock. */
    lockZ?: number
}

const onLockedSlice = ([, , z]: Voxel, options: PickOptions): boolean =>
    options.lockZ === undefined || z === options.lockZ

/** The nearest occupied voxel a screen cell sees, or null through empty space. */
export const pickSurface = (
    volume: Volume,
    view: OrthoView,
    h: number,
    v: number,
    size: GridSize,
    options: PickOptions = {}
): Voxel | null => {
    for (const voxel of rayFor(view, h, v, size)) {
        if (!onLockedSlice(voxel, options)) {
            continue
        }
        if (volume.get(voxel[0], voxel[1], voxel[2]) !== EMPTY) {
            return voxel
        }
    }
    return null
}

/**
 * Where an attach brush puts a voxel: the empty cell in front of the nearest surface, or — if the
 * ray misses everything — the far end, so a stroke on empty space still lands on the floor of the
 * volume rather than doing nothing.
 */
export const pickAttach = (
    volume: Volume,
    view: OrthoView,
    h: number,
    v: number,
    size: GridSize,
    options: PickOptions = {}
): Voxel | null => {
    const ray = rayFor(view, h, v, size).filter(voxel => onLockedSlice(voxel, options))
    let previous: Voxel | null = null
    for (const voxel of ray) {
        if (volume.get(voxel[0], voxel[1], voxel[2]) !== EMPTY) {
            return previous
        }
        previous = voxel
    }
    return ray[ray.length - 1] ?? null
}

export interface OrthoOptions {
    /** Darken with distance so the shape reads as a solid rather than a flat silhouette. */
    shade?: boolean
    /** Draw only this z slice, the rest faded — the visual half of slice lock. */
    lockZ?: number
    /** How strongly the out-of-slice voxels show when `lockZ` is set. */
    lockAlpha?: number
}

/**
 * One orthographic view of a frame, one pixel per voxel.
 *
 * Nearest voxel wins, which is a z-buffer with a fixed traversal order rather than a comparison —
 * the ray is already sorted, so the first hit is the answer.
 */
export const renderOrtho = (
    doc: Document,
    frame: number,
    view: OrthoView,
    {shade = true, lockZ, lockAlpha = 0.3}: OrthoOptions = {}
): RgbaImage => {
    const volume = flattenFrame(doc, frame)
    const {width, height} = viewSize(view, doc.size)
    const image = createImage(width, height)
    const depth = extent(doc.size, VIEWS[view].d)

    for (let v = 0; v < height; v += 1) {
        for (let h = 0; h < width; h += 1) {
            const ray = rayFor(view, h, v, doc.size)
            for (let i = 0; i < ray.length; i += 1) {
                const voxel = ray[i]
                if (!voxel) {
                    continue
                }
                const color = volume.get(voxel[0], voxel[1], voxel[2])
                const rgba = color === EMPTY ? undefined : doc.palette[color - 1]
                if (!rgba || rgba.a === 0) {
                    continue
                }
                const near = shade ? 1 - (0.45 * i) / Math.max(depth - 1, 1) : 1
                const dim = lockZ !== undefined && voxel[2] !== lockZ ? lockAlpha : 1
                image.data.set(
                    [
                        Math.round(rgba.r * near),
                        Math.round(rgba.g * near),
                        Math.round(rgba.b * near),
                        Math.round(rgba.a * dim)
                    ],
                    (v * width + h) * 4
                )
                break
            }
        }
    }
    return image
}

/** Canvas pixel coordinates to a screen cell of an orthographic view. */
export const toCell = (
    clientX: number,
    clientY: number,
    rect: {left: number; top: number; width: number; height: number},
    view: OrthoView,
    size: GridSize
): [number, number] => {
    const {width, height} = viewSize(view, size)
    const h = Math.floor(((clientX - rect.left) / rect.width) * width)
    const v = Math.floor(((clientY - rect.top) / rect.height) * height)
    return [Math.max(0, Math.min(width - 1, h)), Math.max(0, Math.min(height - 1, v))]
}
