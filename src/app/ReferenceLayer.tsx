import type {Axis} from '../doc/brush'
import type {Reference} from './state'
import {basisFor, type Camera, type Vec3} from '../render/camera'
import type {Volume} from '../render/volume'

/**
 * Pixel art to build against, standing in the grid — `FEATURESET.md` §33.
 *
 * An orthographic camera projects a plane-aligned rectangle to a parallelogram, exactly, and a 2×3
 * matrix is precisely a parallelogram. So the image is placed with one `transform` built from the
 * camera's own basis rather than approximated with a perspective trick or re-rendered per frame —
 * it turns with the model because it is being projected the same way the model is.
 *
 * It is drawn under the render, not over it, so the model is what the artist sees and the reference
 * is what they see *through* the gaps. Reference over model is a tracing overlay; reference under
 * model is a thing to build against, and §33 asks for the second.
 */
const PLANE_AXES: Record<Axis, {origin: Vec3; across: Vec3; down: Vec3}> = {
    // Side view: the image spans y and z, standing at x = 0. Its top is high z.
    0: {origin: [0, 0, 1], across: [0, 1, 0], down: [0, 0, -1]},
    // Front view: spans x and z, standing at y = 0.
    1: {origin: [0, 0, 1], across: [1, 0, 0], down: [0, 0, -1]},
    // Top view: spans x and y, lying at z = 0, with the image's top at high y.
    2: {origin: [0, 1, 0], across: [1, 0, 0], down: [0, -1, 0]}
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

export const ReferenceLayer = ({
    volume,
    camera,
    references
}: {
    volume: Volume
    camera: Camera
    references: readonly Reference[]
}) => {
    if (references.length === 0) return undefined
    const {right, up, center} = basisFor(camera, volume, 1)
    const size: Vec3 = [volume.sx, volume.sy, volume.sz]
    const project = (p: Vec3): {x: number; y: number} => {
        const d: Vec3 = [p[0] - center[0], p[1] - center[1], p[2] - center[2]]
        return {x: dot(d, right), y: -dot(d, up)}
    }
    const half = camera.zoom / 2

    return (
        <svg
            className='reference-layer'
            viewBox={`${String(-half)} ${String(-half)} ${String(camera.zoom)} ${String(camera.zoom)}`}
            preserveAspectRatio='xMidYMid slice'
            aria-hidden='true'
        >
            {references.map(entry => {
                const plane = PLANE_AXES[entry.plane]
                // Each axis of the plane, scaled to the grid's own extent along it.
                const corner: Vec3 = [
                    plane.origin[0] * size[0],
                    plane.origin[1] * size[1],
                    plane.origin[2] * size[2]
                ]
                const far: Vec3 = [
                    corner[0] + plane.across[0] * size[0],
                    corner[1] + plane.across[1] * size[1],
                    corner[2] + plane.across[2] * size[2]
                ]
                const low: Vec3 = [
                    corner[0] + plane.down[0] * size[0],
                    corner[1] + plane.down[1] * size[1],
                    corner[2] + plane.down[2] * size[2]
                ]

                const at = project(corner)
                const u = project(far)
                const v = project(low)
                const matrix = [u.x - at.x, u.y - at.y, v.x - at.x, v.y - at.y, at.x, at.y].join(
                    ' '
                )

                return (
                    <image
                        key={entry.plane}
                        href={entry.url}
                        width='1'
                        height='1'
                        preserveAspectRatio='none'
                        opacity={entry.opacity}
                        transform={`matrix(${matrix})`}
                    />
                )
            })}
        </svg>
    )
}
