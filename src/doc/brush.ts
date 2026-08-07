import {FACE_Z_POS} from '../render/faces'

/**
 * The brush of `docs/editor.png`: a kind, a size and one of four footprints.
 *
 * It lives in `doc/` rather than in the app because the footprint is document arithmetic — which
 * cells a click writes — and a `bun test` of it needs no window. The panel that sets it is a
 * projection of this, the same way the viewport is a projection of the volume.
 */
export const SHAPES = ['square', 'circle', 'ring', 'cube'] as const
export type Shape = (typeof SHAPES)[number]

export const BRUSH_KINDS = ['voxel', 'face', 'plane'] as const
export type BrushKind = (typeof BRUSH_KINDS)[number]

/** A brush wider than eight voxels is a fill, and there is a fill tool two rows down. */
export const MAX_BRUSH = 8

export interface Brush {
    readonly kind: BrushKind
    readonly size: number
    readonly shape: Shape
}

/** A cell of the footprint, relative to the voxel under the cursor. */
export type Offset = readonly [number, number, number]

/** Which axis a face code names: `0` = x, `1` = y, `2` = z. Face codes are 1-based and paired. */
export const faceAxis = (face: number): number => Math.max(0, (face - 1) >> 1)

/**
 * Where a run of `size` cells sits around the cursor.
 *
 * An odd size centres on the clicked voxel. An even size has no centre cell, so it grows towards
 * `+`, which is the convention every pixel editor uses and the only one that keeps a size-2 brush
 * from jumping a voxel when the artist steps 2 → 3.
 */
const span = (size: number): {lo: number; hi: number} => {
    const lo = -Math.floor((size - 1) / 2)
    return {lo, hi: lo + size - 1}
}

/**
 * A disc measured from cell centres, radius `size / 2`.
 *
 * At size 3 that admits the corners and the circle is a 3×3 square — every radius small enough to
 * exclude them also excludes the edges and leaves a plus, and a plus is not a brush anyone asked
 * for. From 4 up it is a proper disc.
 */
const inDisc = (du: number, dv: number, radius: number): boolean =>
    du * du + dv * dv <= radius * radius

export const brushOffsets = ({size, shape}: Brush, face = FACE_Z_POS): readonly Offset[] => {
    const {lo, hi} = span(size)
    const radius = size / 2
    // The cell centre of index `i` is `i + 0.5`; the brush centre sits at `lo + size / 2`.
    const off = (i: number): number => i + 0.5 - (lo + radius)
    const offsets: Offset[] = []

    if (shape === 'cube') {
        for (let z = lo; z <= hi; z += 1) {
            for (let y = lo; y <= hi; y += 1) {
                for (let x = lo; x <= hi; x += 1) offsets.push([x, y, z])
            }
        }
        return offsets
    }

    // A flat footprint lies in the plane of the face being drawn on, so the two axes it spreads
    // over are the two that are not the face's own.
    const axis = faceAxis(face)
    const u = axis === 0 ? 1 : 0
    const v = axis === 2 ? 1 : 2
    for (let b = lo; b <= hi; b += 1) {
        for (let a = lo; a <= hi; a += 1) {
            if (shape === 'circle' && !inDisc(off(a), off(b), radius)) continue
            if (
                shape === 'ring'
                && (!inDisc(off(a), off(b), radius) || inDisc(off(a), off(b), radius - 1))
            ) {
                continue
            }
            const cell: [number, number, number] = [0, 0, 0]
            cell[u] = a
            cell[v] = b
            offsets.push(cell)
        }
    }
    return offsets
}
