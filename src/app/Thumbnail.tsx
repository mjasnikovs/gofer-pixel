import {useMemo} from 'react'
import type {Camera} from '../render/camera'
import {MODE_COLOR} from '../render/raycast.glsl'
import type {Volume} from '../render/volume'
import {PixelCanvas} from './PixelCanvas'
import {spriteFor} from './sprite-cache'

/**
 * One camera, rendered on the CPU — the same code that writes the exported sheet.
 *
 * Every preview in the window comes through here: the camera grid, the views strip, the render
 * panel and the export grid. That is the point. What the artist picks from is what they get, rather
 * than a preview drawn by a second renderer that agrees with the first only most of the time.
 */
export const Thumbnail = ({
    volume,
    camera,
    size = 72,
    map,
    className = 'thumbnail'
}: {
    volume: Volume
    camera: Camera
    size?: number
    /** One of the shader's view modes. Defaults to colour. */
    map?: number
    className?: string
}) => {
    const pixels = useMemo(
        () => spriteFor(volume, camera, size, map ?? MODE_COLOR),
        [volume, camera, size, map]
    )

    return (
        <PixelCanvas
            width={size}
            height={size}
            data={pixels}
            className={className}
        />
    )
}
