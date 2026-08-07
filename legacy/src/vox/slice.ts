import {blit, createImage, type RgbaImage} from '../image/rgba'
import {layersByZ, unpackKey, type VoxModel} from './model'

/** One RGBA layer per z, bottom first. */
export const sliceLayers = (model: VoxModel, scale = 1): RgbaImage[] => {
    const {sx, sy, palette} = model
    const width = sx * scale
    const layers: RgbaImage[] = []

    for (const entries of layersByZ(model)) {
        const layer = createImage(width, sy * scale)
        for (const [key, color] of entries) {
            const [x, y] = unpackKey(key)
            const rgba = palette[color - 1]
            if (!rgba) {
                continue
            }
            const {r, g, b, a} = rgba
            // .vox Y is depth; flip it so the sheet reads top-down like a screen
            const py = sy - 1 - y
            for (let dy = 0; dy < scale; dy += 1) {
                const row = ((py * scale + dy) * width + x * scale) * 4
                for (let dx = 0; dx < scale; dx += 1) {
                    layer.data.set([r, g, b, a], row + dx * 4)
                }
            }
        }
        layers.push(layer)
    }
    return layers
}

/** Lay the layers out in a grid, one cell per slice, bottom slice first. */
export const composeSheet = (layers: RgbaImage[], columns = 8, pad = 1): RgbaImage => {
    const first = layers[0]
    if (!first) {
        throw new Error('no layers to compose')
    }
    const rows = Math.ceil(layers.length / columns)
    const cols = Math.min(columns, layers.length)
    const sheet = createImage(cols * (first.width + pad) + pad, rows * (first.height + pad) + pad)

    layers.forEach((layer, i) => {
        blit(
            sheet,
            layer,
            pad + (i % columns) * (layer.width + pad),
            pad + Math.floor(i / columns) * (layer.height + pad)
        )
    })
    return sheet
}

/** Preview render: draw every slice bottom-to-top, each one `dy` px higher than the last. */
export const composeStacked = (layers: RgbaImage[], dy = 1, pad = 0): RgbaImage => {
    const first = layers[0]
    if (!first) {
        throw new Error('no layers to compose')
    }
    const out = createImage(
        first.width + pad * 2,
        first.height + dy * (layers.length - 1) + pad * 2
    )

    layers.forEach((layer, i) => {
        const oy = pad + (layers.length - 1 - i) * dy
        for (let y = 0; y < layer.height; y += 1) {
            for (let x = 0; x < layer.width; x += 1) {
                const s = (y * layer.width + x) * 4
                if (layer.data[s + 3] === 0) {
                    continue
                }
                out.data.set(layer.data.subarray(s, s + 4), ((oy + y) * out.width + pad + x) * 4)
            }
        }
    })
    return out
}
