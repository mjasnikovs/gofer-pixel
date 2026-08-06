import {blit, createImage, type RgbaImage} from '../image/rgba'
import {frameToModel, type Document, type DocumentOrigin, type Tag} from '../doc/document'
import {prepareNormals, renderAngle} from '../vox/render'
import type {VoxModel} from '../vox/model'
import {colorToHex} from '../doc/serialize'

/**
 * The spritesheet of `PRODUCTION_PLAN.md` §11: angles across, frames down, with a matching
 * normal-map sheet and a JSON sidecar.
 *
 * The normal sheet is not an afterthought. Ours are exact — read off which voxel faces are exposed
 * — where the pixel-art field estimates them from height maps or from a hand-shaded lighting pass.
 * Godot consumes one directly on a `CanvasTexture`, so it ships beside the albedo, in the same
 * layout, pixel for pixel.
 *
 * Frames × angles multiplies fast — a 16-angle 8-frame walk is 128 sprites — which is why trimming
 * and the offsets that restore it are here from the start rather than added later.
 */
export interface AtlasOptions {
    /** Pre-baked directions. 16 is the default the plan settles on; powers of two are preferred. */
    angles?: number
    /** Pixels per voxel. */
    scale?: number
    /** Pixels of apparent height per slice; defaults to `scale`, which is what keeps it hole-free. */
    lift?: number
    /** Cut each cell down to its opaque content and record the offset that puts it back. */
    trim?: boolean
    /** Transparent pixels between cells, so filtering cannot bleed one into the next. */
    padding?: number
    /** Round the sheet up to a power of two in both axes. */
    powerOfTwo?: boolean
}

export interface AtlasFrame {
    /** Index into the angle sequence, `angle * 360 / angles` degrees. */
    angle: number
    /** Index into the document's frames. */
    frame: number
    degrees: number
    /** Where the content sits in the sheet. */
    x: number
    y: number
    width: number
    height: number
    /** Where the content sits inside the untrimmed cell. Zero unless trimming. */
    offsetX: number
    offsetY: number
}

export interface AtlasSidecar {
    version: 1
    name: string
    angles: number
    frames: number
    scale: number
    lift: number
    trimmed: boolean
    /** The cell every frame was rendered into, before trimming. */
    cell: {width: number; height: number}
    sheet: {width: number; height: number}
    /**
     * Where the sprite meets the ground, in untrimmed-cell pixels: the projected centre of the
     * bottom slice. Put this on the entity's position and the stack stands in the right place.
     */
    pivot: {x: number; y: number}
    rects: AtlasFrame[]
    tags: Tag[]
    palette: string[]
    origin?: DocumentOrigin
}

export interface Atlas {
    albedo: RgbaImage
    normal: RgbaImage
    sidecar: AtlasSidecar
}

const nextPowerOfTwo = (v: number): number => {
    let n = 1
    while (n < v) {
        n *= 2
    }
    return n
}

interface Bounds {
    x: number
    y: number
    width: number
    height: number
}

/** The tight box around the opaque pixels, or a 1×1 box at the origin for an empty image. */
export const opaqueBounds = ({width, height, data}: RgbaImage): Bounds => {
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if ((data[(y * width + x) * 4 + 3] ?? 0) !== 0) {
                minX = Math.min(minX, x)
                minY = Math.min(minY, y)
                maxX = Math.max(maxX, x)
                maxY = Math.max(maxY, y)
            }
        }
    }
    return maxX < 0 ?
            {x: 0, y: 0, width: 1, height: 1}
        :   {x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1}
}

const crop = (image: RgbaImage, {x, y, width, height}: Bounds): RgbaImage => {
    const out = createImage(width, height)
    for (let row = 0; row < height; row += 1) {
        const from = ((y + row) * image.width + x) * 4
        out.data.set(image.data.subarray(from, from + width * 4), row * width * 4)
    }
    return out
}

/**
 * What the packer needs beyond the pixels: the document facts that end up in the sidecar.
 *
 * Separated from `Document` so the packing half can run in a Worker, where a `Document` cannot go
 * — it holds `Volume` instances, and a class does not survive structured cloning. A `VoxModel` is
 * a `Map` and an array of plain objects, which does.
 */
export interface AtlasMeta {
    name: string
    /** Slices, for the pivot: the bottom slice sits `(sz - 1) * lift` below the top of the cell. */
    sliceCount: number
    tags: Tag[]
    palette: string[]
    origin?: DocumentOrigin
}

