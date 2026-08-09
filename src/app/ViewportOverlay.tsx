import {Badge} from '@astryxdesign/core/Badge'
import {Kbd} from '@astryxdesign/core/Kbd'
import {Text} from '@astryxdesign/core/Text'
import type {Cell} from '../doc/selection'
import {basisFor, type Camera, type Vec3} from '../render/camera'

import type {Volume} from '../render/volume'
import {
    BOX_EDGES,
    boxCorners,
    dot,
    floorOf,
    ghostMesh,
    projector,
    unitCubeCorners,
    type Point,
    type Quad,
    type Segment
} from './overlay'
import {CameraIcon, MagnetIcon, MouseIcon} from './icons'
import type {Blocked} from './state'

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

const GIZMO = 30

/**
 * The ground grid, drawn over the render rather than in it.
 *
 * It has to be an overlay: putting it in the shader would put it in the CPU raycaster too, or else
 * break the parity those two are held to, and a grid is not part of a sprite. Every number in it —
 * the two lattice pitches, the centring, the screen-space falloff and the hole cut around the
 * voxels — is `floorOf` in `overlay.ts`. What is left here is the SVG.
 */
export const GroundGrid = ({volume, camera}: {volume: Volume; camera: Camera}) => {
    const {fine, ground, middle, inner, outer, silhouette} = floorOf(volume, camera)
    const points = silhouette.map((p: Point) => `${String(p.x)},${String(p.y)}`).join(' ')

    const half = camera.zoom / 2
    return (
        <svg
            className='ground-grid overlay-plane'
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
                    points={points}
                    fill='black'
                />
            </mask>
            <radialGradient
                id='ground-grid-falloff'
                gradientUnits='userSpaceOnUse'
                cx={middle.x}
                cy={middle.y}
                r={outer}
            >
                <stop
                    offset={outer > 0 ? inner / outer : 1}
                    stopColor='white'
                />
                <stop
                    offset='1'
                    stopColor='black'
                />
            </radialGradient>
            <mask id='ground-grid-fade'>
                <rect
                    x={-half * 4}
                    y={-half * 4}
                    width={half * 8}
                    height={half * 8}
                    fill='url(#ground-grid-falloff)'
                />
            </mask>
            <g mask='url(#ground-grid-mask)'>
                <g mask='url(#ground-grid-fade)'>
                    {ground.map((line: Segment, index: number) => (
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
                {fine.map((line: Segment, index: number) => (
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
 * The block the next press makes, unmakes, repaints or takes hold of: the real voxels, in three
 * dimensions, translucent and wireframed — the answer to the question this window could not answer
 * before, which is *what* the press is about to do rather than merely where the pointer is.
 *
 * Every tool on the rail that does anything gets one, and they all get it the same way. What differs
 * is `kind`, which is a promise about the voxels rather than a name for the button: `write` adds,
 * `clear` removes, `recolour` repaints, `sample` takes a colour away, `grab` picks voxels up. Two
 * tools making the same promise look the same, and `app.css` is where each promise gets its paint.
 *
 * The cells come from the state, which got them from the same functions the press runs —
 * `strokeCells`, `connected`, `pressSelection` — so this cannot promise a footprint the edit will
 * not deliver.
 *
 * Above `GHOST_CELLS` the state hands over an empty `cells` and a `bounds`, and the box is drawn
 * instead. A flood fill can be the whole grid; two million wireframed cubes is not a preview, it is
 * a hang. What the box loses is the shape, which for a region that large was never legible anyway,
 * and for `recolour` the shape is on screen regardless — the viewport is rendering the new paint.
 *
 * Two paths for the per-cell form, and neither is a picture of the other:
 *
 * - **Skin.** Each cell contributes only the faces that have no neighbour in the footprint and that
 *   point at the camera. That is the outside of the block, and no interior face is ever drawn — so
 *   the whole thing takes one uniform alpha instead of stacking up wherever two cells overlap.
 * - **Wireframe.** A cube edge is kept when the four cells meeting along it are neither all present
 *   nor all absent. The rule is the whole of it: interior edges of a slab have four neighbours and
 *   vanish, a lone cell keeps its twelve, and a diagonal pinch keeps the edge it pinches at.
 *
 * The back edges show through, deliberately. This is a proposal, not a solid, and a wireframe box
 * that hides its own far side reads as a surface decal rather than as a volume.
 *
 * `blocked` is the case that was silent before: the footprint is off the grid, or locked, or already
 * exactly what the press would write, or — for Pick — the colour is the one already loaded. The
 * press will do nothing at all. It is drawn dashed and inert rather than in a new colour, because
 * "this does nothing" is the absence of an action and should not look like a second kind of action.
 */
export const BrushGhost = ({
    volume,
    camera,
    hover
}: {
    volume: Volume
    camera: Camera
    hover: GhostHover | undefined
}) => {
    if (!hover) return undefined
    if (hover.cells.length === 0) {
        return (
            <GhostBox
                volume={volume}
                camera={camera}
                hover={hover}
            />
        )
    }
    const {skin, wire, shadow, legs} = ghostMesh(hover.cells, camera, volume)
    const at = ({x, y}: Point): string => `${String(x)} ${String(y)}`
    const face = (quad: Quad): string => `M${quad.map(at).join('L')}Z`
    const line = ({a: from, b: to}: Segment): string => `M${at(from)}L${at(to)}`
    const drop = [
        ...(shadow.length > 0 ? [`M${shadow.map(at).join('L')}Z`] : []),
        ...legs.map(line)
    ]

    const half = camera.zoom / 2
    return (
        <svg
            className='brush-ghost overlay-plane'
            data-blocked={hover.blocked?.reason}
            data-kind={hover.kind}
            style={{color: paintOf(volume, hover.paint)}}
            viewBox={`${String(-half)} ${String(-half)} ${String(camera.zoom)} ${String(camera.zoom)}`}
            preserveAspectRatio='xMidYMid slice'
            aria-hidden='true'
        >
            <path
                className='brush-ghost-drop'
                d={drop.join('')}
                fill='none'
                vectorEffect='non-scaling-stroke'
            />
            <path
                className='brush-ghost-fill'
                d={skin.map(face).join('')}
            />
            <path
                className='brush-ghost-outline'
                d={wire.map(line).join('')}
                fill='none'
                vectorEffect='non-scaling-stroke'
            />
        </svg>
    )
}

/**
 * What the state hands the ghost. The shape rather than `Hover` itself, so the overlay depends on
 * the four fields it draws from and not on the twenty the reducer keeps.
 *
 * `blocked` is the exception: it comes over whole, because the *reason* reaches the screen as words
 * in the hint bar and as a `data-blocked` value that `app.css` can tell apart.
 */
export interface GhostHover {
    readonly kind: string
    /** Empty when the footprint is over `GHOST_CELLS`; `bounds` is the answer then. */
    readonly cells: readonly Cell[]
    readonly bounds: {min: Cell; max: Cell} | undefined
    /** Palette index, or `undefined` for a proposal that puts no paint anywhere. */
    readonly paint: number | undefined
    readonly blocked: Blocked | undefined
}

/**
 * The colour the proposal would be made of, as CSS. `.brush-ghost-fill` inherits it — a preview in a
 * colour the press would not use says where the block goes and lies about what it is.
 *
 * `undefined` means the kind puts no paint anywhere — Erase, and the four that only take hold of
 * voxels. Those fall back to the theme, which is what their rules in `app.css` are written against.
 */
const paintOf = (volume: Volume, index: number | undefined): string | undefined => {
    if (index === undefined) return undefined
    const at = index * 4
    const [r, g, b] = [
        volume.palette[at] ?? 255,
        volume.palette[at + 1] ?? 255,
        volume.palette[at + 2] ?? 255
    ]
    return `rgb(${String(r)} ${String(g)} ${String(b)})`
}

/**
 * The same proposal, reduced to its box, for a footprint too large to draw one cube each.
 *
 * Twelve edges of the integer bounds, projected with the live basis — the same drawing `SelectionBox`
 * makes, because it is answering the same question about a region of the same kind. It carries the
 * ghost's own `data-kind` and `data-blocked` so a capped preview is still the colour of the promise
 * it is making, and it does not repeat the shadow: the drop lines exist to say how high a small
 * floating block is, and a region this size is not floating anywhere.
 */
const GhostBox = ({volume, camera, hover}: {volume: Volume; camera: Camera; hover: GhostHover}) => {
    const {bounds} = hover
    if (!bounds) return undefined
    const flat = boxCorners(bounds.min, bounds.max).map(projector(camera, volume))

    const half = camera.zoom / 2
    return (
        <svg
            className='brush-ghost overlay-plane'
            data-blocked={hover.blocked?.reason}
            data-kind={hover.kind}
            style={{color: paintOf(volume, hover.paint)}}
            viewBox={`${String(-half)} ${String(-half)} ${String(camera.zoom)} ${String(camera.zoom)}`}
            preserveAspectRatio='xMidYMid slice'
            aria-hidden='true'
        >
            <path
                className='brush-ghost-outline'
                d={BOX_EDGES.map(
                    ([from, to]) =>
                        `M${String(flat[from]?.x ?? 0)} ${String(flat[from]?.y ?? 0)}`
                        + `L${String(flat[to]?.x ?? 0)} ${String(flat[to]?.y ?? 0)}`
                ).join('')}
                fill='none'
                vectorEffect='non-scaling-stroke'
            />
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
    band,
    losing = 0
}: {
    volume: Volume
    camera: Camera
    bounds: {min: Vec3; max: Vec3} | undefined
    band: {x0: number; y0: number; x1: number; y1: number} | undefined
    /** How many voxels the drag in progress would destroy, which turns the box the warning colour. */
    losing?: number
}) => {
    const half = camera.zoom / 2
    const flat = (bounds ? boxCorners(bounds.min, bounds.max) : []).map(projector(camera, volume))

    return (
        <>
            {flat.length === 8 ?
                <svg
                    className='selection-box overlay-plane'
                    data-losing={losing > 0 || undefined}
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
 *
 * Which is why its size is derived rather than picked. A unit cube seen corner-on projects a corner
 * `sqrt(3)/2` of an edge from the centre; face-on, half an edge. Sizing it for the face-on case and
 * letting the corner-on case fall where it lands is what sliced the corners off at every angle an
 * artist actually orbits to.
 */
const CUBE_VIEWBOX = 64
const CUBE_STROKE = 1
/** The largest cube whose corner-on silhouette, stroke included, still lands inside the viewBox. */
const CUBE = (CUBE_VIEWBOX - CUBE_STROKE) / Math.sqrt(3)

export const ViewCube = ({volume, camera}: {volume: Volume; camera: Camera}) => {
    const {right, up} = basisFor(camera, volume, 1)
    const flat = unitCubeCorners().map(corner => ({
        x: dot(corner, right) * CUBE,
        y: -dot(corner, up) * CUBE
    }))

    return (
        <svg
            className='view-cube'
            viewBox={`${String(-CUBE_VIEWBOX / 2)} ${String(-CUBE_VIEWBOX / 2)} ${String(CUBE_VIEWBOX)} ${String(CUBE_VIEWBOX)}`}
            width='60'
            height='60'
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
                    strokeWidth={CUBE_STROKE}
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
/**
 * Why the next press would do nothing, in words.
 *
 * The dashed ghost has always said *that* a press is silent. It could not say which of three
 * silences it was, and the one that matters is the one with a switch behind it: an object that has
 * been locked looks exactly like an object with nothing left to erase. So the locked case names the
 * object, because the name is what the artist looks for in the list.
 */
const blockedSaid = (blocked: Blocked, name: string | undefined): string => {
    if (blocked.reason === 'locked') return `${name ?? 'That object'} is locked`
    if (blocked.reason === 'outside') return 'Outside the grid'
    return 'Nothing to change here'
}

export const HintBar = ({
    tool,
    hover,
    blocking,
    height,
    losing,
    onCapture
}: {
    tool: string
    /** Where the next click lands, in the grid's own coordinates. */
    hover: {cell: Cell; blocked: Blocked | undefined} | undefined
    /** The name of the locked object in the way, when that is why the press is blocked. */
    blocking: string | undefined
    /** How tall the grid is, so the layer reads as a position rather than as a number. */
    height: number
    /** How many voxels the drag in progress would destroy by landing. Zero when there is no drag. */
    losing: number
    onCapture: () => void
}) => (
    <div className='hints'>
        <span className='hint'>
            <MouseIcon />
            <Text type='supporting'>{tool}</Text>
        </span>
        {/*
         * What the drop will cost, while the button is still down.
         *
         * A move overwrites what it lands on and drops off the grid what will not fit, and both are
         * invisible a moment later — the voxels are simply not in the picture, and nothing says they
         * ever were. Undo brings them back, but only for an artist who noticed. It takes the front
         * of the bar rather than a corner, because a warning nobody reads is the same as no warning,
         * and it exists only while the drag does so there is nothing to tune out.
         */}
        {losing > 0 ?
            <Badge
                className='hint-losing'
                variant='warning'
                label={`${String(losing)} ${losing === 1 ? 'voxel' : 'voxels'} will be destroyed`}
            />
        :   undefined}
        {/*
         * Why this press will be silent, beside the coordinate it would have been silent at.
         *
         * A `Badge` rather than a coloured run of text. The first cut set a background on a bare
         * span, which has no padding and no radius, so a tinted rectangle sat tight against the
         * letters and read as a text selection someone had left behind. This is the widget the
         * design system already has for a short piece of status, and it brings the pill, the
         * padding and the on-colour text pairing with it.
         *
         * Only `locked` is a warning, and only `locked` gets the emblem — the same magnet the row's
         * lock switch wears, so the message and the switch that clears it are visibly one thing.
         * The other two reasons are facts about where the cursor is, not something to act on, and a
         * neutral pill is enough to read without being something to look at.
         */}
        {hover?.blocked ?
            <Badge
                className='hint-blocked'
                data-reason={hover.blocked.reason}
                variant={hover.blocked.reason === 'locked' ? 'warning' : 'neutral'}
                icon={hover.blocked.reason === 'locked' ? <MagnetIcon /> : undefined}
                label={blockedSaid(hover.blocked, blocking)}
            />
        :   undefined}
        {/*
         * The cell under the cursor, and how high it is.
         *
         * An orthographic view of a lattice of identical cubes cannot be read for position — the
         * shadow says which way is up, and this says exactly where. `Z of sz` rather than a bare
         * number, because "6" means nothing and "6 / 32" is a height.
         */}
        <span
            className='hint hint-cell'
            data-blocked={hover?.blocked?.reason}
        >
            {hover ?
                <>
                    <Text type='supporting'>
                        {hover.cell[0]}, {hover.cell[1]}
                    </Text>
                    <Text
                        type='supporting'
                        color='disabled'
                    >
                        Z
                    </Text>
                    <Text type='supporting'>
                        {hover.cell[2]} / {height - 1}
                    </Text>
                </>
            :   <Text
                    type='supporting'
                    color='disabled'
                >
                    off the model
                </Text>
            }
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
