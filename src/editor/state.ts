import {EMPTY} from '../vox/palette'
import {editCel, type Document} from '../doc/document'
import {shadeStep} from '../doc/palette'
import {
    copySelection,
    clearSelection,
    emptySelection,
    lassoSelection,
    moveSelection,
    pasteClipboard,
    rectSelection,
    selectionBounds,
    wandSelection,
    type Clipboard,
    type Selection
} from '../doc/selection'
import {ellipse, floodFill, line, plot, rect, type ToolContext} from '../doc/tools'
import {Volume} from '../doc/volume'

/**
 * The editor's pure half.
 *
 * A gesture is replayed from the snapshot it started on, every time the cursor moves. That sounds
 * wasteful and is not — a stroke is a few hundred voxels on a copy-on-write volume — and it buys
 * the property that matters: the preview and the committed result are produced by the same code,
 * so they cannot disagree. It also means a drag is exactly one undo entry with no coalescing
 * logic anywhere.
 */
export type Tool =
    | 'pencil'
    | 'eraser'
    | 'line'
    | 'rect'
    | 'ellipse'
    | 'fill'
    | 'shade'
    | 'eyedropper'
    | 'select'
    | 'lasso'
    | 'wand'
    | 'move'

/** What undo restores: the document plus where the artist was when they changed it. */
export interface EditorSnapshot {
    readonly doc: Document
    readonly selection: Selection | null
    readonly slice: number
    readonly layer: number
    readonly frame: number
}

export interface Stroke {
    readonly tool: Tool
    readonly color: number
    readonly mirrorX: boolean
    readonly mirrorY: boolean
    readonly filled: boolean
    readonly start: readonly [number, number]
    readonly points: readonly (readonly [number, number])[]
}

export interface StrokeResult {
    readonly snapshot: EditorSnapshot
    /** Set by the eyedropper; the caller makes it the active colour. */
    readonly pickedColor?: number
    /** False when the gesture changed nothing, so it can be dropped before reaching undo. */
    readonly changed: boolean
}

export const beginStroke = (
    tool: Tool,
    at: readonly [number, number],
    options: {
        color: number
        mirrorX?: boolean
        mirrorY?: boolean
        filled?: boolean
    }
): Stroke => ({
    tool,
    color: options.color,
    mirrorX: options.mirrorX ?? false,
    mirrorY: options.mirrorY ?? false,
    filled: options.filled ?? true,
    start: at,
    points: [at]
})

export const extendStroke = (stroke: Stroke, at: readonly [number, number]): Stroke => {
    const last = stroke.points[stroke.points.length - 1]
    if (last?.[0] === at[0] && last[1] === at[1]) {
        return stroke
    }
    return {...stroke, points: [...stroke.points, at]}
}

const strokeLabel: Record<Tool, string> = {
    pencil: 'pencil',
    eraser: 'erase',
    line: 'line',
    rect: 'rectangle',
    ellipse: 'ellipse',
    fill: 'fill',
    shade: 'shade',
    eyedropper: 'pick colour',
    select: 'select',
    lasso: 'lasso',
    wand: 'wand',
    move: 'move'
}

export const labelFor = (tool: Tool): string => strokeLabel[tool]

/** Tools that only change the selection never touch voxels, so they never dirty the document. */
export const isSelectionTool = (tool: Tool): boolean =>
    tool === 'select' || tool === 'lasso' || tool === 'wand'

/**
 * Replay a whole gesture against the snapshot it began on.
 *
 * `base` is never mutated: `editCel` clones the cel, and the tools write to that clone.
 */
