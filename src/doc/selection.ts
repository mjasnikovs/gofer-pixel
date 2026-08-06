import {EMPTY} from '../vox/palette'
import type {GridSize} from '../vox/grid'
import {Volume} from './volume'

/**
 * A selection is a 2D mask over the canvas, not a 3D region.
 *
 * That matches how the work is actually done: you select on the slice you are looking at, then
 * move or copy it, and a "select this blob through every slice" gesture is the odd one out rather
 * than the common case. Operations that touch voxels take the z (or z range) separately, so the
 * same mask serves both.
 */
export interface Selection {
    readonly width: number
    readonly height: number
    /** One byte per canvas cell, 1 inside the selection. */
    readonly mask: Uint8Array
}

export const emptySelection = ({sx, sy}: GridSize): Selection => ({
    width: sx,
    height: sy,
    mask: new Uint8Array(sx * sy)
})

export const isSelected = ({width, height, mask}: Selection, x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && (mask[y * width + x] ?? 0) !== 0

export const selectionCount = ({mask}: Selection): number =>
    mask.reduce<number>((n, cell) => n + (cell === 0 ? 0 : 1), 0)

export const isEmptySelection = (selection: Selection): boolean => selectionCount(selection) === 0

/** Tight box around the selected cells, or null when nothing is selected. */
export const selectionBounds = ({
    width,
    height,
    mask
}: Selection): {x0: number; y0: number; x1: number; y1: number} | null => {
    let x0 = width
    let y0 = height
    let x1 = -1
    let y1 = -1
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if ((mask[y * width + x] ?? 0) !== 0) {
                x0 = Math.min(x0, x)
                y0 = Math.min(y0, y)
                x1 = Math.max(x1, x)
                y1 = Math.max(y1, y)
            }
        }
    }
    return x1 < 0 ? null : {x0, y0, x1, y1}
}

export const rectSelection = (
    size: GridSize,
    x0: number,
    y0: number,
    x1: number,
    y1: number
): Selection => {
    const selection = emptySelection(size)
    for (
        let y = Math.max(0, Math.min(y0, y1));
        y <= Math.min(size.sy - 1, Math.max(y0, y1));
        y += 1
    ) {
        for (
            let x = Math.max(0, Math.min(x0, x1));
            x <= Math.min(size.sx - 1, Math.max(x0, x1));
            x += 1
        ) {
            selection.mask[y * size.sx + x] = 1
        }
    }
    return selection
}

/**
 * Lasso: even-odd fill of the polygon the cursor traced, sampled at cell centres.
 *
 * Even-odd rather than winding, because a lasso that crosses itself should punch a hole — that is
 * what the user drew, and it is the behaviour every other editor has.
 */
export const lassoSelection = (size: GridSize, points: readonly [number, number][]): Selection => {
    const selection = emptySelection(size)
    if (points.length < 3) {
        return selection
    }
    for (let y = 0; y < size.sy; y += 1) {
        for (let x = 0; x < size.sx; x += 1) {
            const px = x + 0.5
            const py = y + 0.5
            let inside = false
            for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
                const [xi, yi] = points[i] ?? [0, 0]
                const [xj, yj] = points[j] ?? [0, 0]
                if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
                    inside = !inside
                }
            }
            if (inside) {
                selection.mask[y * size.sx + x] = 1
            }
        }
    }
    return selection
}

/** Magic wand: the contiguous run of one colour around a cell, inside one slice. */
export const wandSelection = (
    volume: Volume,
    size: GridSize,
    x: number,
    y: number,
    z: number
): Selection => {
    const selection = emptySelection(size)
    if (x < 0 || y < 0 || x >= size.sx || y >= size.sy) {
        return selection
    }
    const target = volume.get(x, y, z)
    const queue: [number, number][] = [[x, y]]
    selection.mask[y * size.sx + x] = 1

    while (queue.length > 0) {
        const cell = queue.pop()
        if (!cell) {
            break
        }
        const [cx, cy] = cell
        for (const [nx, ny] of [
            [cx - 1, cy],
            [cx + 1, cy],
            [cx, cy - 1],
            [cx, cy + 1]
        ] as [number, number][]) {
            const at = ny * size.sx + nx
            if (
                nx >= 0
                && ny >= 0
                && nx < size.sx
                && ny < size.sy
                && selection.mask[at] === 0
                && volume.get(nx, ny, z) === target
            ) {
                selection.mask[at] = 1
                queue.push([nx, ny])
            }
        }
    }
    return selection
}

