import {createImage, type RgbaImage} from '../image/rgba'
import {createDocument, editCel, flattenFrame, type Document} from '../doc/document'
import {colorToHex} from '../doc/serialize'
import type {Rgba} from '../vox/palette'
import type {GridSize} from '../vox/grid'

/**
 * Slice strips, for round-tripping a model through a 2D pixel editor (§11).
 *
 * The strip is the document's own slices laid out in a grid, one cell per z, bottom slice first —
 * the same order `sliceLayers` uses, so what comes back can be matched cell for cell. Reading it
 * back is the half that matters: an artist opens the strip in Aseprite, paints, saves, and the
 * voxels follow.
 *
 * Colours are matched to the palette by exact RGBA. A colour the palette does not have is
 * appended rather than snapped to the nearest — snapping silently discards an artist's new colour,
 * and a palette with one extra entry is trivially fixed by the merge-duplicates tool.
 */
export interface StripLayout {
    columns: number
    /** Transparent pixels between cells and around the edge. */
    pad: number
    /** Pixels per voxel. */
    scale: number
}

export const stripLayout = (patch: Partial<StripLayout> = {}): StripLayout => ({
    columns: patch.columns ?? 8,
    pad: patch.pad ?? 1,
    scale: patch.scale ?? 1
})

export const stripSize = (
    size: GridSize,
    {columns, pad, scale}: StripLayout
): {width: number; height: number; rows: number} => {
    const rows = Math.ceil(size.sz / columns)
    const cols = Math.min(columns, size.sz)
    return {
        width: pad + cols * (size.sx * scale + pad),
        height: pad + rows * (size.sy * scale + pad),
        rows
    }
}

/** Where cell `z` starts in the strip. */
export const cellOrigin = (
    z: number,
    size: GridSize,
    {columns, pad, scale}: StripLayout
): [number, number] => [
    pad + (z % columns) * (size.sx * scale + pad),
    pad + Math.floor(z / columns) * (size.sy * scale + pad)
]

/**
 * The whole frame as a strip. Canvas y is down, so each slice is flipped exactly as the slice
 * canvas flips it — what the artist sees in the editor is what lands in the file.
 */
export const sliceStrip = (
    doc: Document,
    frame: number,
    layout: StripLayout = stripLayout()
): RgbaImage => {
    const {width, height} = stripSize(doc.size, layout)
    const image = createImage(width, height)
    const volume = flattenFrame(doc, frame)
    const {scale} = layout

    for (let z = 0; z < doc.size.sz; z += 1) {
        const [ox, oy] = cellOrigin(z, doc.size, layout)
        for (let y = 0; y < doc.size.sy; y += 1) {
            for (let x = 0; x < doc.size.sx; x += 1) {
                const color = volume.get(x, y, z)
                const rgba = color === 0 ? undefined : doc.palette[color - 1]
                if (!rgba || rgba.a === 0) {
                    continue
                }
                const py = doc.size.sy - 1 - y
                for (let jy = 0; jy < scale; jy += 1) {
                    for (let jx = 0; jx < scale; jx += 1) {
                        const at = ((oy + py * scale + jy) * width + ox + x * scale + jx) * 4
                        image.data.set([rgba.r, rgba.g, rgba.b, rgba.a], at)
                    }
                }
            }
        }
    }
    return image
}

/**
 * Read a strip back into a frame of a document, keeping everything the image cannot carry — the
 * other frames, the layers, the tags — by writing into the given document rather than replacing
 * it. Colours not already in the palette are appended.
 */
export const applyStrip = (
    doc: Document,
    frame: number,
    image: RgbaImage,
    layout: StripLayout = stripLayout()
): Document => {
    const palette: Rgba[] = [...doc.palette]
    const index = new Map(palette.map((color, i) => [colorToHex(color), i + 1]))
    const {scale} = layout

    const indexOf = (color: Rgba): number => {
        const key = colorToHex(color)
        const found = index.get(key)
        if (found !== undefined) {
            return found
        }
        palette.push(color)
        index.set(key, palette.length)
        return palette.length
    }

    const next = editCel({...doc, palette}, 0, frame, volume => {
        for (let z = 0; z < doc.size.sz; z += 1) {
            const [ox, oy] = cellOrigin(z, doc.size, layout)
            for (let y = 0; y < doc.size.sy; y += 1) {
                for (let x = 0; x < doc.size.sx; x += 1) {
                    const py = doc.size.sy - 1 - y
                    const at = ((oy + py * scale) * image.width + ox + x * scale) * 4
                    const color: Rgba = {
                        r: image.data[at] ?? 0,
                        g: image.data[at + 1] ?? 0,
                        b: image.data[at + 2] ?? 0,
                        a: image.data[at + 3] ?? 0
                    }
                    volume.set(x, y, z, color.a === 0 ? 0 : indexOf(color))
                }
            }
        }
    })
    // the palette may have grown inside the edit, so take the final one
    return {...next, palette}
}

/** A strip with no document behind it — the import side of a round trip through another tool. */
export const documentFromStrip = (
    image: RgbaImage,
    size: GridSize,
    name = 'imported',
    layout: StripLayout = stripLayout()
): Document => applyStrip(createDocument({size, palette: [], name}), 0, image, layout)
