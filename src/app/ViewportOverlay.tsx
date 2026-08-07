import {Kbd} from '@astryxdesign/core/Kbd'
import {Text} from '@astryxdesign/core/Text'
import {basisFor, type Camera, type Vec3} from '../render/camera'
import type {Volume} from '../render/volume'
import {CameraIcon, MouseIcon} from './icons'

/**
 * The three things that float over the render in `docs/editor.png`: which way the axes point, a
 * view cube, and a bar naming the gestures.
 *
 * The axis gizmo is computed from the same basis the shader is handed, so it cannot drift from what
 * is on screen. It reports this project's axes, not the mockup's: `.vox` is z-up and the raycaster
 * assumes it, so **Z** is the vertical one here. A gizmo that drew the mockup's Y upward would be a
 * picture of a different coordinate system, which is precisely the class of bug the normal-map
 * convention note in `docs/FEATURESET.md` §19 is about.
 */
const AXES: readonly {label: string; vector: Vec3; color: string}[] = [
    {label: 'X', vector: [1, 0, 0], color: '#e4574c'},
    {label: 'Y', vector: [0, 1, 0], color: '#4caf50'},
    {label: 'Z', vector: [0, 0, 1], color: '#4a8ff0'}
]

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

const GIZMO = 30

/**
 * The ground grid, drawn over the render rather than in it.
 *
 * It has to be an overlay: putting it in the shader would put it in the CPU raycaster too, or else
 * break the parity those two are held to, and a grid is not part of a sprite. So it is projected
 * with the camera's own basis — one `viewBox` in voxels, sliced the way an orthographic camera
 * slices, which is exactly what `zoom` means — and then masked by the volume's projected bounding
 * box so the lines stop at the model instead of being drawn across its face.
 *
 * The mask is a convex hull of the eight projected corners. A box seen from any angle projects to a
 * convex hexagon (or a rectangle head-on), so the hull is the silhouette, exactly.
 */
const hull = (points: {x: number; y: number}[]): {x: number; y: number}[] => {
    const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
    const half = (source: {x: number; y: number}[]): {x: number; y: number}[] => {
        const out: {x: number; y: number}[] = []
        for (const point of source) {
            while (out.length >= 2) {
                const a = out[out.length - 2]
                const b = out[out.length - 1]
                if (!a || !b) break
                const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)
                if (cross > 0) break
                out.pop()
            }
            out.push(point)
        }
        out.pop()
        return out
    }
    return [...half(sorted), ...half([...sorted].reverse())]
}

export const GroundGrid = ({volume, camera}: {volume: Volume; camera: Camera}) => {
    const {right, up, center} = basisFor(camera, volume, 1)
    const project = (p: Vec3): {x: number; y: number} => {
        const d: Vec3 = [p[0] - center[0], p[1] - center[1], p[2] - center[2]]
        return {x: dot(d, right), y: -dot(d, up)}
    }

    // One line per voxel while that is legible, and a coarser lattice once it is not.
    const step = Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(volume.sx, volume.sy) / 24)))
    const pad = step * 4
    const lines: {a: {x: number; y: number}; b: {x: number; y: number}}[] = []
    for (let x = -pad; x <= volume.sx + pad; x += step) {
        lines.push({a: project([x, -pad, 0]), b: project([x, volume.sy + pad, 0])})
    }
    for (let y = -pad; y <= volume.sy + pad; y += step) {
        lines.push({a: project([-pad, y, 0]), b: project([volume.sx + pad, y, 0])})
    }

    const corners: Vec3[] = []
    for (let i = 0; i < 8; i += 1) {
        corners.push([(i & 1) * volume.sx, ((i >> 1) & 1) * volume.sy, ((i >> 2) & 1) * volume.sz])
    }
    const silhouette = hull(corners.map(project))
        .map(({x, y}) => `${String(x)},${String(y)}`)
        .join(' ')

    const half = camera.zoom / 2
    return (
        <svg
            className='ground-grid'
            viewBox={`${String(-half)} ${String(-half)} ${String(camera.zoom)} ${String(camera.zoom)}`}
            preserveAspectRatio='xMidYMid slice'
            aria-hidden='true'
        >
            <mask id='ground-grid-mask'>
                <rect
                    x={-half * 4}
                    y={-half * 4}
                    width={half * 8}
                    height={half * 8}
                    fill='white'
                />
                <polygon
                    points={silhouette}
                    fill='black'
                />
            </mask>
            <g mask='url(#ground-grid-mask)'>
                {lines.map((line, index) => (
                    <line
                        key={index}
                        x1={line.a.x}
                        y1={line.a.y}
                        x2={line.b.x}
                        y2={line.b.y}
                        stroke='currentColor'
                        strokeWidth='1'
                        vectorEffect='non-scaling-stroke'
                    />
                ))}
            </g>
        </svg>
    )
}