export const applyStroke = (base: EditorSnapshot, stroke: Stroke): StrokeResult => {
    const {doc, slice, layer, frame} = base
    const ctx: ToolContext = {size: doc.size, mirrorX: stroke.mirrorX, mirrorY: stroke.mirrorY}
    const points = stroke.points
    const last = points[points.length - 1] ?? stroke.start
    const [sx, sy] = stroke.start
    const [lx, ly] = last

    if (stroke.tool === 'eyedropper') {
        const cel = doc.layers[layer]?.cels[frame]
        return {snapshot: base, pickedColor: cel?.get(lx, ly, slice) ?? EMPTY, changed: false}
    }

    if (isSelectionTool(stroke.tool)) {
        const cel = doc.layers[layer]?.cels[frame] ?? new Volume()
        const selection =
            stroke.tool === 'select' ? rectSelection(doc.size, sx, sy, lx, ly)
            : stroke.tool === 'lasso' ?
                lassoSelection(
                    doc.size,
                    points.map(([x, y]) => [x, y])
                )
            :   wandSelection(cel, doc.size, lx, ly, slice)
        return {snapshot: {...base, selection}, changed: false}
    }

    if (stroke.tool === 'move') {
        const selection = base.selection
        if (!selection) {
            return {snapshot: base, changed: false}
        }
        const moved = editCel(doc, layer, frame, volume => {
            moveSelection(volume, selection, doc.size, lx - sx, ly - sy, slice)
        })
        return {
            snapshot: {
                ...base,
                doc: moved,
                selection: (() => {
                    const box = selectionBounds(selection)
                    return box ?
                            rectSelection(
                                doc.size,
                                box.x0 + lx - sx,
                                box.y0 + ly - sy,
                                box.x1 + lx - sx,
                                box.y1 + ly - sy
                            )
                        :   selection
                })()
            },
            changed: moved !== doc
        }
    }

    let touched = 0
    const next = editCel(doc, layer, frame, volume => {
        const inside = (x: number, y: number): boolean =>
            base.selection?.mask[y * doc.size.sx + x] !== 0

        const paint = (x: number, y: number, color: number): void => {
            if (inside(x, y)) {
                touched += plot(volume, ctx, x, y, slice, color)
            }
        }

        switch (stroke.tool) {
            case 'pencil':
            case 'eraser': {
                const color = stroke.tool === 'eraser' ? EMPTY : stroke.color
                let previous = stroke.start
                for (const point of points) {
                    const [x0, y0] = previous
                    const [x1, y1] = point
                    // walk the segment by hand so the selection mask can veto each cell
                    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
                    for (let i = 0; i <= steps; i += 1) {
                        const t = steps === 0 ? 0 : i / steps
                        paint(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), color)
                    }
                    previous = point
                }
                break
            }
            case 'shade': {
                for (const [x, y] of points) {
                    const current = volume.get(x, y, slice)
                    if (current !== EMPTY) {
                        paint(x, y, shadeStep(doc.ramps, current, stroke.color))
                    }
                }
                break
            }
            case 'line':
                touched += line(volume, ctx, sx, sy, lx, ly, slice, stroke.color)
                break
            case 'rect':
                touched += rect(volume, ctx, sx, sy, lx, ly, slice, stroke.color, stroke.filled)
                break
            case 'ellipse':
                touched += ellipse(volume, ctx, sx, sy, lx, ly, slice, stroke.color, stroke.filled)
                break
            case 'fill':
                touched += floodFill(volume, ctx, lx, ly, slice, stroke.color)
                break
            default:
                break
        }
    })

    return {snapshot: {...base, doc: next}, changed: touched > 0}
}

/** Delete whatever is selected on the active slice. */
export const deleteSelected = (base: EditorSnapshot): StrokeResult => {
    const selection = base.selection
    if (!selection) {
        return {snapshot: base, changed: false}
    }
    let touched = 0
    const doc = editCel(base.doc, base.layer, base.frame, volume => {
        touched = clearSelection(volume, selection, base.slice)
    })
    return {snapshot: {...base, doc}, changed: touched > 0}
}

export const copyToClipboard = (base: EditorSnapshot): Clipboard | null => {
    const cel = base.doc.layers[base.layer]?.cels[base.frame]
    return cel && base.selection ? copySelection(cel, base.selection, base.slice) : null
}

/** Paste at the selection's corner, or at the origin when nothing is selected. */
export const pasteAt = (base: EditorSnapshot, clipboard: Clipboard): StrokeResult => {
    const box = base.selection ? selectionBounds(base.selection) : null
    const x = box?.x0 ?? 0
    const y = box?.y0 ?? 0
    let touched = 0
    const doc = editCel(base.doc, base.layer, base.frame, volume => {
        touched = pasteClipboard(volume, clipboard, base.doc.size, x, y, base.slice)
    })
    return {
        snapshot: {
            ...base,
            doc,
            selection: rectSelection(
                base.doc.size,
                x,
                y,
                x + clipboard.width - 1,
                y + clipboard.height - 1
            )
        },
        changed: touched > 0
    }
}

export const selectAll = (base: EditorSnapshot): EditorSnapshot => ({
    ...base,
    selection: rectSelection(base.doc.size, 0, 0, base.doc.size.sx - 1, base.doc.size.sy - 1)
})

export const deselect = (base: EditorSnapshot): EditorSnapshot => ({...base, selection: null})

export const clearedSelection = (size: {sx: number; sy: number; sz: number}): Selection =>
    emptySelection(size)
