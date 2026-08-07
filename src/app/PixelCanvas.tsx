import {useEffect, useRef} from 'react'

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
    title
}: {
    width: number
    height: number
    data: Uint8Array
    className?: string
    title?: string
}) => {
    const ref = useRef<HTMLCanvasElement>(null)

    useEffect(() => {
        const context = ref.current?.getContext('2d')
        if (!context) return
        context.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0)
    }, [width, height, data])

    return (
        <canvas
            ref={ref}
            width={width}
            height={height}
            className={className}
            title={title}
            data-pixels={`${String(width)}x${String(height)}`}
        />
    )
}
