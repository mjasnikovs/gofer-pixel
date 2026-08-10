import {useEffect, useRef, type CSSProperties} from 'react'

/**
 * An RGBA buffer behind a function, because React's development build reads props.
 *
 * React 19's dev build writes every *changed* prop into the Performance track, and it walks a
 * `Uint8Array` one index at a time — the old buffer and the new one both. Measured over thirty
 * pointer moves of a stroke with twenty-six previews on screen: 250,000 property rows per move,
 * and 80 ms of the 100 ms each move cost under `vite dev`. The built bundle never had any of it,
 * which is how dev came to be 5× slower than the thing it is supposed to be a preview of.
 *
 * A function is stringified rather than walked, so the buffer crosses the prop boundary for one
 * row. Build it inside the same memo that builds the pixels: a fresh closure every render would
 * re-run the effect below and redraw every canvas for nothing.
 */
export type Pixels = () => Uint8Array

/**
 * An RGBA buffer on screen with nothing between it and the pixels: no smoothing on upload, and
 * `image-rendering: pixelated` on the way out. A sprite preview that resamples is a lie about what
 * the file will contain.
 *
 * `getContext` returns null under happy-dom, so this draws nothing in a unit test and the element
 * is still there to assert against. That is the whole reason pixels are tested against the
 * raycaster's buffers instead of against a canvas.
 */
export const PixelCanvas = ({
    width,
    height,
    data,
    className,
    title,
    style
}: {
    width: number
    height: number
    data: Pixels
    className?: string
    title?: string
    /**
     * The size on screen, which is not the size in pixels.
     *
     * The export preview sets it to a whole multiple of `width` and `height`, because
     * `image-rendering: pixelated` at a fractional scale staggers every edge — see
     * `ExportDialog.tsx`'s `previewScale`. Left off, the canvas is whatever the stylesheet says.
     */
    style?: CSSProperties
}) => {
    const ref = useRef<HTMLCanvasElement>(null)

    useEffect(() => {
        const context = ref.current?.getContext('2d')
        if (!context) return
        context.putImageData(new ImageData(new Uint8ClampedArray(data()), width, height), 0, 0)
    }, [width, height, data])

    return (
        <canvas
            ref={ref}
            width={width}
            height={height}
            className={className}
            title={title}
            style={style}
            data-pixels={`${String(width)}x${String(height)}`}
        />
    )
}