/**
 * The box around what is selected, and the rubber band that is choosing it.
 *
 * The box is the selection's own integer bounds projected with the live basis — the same trick as
 * `ViewCube`, for the same reason: it turns with the model instead of being a decal of one angle.
 * Bounds rather than a per-voxel outline because a selection can be thousands of cells, and twelve
 * lines say where it is without asking the browser to lay out ten thousand paths.
 */
export const SelectionBox = ({
    volume,
    camera,
    bounds,
    band
}: {
    volume: Volume
    camera: Camera
    bounds: {min: Vec3; max: Vec3} | undefined
    band: {x0: number; y0: number; x1: number; y1: number} | undefined
}) => {
    const {right, up, center} = basisFor(camera, volume, 1)
    const project = (p: Vec3): {x: number; y: number} => {
        const d: Vec3 = [p[0] - center[0], p[1] - center[1], p[2] - center[2]]
        return {x: dot(d, right), y: -dot(d, up)}
    }
    const half = camera.zoom / 2

    const corners: Vec3[] = []
    if (bounds) {
        const {min, max} = bounds
        for (let i = 0; i < 8; i += 1) {
            corners.push([
                (i & 1) === 0 ? min[0] : max[0] + 1,
                ((i >> 1) & 1) === 0 ? min[1] : max[1] + 1,
                ((i >> 2) & 1) === 0 ? min[2] : max[2] + 1
            ])
        }
    }
    const flat = corners.map(project)

    return (
        <>
            {flat.length === 8 ?
                <svg
                    className='selection-box'
                    viewBox={`${String(-half)} ${String(-half)} ${String(camera.zoom)} ${String(camera.zoom)}`}
                    preserveAspectRatio='xMidYMid slice'
                    aria-hidden='true'
                >
                    {BOX_EDGES.map(([from, to]) => (
                        <line
                            key={`${String(from)}-${String(to)}`}
                            x1={flat[from]?.x ?? 0}
                            y1={flat[from]?.y ?? 0}
                            x2={flat[to]?.x ?? 0}
                            y2={flat[to]?.y ?? 0}
                            stroke='currentColor'
                            strokeWidth='1.5'
                            vectorEffect='non-scaling-stroke'
                        />
                    ))}
                </svg>
            :   undefined}
            {band ?
                <div
                    className='rubber-band'
                    style={{
                        left: Math.min(band.x0, band.x1),
                        top: Math.min(band.y0, band.y1),
                        width: Math.abs(band.x1 - band.x0),
                        height: Math.abs(band.y1 - band.y0)
                    }}
                />
            :   undefined}
        </>
    )
}

const BOX_EDGES: readonly [number, number][] = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7]
]

