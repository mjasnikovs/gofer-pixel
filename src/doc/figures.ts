import type {Axis, Offset} from './brush'

/**
 * Pixel-editor figures, drawn in 3D — `FEATURESET.md` §5.
 *
 * A figure is drawn between two cells on one plane: the cell the pointer went down on and the cell
 * it is over now. Every one of them returns cells rather than writing, so the caller can stamp the
 * brush on each and mirror the lot through symmetry, exactly as a freehand stroke does.
 *
 * The rectangle comes in both outline and solid; the ellipse is outline only, because a solid disc
 * is the round brush at the size you want it and the ellipse is not.
 */
export const FIGURES = ['free', 'line', 'rect', 'rectFill', 'ellipse'] as const
export type Figure = (typeof FIGURES)[number]

/** A 3D Bresenham, so a line works whether or not the two ends share a plane. */
export const lineFigure = (from: Offset, to: Offset): readonly Offset[] => {
    const steps = Math.max(
        Math.abs(to[0] - from[0]),
        Math.abs(to[1] - from[1]),
        Math.abs(to[2] - from[2])
    )
    const cells: Offset[] = []
    for (let i = 0; i <= steps; i += 1) {
        const t = steps === 0 ? 0 : i / steps
        cells.push([
            Math.round(from[0] + (to[0] - from[0]) * t),
            Math.round(from[1] + (to[1] - from[1]) * t),
            Math.round(from[2] + (to[2] - from[2]) * t)
        ])
    }
    return cells
}

/** The two axes of the plane a figure is drawn on: the two that are not the plane's own. */
const planeAxes = (axis: Axis): readonly [Axis, Axis] => [axis === 0 ? 1 : 0, axis === 2 ? 1 : 2]

const box = (
    from: Offset,
    to: Offset,
    axis: Axis
): {u: Axis; v: Axis; u0: number; u1: number; v0: number; v1: number} => {
    const [u, v] = planeAxes(axis)
    return {
        u,
        v,
        u0: Math.min(from[u], to[u]),
        u1: Math.max(from[u], to[u]),
        v0: Math.min(from[v], to[v]),
        v1: Math.max(from[v], to[v])
    }
}

const at = (axis: Axis, layer: number, u: Axis, uv: number, v: Axis, vv: number): Offset => {
    const cell: [number, number, number] = [0, 0, 0]
    cell[axis] = layer
    cell[u] = uv
    cell[v] = vv
    return cell
}

export const rectFigure = (from: Offset, to: Offset, axis: Axis): readonly Offset[] => {
    const {u, v, u0, u1, v0, v1} = box(from, to, axis)
    const layer = from[axis]
    const cells: Offset[] = []
    for (let a = u0; a <= u1; a += 1) {
        cells.push(at(axis, layer, u, a, v, v0))
        if (v1 !== v0) cells.push(at(axis, layer, u, a, v, v1))
    }
    for (let b = v0 + 1; b < v1; b += 1) {
        cells.push(at(axis, layer, u, u0, v, b))
        if (u1 !== u0) cells.push(at(axis, layer, u, u1, v, b))
    }
    return cells
}

/** Every cell of the dragged box, not just its border. */
export const rectFillFigure = (from: Offset, to: Offset, axis: Axis): readonly Offset[] => {
    const {u, v, u0, u1, v0, v1} = box(from, to, axis)
    const layer = from[axis]
    const cells: Offset[] = []
    for (let b = v0; b <= v1; b += 1) {
        for (let a = u0; a <= u1; a += 1) cells.push(at(axis, layer, u, a, v, b))
    }
    return cells
}

/**
 * The boundary of the ellipse inscribed in the dragged box.
 *
 * Found by asking which cells are inside and which of those have a neighbour that is not, rather
 * than by a midpoint algorithm. It costs the area of the box instead of its perimeter — irrelevant
 * at the size a voxel figure ever is — and in exchange it cannot leave the one-voxel gaps a
 * midpoint rasteriser leaves at the shallow ends of a wide ellipse.
 */
export const ellipseFigure = (from: Offset, to: Offset, axis: Axis): readonly Offset[] => {
    const {u, v, u0, u1, v0, v1} = box(from, to, axis)
    const layer = from[axis]
    const cu = (u0 + u1) / 2
    const cv = (v0 + v1) / 2
    const ru = (u1 - u0) / 2 + 0.5
    const rv = (v1 - v0) / 2 + 0.5
    const inside = (a: number, b: number): boolean => {
        if (a < u0 || a > u1 || b < v0 || b > v1) return false
        const du = (a - cu) / ru
        const dv = (b - cv) / rv
        return du * du + dv * dv <= 1
    }

    const cells: Offset[] = []
    for (let b = v0; b <= v1; b += 1) {
        for (let a = u0; a <= u1; a += 1) {
            if (!inside(a, b)) continue
            const edge =
                !inside(a - 1, b) || !inside(a + 1, b) || !inside(a, b - 1) || !inside(a, b + 1)
            if (edge) cells.push(at(axis, layer, u, a, v, b))
        }
    }
    return cells
}

export const figureCells = (
    figure: Figure,
    from: Offset,
    to: Offset,
    axis: Axis
): readonly Offset[] => {
    switch (figure) {
        case 'line':
            return lineFigure(from, to)
        case 'rect':
            return rectFigure(from, to, axis)
        case 'rectFill':
            return rectFillFigure(from, to, axis)
        case 'ellipse':
            return ellipseFigure(from, to, axis)
        case 'free':
            return lineFigure(from, to)
    }
}