/**
 * Render every angle of every model and pack them.
 *
 * The layout stays a grid even when trimming — cell size becomes the largest trimmed frame rather
 * than the untrimmed render — because a predictable grid is worth more here than the last few
 * percent a shelf packer would save, and every consumer can still work from the rects.
 */
export const packModels = (
    models: readonly VoxModel[],
    meta: AtlasMeta,
    options: AtlasOptions = {}
): Atlas => {
    const angles = options.angles ?? 16
    const scale = options.scale ?? 4
    const lift = options.lift ?? scale
    const padding = options.padding ?? 1
    const trim = options.trim ?? false

    const rendered: {albedo: RgbaImage; normal: RgbaImage; angle: number; frame: number}[] = []
    models.forEach((model, frame) => {
        // one normal field per frame, shared by all its angles — a 16-angle bake would otherwise
        // recompute every surface normal sixteen times
        const normals = prepareNormals(model)
        for (let angle = 0; angle < angles; angle += 1) {
            const {albedo, normal} = renderAngle(model, (angle * 360) / angles, {
                scale,
                lift,
                normals
            })
            rendered.push({albedo, normal, angle, frame})
        }
    })

    const first = rendered[0]
    if (!first) {
        throw new Error('nothing to pack: the document has no frames')
    }
    const cell = {width: first.albedo.width, height: first.albedo.height}

    const boxes = rendered.map(entry => (trim ? opaqueBounds(entry.albedo) : {x: 0, y: 0, ...cell}))
    const cellWidth = Math.max(...boxes.map(box => box.width))
    const cellHeight = Math.max(...boxes.map(box => box.height))

    const rawWidth = padding + angles * (cellWidth + padding)
    const rawHeight = padding + models.length * (cellHeight + padding)
    const sheetWidth = options.powerOfTwo === true ? nextPowerOfTwo(rawWidth) : rawWidth
    const sheetHeight = options.powerOfTwo === true ? nextPowerOfTwo(rawHeight) : rawHeight

    const albedo = createImage(sheetWidth, sheetHeight)
    const normal = createImage(sheetWidth, sheetHeight)
    const rects: AtlasFrame[] = []

    rendered.forEach((entry, i) => {
        const box = boxes[i] ?? {x: 0, y: 0, ...cell}
        const x = padding + entry.angle * (cellWidth + padding)
        const y = padding + entry.frame * (cellHeight + padding)
        blit(albedo, trim ? crop(entry.albedo, box) : entry.albedo, x, y)
        blit(normal, trim ? crop(entry.normal, box) : entry.normal, x, y)
        rects.push({
            angle: entry.angle,
            frame: entry.frame,
            degrees: (entry.angle * 360) / angles,
            x,
            y,
            width: box.width,
            height: box.height,
            offsetX: box.x,
            offsetY: box.y
        })
    })

    return {
        albedo,
        normal,
        sidecar: {
            version: 1,
            name: meta.name,
            angles,
            frames: models.length,
            scale,
            lift,
            trimmed: trim,
            cell,
            sheet: {width: sheetWidth, height: sheetHeight},
            // the bottom slice is drawn (sliceCount - 1) * lift below the top of the cell, and the
            // footprint is centred, so this is where the model's origin projects to
            pivot: {
                x: cell.width / 2,
                y: (cell.height - (meta.sliceCount - 1) * lift) / 2 + (meta.sliceCount - 1) * lift
            },
            rects,
            tags: meta.tags.map(tag => ({...tag})),
            palette: meta.palette,
            ...(meta.origin ? {origin: meta.origin} : {})
        }
    }
}

/** The document facts the packer needs, pulled out so a Worker can be handed them. */
export const atlasMeta = (doc: Document): AtlasMeta => ({
    name: doc.name,
    sliceCount: doc.size.sz,
    tags: doc.tags.map(tag => ({...tag})),
    palette: doc.palette.map(colorToHex),
    ...(doc.origin ? {origin: doc.origin} : {})
})

/** Every frame of a document as a model, ready to pack or to post to a Worker. */
export const atlasModels = (doc: Document): VoxModel[] =>
    Array.from({length: doc.frames}, (_unused, frame) => frameToModel(doc, frame))

/** Bake a document on the calling thread. `src/editor/bake.ts` is the off-thread version. */
export const packAtlas = (doc: Document, options: AtlasOptions = {}): Atlas =>
    packModels(atlasModels(doc), atlasMeta(doc), options)

export const sidecarJson = (sidecar: AtlasSidecar): string => JSON.stringify(sidecar, null, 2)