export const AxisGizmo = ({volume, camera}: {volume: Volume; camera: Camera}) => {
    const {right, up, forward} = basisFor(camera, volume, 1)
    // Painter's order: an axis pointing away from the viewer is drawn first, so the near one wins
    // the overlap the way it does in the render behind it.
    const spokes = AXES.map(axis => ({
        ...axis,
        x: dot(axis.vector, right) * GIZMO,
        y: -dot(axis.vector, up) * GIZMO,
        depth: dot(axis.vector, forward)
    })).sort((a, b) => b.depth - a.depth)

    return (
        <svg
            className='gizmo'
            viewBox='-40 -40 80 80'
            width='72'
            height='72'
            aria-hidden='true'
        >
            {spokes.map(spoke => (
                <g key={spoke.label}>
                    <line
                        x1='0'
                        y1='0'
                        x2={spoke.x}
                        y2={spoke.y}
                        stroke={spoke.color}
                        strokeWidth='2'
                        strokeLinecap='round'
                    />
                    <text
                        x={spoke.x * 1.28}
                        y={spoke.y * 1.28}
                        fill={spoke.color}
                        fontSize='10'
                        textAnchor='middle'
                        dominantBaseline='middle'
                    >
                        {spoke.label}
                    </text>
                </g>
            ))}
        </svg>
    )
}

/**
 * The wireframe cube in the bottom-right corner, drawn from the live basis for the same reason the
 * gizmo is: it is the volume's own bounding box, so it turns with the model instead of being a
 * decal of one particular angle.
 */
export const ViewCube = ({volume, camera}: {volume: Volume; camera: Camera}) => {
    const {right, up} = basisFor(camera, volume, 1)
    const corners: Vec3[] = []
    for (let i = 0; i < 8; i += 1)
        corners.push([(i & 1) - 0.5, ((i >> 1) & 1) - 0.5, ((i >> 2) & 1) - 0.5])
    const flat = corners.map(corner => ({
        x: dot(corner, right) * 44,
        y: -dot(corner, up) * 44
    }))
    const edges: [number, number][] = [
        [0, 1],
        [2, 3],
        [4, 5],
        [6, 7],
        [0, 2],
        [1, 3],
        [4, 6],
        [5, 7],
        [0, 4],
        [1, 5],
        [2, 6],
        [3, 7]
    ]

    return (
        <svg
            className='view-cube'
            viewBox='-32 -32 64 64'
            width='60'
            height='60'
            aria-hidden='true'
        >
            {edges.map(([from, to]) => (
                <line
                    key={`${String(from)}-${String(to)}`}
                    x1={flat[from]?.x ?? 0}
                    y1={flat[from]?.y ?? 0}
                    x2={flat[to]?.x ?? 0}
                    y2={flat[to]?.y ?? 0}
                    stroke='currentColor'
                    strokeWidth='1'
                />
            ))}
        </svg>
    )
}

/**
 * The gesture bar. It names what this viewport does rather than what the mockup's caption says,
 * because a hint that is not the binding is worse than no hint.
 *
 * The left button belongs to the armed tool now that tools write voxels, so orbiting moved to the
 * right button — the arrangement every voxel editor already uses, and the only one where arming
 * Draw does not cost the artist the ability to look at what they are drawing.
 */
export const HintBar = ({tool, onCapture}: {tool: string; onCapture: () => void}) => (
    <div className='hints'>
        <span className='hint'>
            <MouseIcon />
            <Text type='supporting'>{tool}</Text>
        </span>
        <span className='hint'>
            <Text
                type='supporting'
                color='disabled'
            >
                Right
            </Text>
            <Text type='supporting'>Rotate</Text>
        </span>
        <span className='hint'>
            <Kbd keys='shift' />
            <Text type='supporting'>Pan</Text>
        </span>
        <span className='hint'>
            <Text
                type='supporting'
                color='disabled'
            >
                Wheel
            </Text>
            <Text type='supporting'>Zoom</Text>
        </span>
        <span className='hint-divider' />
        <button
            type='button'
            className='hint hint-action'
            title='Store the current view as a new camera'
            onClick={onCapture}
        >
            <CameraIcon />
            <Text type='supporting'>Capture view</Text>
            <Kbd keys='c' />
        </button>
    </div>
)
