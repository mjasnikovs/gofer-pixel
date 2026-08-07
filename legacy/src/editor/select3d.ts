import {EMPTY} from '../vox/palette'
import type {GridSize} from '../vox/grid'
import type {Volume} from '../doc/volume'
import {brushTarget, type Brush3D} from './brush3d'
import type {OrthoView, Voxel} from './view3d'

/**
 * The selection half of `PRODUCTION_PLAN.md` §6: box select, region select, and the three colour
 * operations. All of them answer the same question — *which voxels* — and hand the answer to
 * `applyVoxels`, so what happens to them is still the brush's business.
 *
 * A 3D selection is a plain list of voxels rather than a mask like `src/doc/selection.ts`. A mask
 * over a 32³ volume would be 32 KB per selection to hold mostly zeroes; the lists here are the
 * size of what was actually picked.
 */
export interface Box3 {
    x0: number
    y0: number
    z0: number
    x1: number
    y1: number
    z1: number
}

export const boxOf = (a: Voxel, b: Voxel): Box3 => ({
    x0: Math.min(a[0], b[0]),
    y0: Math.min(a[1], b[1]),
    z0: Math.min(a[2], b[2]),
    x1: Math.max(a[0], b[0]),
    y1: Math.max(a[1], b[1]),
    z1: Math.max(a[2], b[2])
})

export const boxVoxels = (box: Box3): Voxel[] => {
    const out: Voxel[] = []
    for (let x = box.x0; x <= box.x1; x += 1) {
        for (let y = box.y0; y <= box.y1; y += 1) {
            for (let z = box.z0; z <= box.z1; z += 1) {
                out.push([x, y, z])
            }
        }
    }
    return out
}

/** The occupied voxels inside a box. Empty space is never part of a selection. */
export const selectBox = (volume: Volume, box: Box3): Voxel[] =>
    boxVoxels(box).filter(([x, y, z]) => volume.get(x, y, z) !== EMPTY)

/** Drag a box between two picked voxels in one of the orthographic views. */
export const boxFromDrag = (
    volume: Volume,
    view: OrthoView,
    from: [number, number],
    to: [number, number],
    size: GridSize,
    brush: Brush3D
): Box3 | null => {
    const a = brushTarget(volume, view, from[0], from[1], size, brush)
    const b = brushTarget(volume, view, to[0], to[1], size, brush)
    return a && b ? boxOf(a, b) : null
}

/**
 * Region select: the connected run of one colour, walking the six face neighbours.
 *
 * Face neighbours only, not the 26 — two blocks touching at a corner are two shapes to the eye,
 * and treating them as one is the classic way a region select swallows the whole model.
 */
export const selectRegion = (volume: Volume, seed: Voxel, size: GridSize): Voxel[] => {
    const color = volume.get(seed[0], seed[1], seed[2])
    if (color === EMPTY) {
        return []
    }
    const key = ([x, y, z]: Voxel): number => (z * size.sy + y) * size.sx + x
    const seen = new Set<number>([key(seed)])
    const out: Voxel[] = []
    const queue: Voxel[] = [seed]

    while (queue.length > 0) {
        const voxel = queue.pop()
        if (!voxel) {
            break
        }
        out.push(voxel)
        const [x, y, z] = voxel
        const neighbours: Voxel[] = [
            [x + 1, y, z],
            [x - 1, y, z],
            [x, y + 1, z],
            [x, y - 1, z],
            [x, y, z + 1],
            [x, y, z - 1]
        ]
        for (const next of neighbours) {
            const [nx, ny, nz] = next
            if (nx < 0 || ny < 0 || nz < 0 || nx >= size.sx || ny >= size.sy || nz >= size.sz) {
                continue
            }
            const id = key(next)
            if (!seen.has(id) && volume.get(nx, ny, nz) === color) {
                seen.add(id)
                queue.push(next)
            }
        }
    }
    return out
}

/** Eyedropper: the colour of the nearest surface under a screen cell, or null through space. */
export const pickColor = (
    volume: Volume,
    view: OrthoView,
    h: number,
    v: number,
    size: GridSize,
    brush: Brush3D
): number | null => {
    const hit = brushTarget(volume, view, h, v, size, {...brush, mode: 'paint'})
    if (!hit) {
        return null
    }
    const color = volume.get(hit[0], hit[1], hit[2])
    return color === EMPTY ? null : color
}

/** Every voxel of one colour, for remove-colour and replace-colour. */
export const voxelsOfColor = (volume: Volume, color: number): Voxel[] => {
    const out: Voxel[] = []
    volume.forEach((x, y, z, value) => {
        if (value === color) {
            out.push([x, y, z])
        }
    })
    return out
}

/** Delete every voxel of one colour. Returns how many went. */
export const removeColor = (volume: Volume, color: number): number => {
    let changed = 0
    for (const [x, y, z] of voxelsOfColor(volume, color)) {
        if (volume.set(x, y, z, EMPTY)) {
            changed += 1
        }
    }
    return changed
}
