import {createVolume, setVoxel, type Volume} from '../render/volume'

/**
 * A PNG's opaque pixels, extruded into voxels — `FEATURESET.md` §34.
 *
 * The decode is not here. A browser already has a PNG decoder and this project does not need a
 * second one, so the caller hands over RGBA bytes and this turns them into a model. That also keeps
 * the interesting half — which pixel becomes which voxel, and what its colour ends up as — a plain
 * function a `bun test` can check without a canvas.
 *
 * Row 0 of an image is its top and `+z` is up, so the image is stood upright: image `x` becomes
 * world `x`, image `y` becomes world `z` counted from the top down, and the extrusion runs along
 * `y`, away from the camera at yaw 0. Import a front-facing sprite and it comes in facing front.
 */
export interface Imported {
    readonly volume: Volume
    /** How many distinct colours the image had, which is how many palette entries were used. */
    readonly colors: number
    /** Colours past 255 that had to be dropped, so the panel can say so rather than lying. */
    readonly dropped: number
}

/** Below this the pixel is treated as a hole rather than as a faint voxel. */
const OPAQUE = 128

const key = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b

export const voxelsFromImage = (
    rgba: Uint8Array,
    width: number,
    height: number,
    depth = 1
): Imported => {
    const thickness = Math.max(1, Math.round(depth))
    const palette = new Uint8Array(256 * 4)
    const slots = new Map<number, number>()
    let dropped = 0

    /*
     * A palette built from the image rather than matched into the existing one. A pixel artist's
     * PNG already *is* a palette — its colours are the ones they chose — and nearest-colour
     * matching into somebody else's 255 entries is how an import quietly changes an artist's work.
     */
    for (let i = 0; i < width * height; i += 1) {
        if ((rgba[i * 4 + 3] ?? 0) < OPAQUE) continue
        const colour = key(rgba[i * 4] ?? 0, rgba[i * 4 + 1] ?? 0, rgba[i * 4 + 2] ?? 0)
        if (slots.has(colour)) continue
        const slot = slots.size + 1
        if (slot > 255) {
            dropped += 1
            continue
        }
        slots.set(colour, slot)
        palette.set([rgba[i * 4] ?? 0, rgba[i * 4 + 1] ?? 0, rgba[i * 4 + 2] ?? 0, 255], slot * 4)
    }

    const volume = createVolume(Math.max(1, width), thickness, Math.max(1, height), palette)
    for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
            const i = row * width + column
            if ((rgba[i * 4 + 3] ?? 0) < OPAQUE) continue
            const slot = slots.get(
                key(rgba[i * 4] ?? 0, rgba[i * 4 + 1] ?? 0, rgba[i * 4 + 2] ?? 0)
            )
            if (slot === undefined) continue
            for (let y = 0; y < thickness; y += 1) {
                setVoxel(volume, column, y, height - 1 - row, slot)
            }
        }
    }

    return {volume, colors: slots.size, dropped}
}
