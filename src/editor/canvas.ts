import {createImage, type RgbaImage} from '../image/rgba'
import type {Document} from '../doc/document'
import type {Selection} from '../doc/selection'
import type {Volume} from '../doc/volume'
import {EMPTY} from '../vox/palette'

/**
 * Drawing the editor's views. Everything here produces an `RgbaImage` at one pixel per voxel; the
 * DOM scales it up with `image-rendering: pixelated`, so zoom costs nothing and stays crisp.
 *
 * The y axis flips: the volume's y is depth away from the camera, the canvas's y is down. Getting
 * this backwards silently mirrors every sprite, so it lives in one function.
 */
export const flipY = (y: number, {sy}: {sy: number}): number => sy - 1 - y

const paintCell = (
    image: RgbaImage,
    x: number,
    y: number,
    rgba: [number, number, number, number]
): void => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
        return
    }
    image.data.set(rgba, (y * image.width + x) * 4)
}

export interface SliceViewOptions {
    /** Slices below and above, drawn faded. */
    onionSkin?: boolean
    /** 0–1, how strongly the onion layers show. */
    onionAlpha?: number
    /**
     * The same slice on the neighbouring *frames*, drawn faded underneath — the animation onion
     * skin, which is a different question from the slice onion skin above and is why they are two
     * options rather than one. Tier 1 animation is per-frame volumes, so seeing where the previous
     * frame put a limb is the whole workflow.
     */
    frameOnion?: {before?: Volume | null; after?: Volume | null; alpha?: number}
}

/** One slice of one layer, with optional onion skins across z and across frames. */
export const renderSlice = (
    doc: Document,
    cel: Volume | null,
    z: number,
    {onionSkin = true, onionAlpha = 0.35, frameOnion}: SliceViewOptions = {}
): RgbaImage => {
    const image = createImage(doc.size.sx, doc.size.sy)

    const draw = (source: Volume | null, sliceZ: number, alpha: number, tint?: 'cool' | 'warm') => {
        if (!source) {
            return
        }
        for (let y = 0; y < doc.size.sy; y += 1) {
            for (let x = 0; x < doc.size.sx; x += 1) {
                const color = source.get(x, y, sliceZ)
                const rgba = color === EMPTY ? null : doc.palette[color - 1]
                if (rgba && rgba.a !== 0) {
                    paintCell(image, x, flipY(y, doc.size), [
                        // previous and next frame are tinted apart, the way every 2D animation
                        // tool does it: without it the two ghosts are indistinguishable
                        tint === 'warm' ? Math.min(255, rgba.r + 60) : rgba.r,
                        rgba.g,
                        tint === 'cool' ? Math.min(255, rgba.b + 60) : rgba.b,
                        Math.round(rgba.a * alpha)
                    ])
                }
            }
        }
    }

    const frameAlpha = frameOnion?.alpha ?? 0.28
    draw(frameOnion?.before ?? null, z, frameAlpha, 'warm')
    draw(frameOnion?.after ?? null, z, frameAlpha, 'cool')

    if (onionSkin) {
        // below first, then above, then the active slice on top of both
        draw(cel, z - 1, onionAlpha)
        draw(cel, z + 1, onionAlpha)
    }
    draw(cel, z, 1)
    return image
}

/** The marching-ants outline, as a mask the UI can draw however it likes. */
export const selectionOutline = (
    selection: Selection,
    size: {sx: number; sy: number}
): boolean[] => {
    const out: boolean[] = Array.from({length: size.sx * size.sy}, () => false)
    const at = (x: number, y: number): boolean =>
        x >= 0
        && y >= 0
        && x < selection.width
        && y < selection.height
        && (selection.mask[y * selection.width + x] ?? 0) !== 0

    for (let y = 0; y < size.sy; y += 1) {
        for (let x = 0; x < size.sx; x += 1) {
            if (at(x, y) && !(at(x - 1, y) && at(x + 1, y) && at(x, y - 1) && at(x, y + 1))) {
                out[flipY(y, size) * size.sx + x] = true
            }
        }
    }
    return out
}

/** Canvas pixel coordinates back to voxel coordinates, given the on-screen zoom. */
export const toVoxel = (
    clientX: number,
    clientY: number,
    rect: {left: number; top: number; width: number; height: number},
    size: {sx: number; sy: number}
): [number, number] => {
    const x = Math.floor(((clientX - rect.left) / rect.width) * size.sx)
    const y = Math.floor(((clientY - rect.top) / rect.height) * size.sy)
    return [
        Math.max(0, Math.min(size.sx - 1, x)),
        Math.max(0, Math.min(size.sy - 1, flipY(y, size)))
    ]
}