export const invertSelection = ({width, height, mask}: Selection): Selection => ({
    width,
    height,
    mask: Uint8Array.from(mask, cell => (cell === 0 ? 1 : 0))
})

const combine = (a: Selection, b: Selection, op: (x: number, y: number) => number): Selection => ({
    width: a.width,
    height: a.height,
    mask: Uint8Array.from(a.mask, (cell, i) => op(cell, b.mask[i] ?? 0))
})

export const unionSelection = (a: Selection, b: Selection): Selection =>
    combine(a, b, (x, y) => (x !== 0 || y !== 0 ? 1 : 0))

export const subtractSelection = (a: Selection, b: Selection): Selection =>
    combine(a, b, (x, y) => (x !== 0 && y === 0 ? 1 : 0))

export const intersectSelection = (a: Selection, b: Selection): Selection =>
    combine(a, b, (x, y) => (x !== 0 && y !== 0 ? 1 : 0))

/** Shift the mask itself, for dragging a marquee without moving voxels. */
export const offsetSelection = (
    {width, height, mask}: Selection,
    dx: number,
    dy: number
): Selection => {
    const moved = new Uint8Array(width * height)
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if ((mask[y * width + x] ?? 0) === 0) {
                continue
            }
            const nx = x + dx
            const ny = y + dy
            if (nx >= 0 && ny >= 0 && nx < width && ny < height) {
                moved[ny * width + nx] = 1
            }
        }
    }
    return {width, height, mask: moved}
}

/**
 * Voxels lifted out of a slice, positioned relative to the selection's top-left corner.
 *
 * Empty cells inside the selection are carried too, as index 0. Paste therefore reproduces the
 * hole in a selected donut instead of leaving whatever was underneath showing through — matching
 * what an artist sees when they drag a selection in a 2D editor.
 */
export interface Clipboard {
    readonly width: number
    readonly height: number
    readonly cells: Uint8Array
}

export const copySelection = (
    volume: Volume,
    selection: Selection,
    z: number
): Clipboard | null => {
    const box = selectionBounds(selection)
    if (!box) {
        return null
    }
    const width = box.x1 - box.x0 + 1
    const height = box.y1 - box.y0 + 1
    const cells = new Uint8Array(width * height)
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (isSelected(selection, box.x0 + x, box.y0 + y)) {
                cells[y * width + x] = volume.get(box.x0 + x, box.y0 + y, z)
            }
        }
    }
    return {width, height, cells}
}

export const clearSelection = (volume: Volume, selection: Selection, z: number): number => {
    let changed = 0
    for (let y = 0; y < selection.height; y += 1) {
        for (let x = 0; x < selection.width; x += 1) {
            if (isSelected(selection, x, y) && volume.set(x, y, z, EMPTY)) {
                changed += 1
            }
        }
    }
    return changed
}

/**
 * Stamp a clipboard down with its top-left at (x, y). Cells that fall outside the canvas are
 * dropped rather than clamped — clamping would pile the whole overhang into the edge column.
 */
export const pasteClipboard = (
    volume: Volume,
    clipboard: Clipboard,
    size: GridSize,
    x: number,
    y: number,
    z: number
): number => {
    let changed = 0
    for (let cy = 0; cy < clipboard.height; cy += 1) {
        for (let cx = 0; cx < clipboard.width; cx += 1) {
            const tx = x + cx
            const ty = y + cy
            if (tx < 0 || ty < 0 || tx >= size.sx || ty >= size.sy || z < 0 || z >= size.sz) {
                continue
            }
            if (volume.set(tx, ty, z, clipboard.cells[cy * clipboard.width + cx] ?? EMPTY)) {
                changed += 1
            }
        }
    }
    return changed
}

/**
 * Move the selected voxels by (dx, dy) within a slice, or to a different slice entirely.
 *
 * Lift first, then clear, then stamp — doing it cell by cell would have the moving voxels
 * overwrite the ones not yet read whenever the move overlaps its own source.
 */
export const moveSelection = (
    volume: Volume,
    selection: Selection,
    size: GridSize,
    dx: number,
    dy: number,
    fromZ: number,
    toZ = fromZ
): Selection => {
    const clipboard = copySelection(volume, selection, fromZ)
    const box = selectionBounds(selection)
    if (!clipboard || !box) {
        return selection
    }
    clearSelection(volume, selection, fromZ)
    pasteClipboard(volume, clipboard, size, box.x0 + dx, box.y0 + dy, toZ)
    return offsetSelection(selection, dx, dy)
}
