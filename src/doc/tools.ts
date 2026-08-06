import {EMPTY} from '../vox/palette'
import type {GridSize} from '../vox/grid'
import type {Volume} from './volume'

/**
 * Drawing operations, all of them on one z slice of a volume.
 *
 * They mutate the volume they are given, which is only safe inside `editCel` — that hands over a
 * private clone. Each returns the number of voxels it changed, so a tool that did nothing can be
 * dropped before it reaches the undo stack.
 *
 * Mirror is applied here rather than as a post-pass, so a stroke and its reflection land in the
 * same undo entry and a mirrored erase erases both sides.
 */
export interface ToolContext {
    size: GridSize
    mirrorX?: boolean
    mirrorY?: boolean
}

const inCanvas = ({sx, sy, sz}: GridSize, x: number, y: number, z: number): boolean =>
    x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz

/** Write one voxel and, if mirroring is on, its reflections. Clipped to the canvas. */
export const plot = (
    volume: Volume,
    {size, mirrorX, mirrorY}: ToolContext,
    x: number,
    y: number,
    z: number,
    color: number
): number => {
    let changed = 0
    const xs = mirrorX === true ? new Set([x, size.sx - 1 - x]) : [x]
    const ys = mirrorY === true ? new Set([y, size.sy - 1 - y]) : [y]
    for (const px of xs) {
        for (const py of ys) {
            if (inCanvas(size, px, py, z) && volume.set(px, py, z, color)) {
                changed += 1
            }
        }
    }
    return changed
}

/** Bresenham, so a fast drag does not leave gaps between sampled points. */
export const line = (
    volume: Volume,
    ctx: ToolContext,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    z: number,
    color: number
): number => {
    let x = x0
    let y = y0
    const dx = Math.abs(x1 - x0)
    const dy = -Math.abs(y1 - y0)
    const stepX = x0 < x1 ? 1 : -1
    const stepY = y0 < y1 ? 1 : -1
    let error = dx + dy
    let changed = 0

    for (;;) {
        changed += plot(volume, ctx, x, y, z, color)
        if (x === x1 && y === y1) {
            return changed
        }
        const doubled = 2 * error
        if (doubled >= dy) {
            error += dy
            x += stepX
        }
        if (doubled <= dx) {
            error += dx
            y += stepY
        }
    }
}

export const rect = (
    volume: Volume,
    ctx: ToolContext,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    z: number,
    color: number,
    filled = true
): number => {
    const lox = Math.min(x0, x1)
    const hix = Math.max(x0, x1)
    const loy = Math.min(y0, y1)
    const hiy = Math.max(y0, y1)
    let changed = 0
    for (let y = loy; y <= hiy; y += 1) {
        for (let x = lox; x <= hix; x += 1) {
            const onEdge = x === lox || x === hix || y === loy || y === hiy
            if (filled || onEdge) {
                changed += plot(volume, ctx, x, y, z, color)
            }
        }
    }
    return changed
}

/** Ellipse inscribed in the dragged box, by distance test, filled or outline. */
export const ellipse = (
    volume: Volume,
    ctx: ToolContext,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    z: number,
    color: number,
    filled = true
): number => {
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    const rx = Math.abs(x1 - x0) / 2 + 0.5
    const ry = Math.abs(y1 - y0) / 2 + 0.5
    let changed = 0

    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += 1) {
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += 1) {
            const dx = (x - cx) / rx
            const dy = (y - cy) / ry
            const d = dx * dx + dy * dy
            if (d > 1) {
                continue
            }
            if (filled) {
                changed += plot(volume, ctx, x, y, z, color)
                continue
            }
            // outline: keep the cell only when a 4-neighbour falls outside the ellipse
            const outside = [
                [x - 1, y],
                [x + 1, y],
                [x, y - 1],
                [x, y + 1]
            ].some(([nx, ny]) => {
                const ex = ((nx ?? 0) - cx) / rx
                const ey = ((ny ?? 0) - cy) / ry
                return ex * ex + ey * ey > 1
            })
            if (outside) {
                changed += plot(volume, ctx, x, y, z, color)
            }
        }
    }
    return changed
}

/**
 * 4-connected flood fill inside one slice.
 *
 * Explicitly scanline-free and iterative: a recursive fill blows the stack on a 64² slice, and a
 * queue is fast enough at these sizes. Filling with the colour already there is a no-op rather
 * than an infinite loop.
 */
export const floodFill = (
    volume: Volume,
    ctx: ToolContext,
    x: number,
    y: number,
    z: number,
    color: number
): number => {
    const {size} = ctx
    if (!inCanvas(size, x, y, z)) {
        return 0
    }
    const target = volume.get(x, y, z)
    if (target === color) {
        return 0
    }

    // find the whole region before painting any of it: with mirroring on, painting as we go
    // would overwrite cells the search has not visited yet and stop the fill short
    const region: [number, number][] = []
    const seen = new Set<number>([y * size.sx + x])
    const queue: [number, number][] = [[x, y]]
    while (queue.length > 0) {
        const cell = queue.pop()
        if (!cell) {
            break
        }
        const [cxx, cyy] = cell
        region.push(cell)
        for (const [nx, ny] of [
            [cxx - 1, cyy],
            [cxx + 1, cyy],
            [cxx, cyy - 1],
            [cxx, cyy + 1]
        ] as [number, number][]) {
            const key = ny * size.sx + nx
            if (inCanvas(size, nx, ny, z) && !seen.has(key) && volume.get(nx, ny, z) === target) {
                seen.add(key)
                queue.push([nx, ny])
            }
        }
    }

    let changed = 0
    for (const [rx, ry] of region) {
        changed += plot(volume, ctx, rx, ry, z, color)
    }
    return changed
}

/** Swap one palette index for another across the whole volume. */
export const replaceColor = (volume: Volume, from: number, to: number): number => {
    if (from === to) {
        return 0
    }
    const hits: [number, number, number][] = []
    volume.forEach((x, y, z, color) => {
        if (color === from) {
            hits.push([x, y, z])
        }
    })
    for (const [x, y, z] of hits) {
        volume.set(x, y, z, to)
    }
    return hits.length
}

/** Copy one slice onto another — the 2D mode's main way of building depth. */
export const copySlice = (
    volume: Volume,
    {size}: ToolContext,
    from: number,
    to: number
): number => {
    if (from === to || to < 0 || to >= size.sz) {
        return 0
    }
    const cells: [number, number, number][] = []
    for (let y = 0; y < size.sy; y += 1) {
        for (let x = 0; x < size.sx; x += 1) {
            cells.push([x, y, volume.get(x, y, from)])
        }
    }
    let changed = 0
    for (const [x, y, color] of cells) {
        if (volume.set(x, y, to, color)) {
            changed += 1
        }
    }
    return changed
}

/** Mirror the lower half of an axis onto the upper, for a whole volume. */
export const mirrorVolume = (volume: Volume, {size}: ToolContext, axis: 'x' | 'y'): number => {
    const cells: [number, number, number, number][] = []
    volume.forEach((x, y, z, color) => {
        const half = axis === 'x' ? size.sx / 2 : size.sy / 2
        const along = axis === 'x' ? x : y
        if (along < half && color !== EMPTY) {
            cells.push([x, y, z, color])
        }
    })
    let changed = 0
    for (const [x, y, z, color] of cells) {
        const mx = axis === 'x' ? size.sx - 1 - x : x
        const my = axis === 'y' ? size.sy - 1 - y : y
        if (volume.set(mx, my, z, color)) {
            changed += 1
        }
    }
    return changed
}
