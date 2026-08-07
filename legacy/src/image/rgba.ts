/** A straight RGBA8 buffer, row-major, no stride padding. */
export interface RgbaImage {
    width: number
    height: number
    data: Uint8Array
}

export const createImage = (width: number, height: number): RgbaImage => ({
    width,
    height,
    data: new Uint8Array(width * height * 4)
})

/** Copy `src` into `dst` with its top-left corner at (ox, oy). Straight overwrite, no blending. */
export const blit = (dst: RgbaImage, src: RgbaImage, ox: number, oy: number): void => {
    for (let y = 0; y < src.height; y += 1) {
        const from = y * src.width * 4
        const to = ((oy + y) * dst.width + ox) * 4
        dst.data.set(src.data.subarray(from, from + src.width * 4), to)
    }
}
