/**
 * The glyphs the icon registry does not carry.
 *
 * `astryx docs icons` lists roughly two dozen semantic names — chevrons, a trash can, a hamburger —
 * and a voxel editor's toolbar is almost none of them. `IconButton` and `SegmentedControlItem` both
 * take a node as well as a name, so a pencil, a bucket and a magnet are drawn here rather than
 * approximated with a semantic icon that means something else.
 *
 * Every one is a 16-unit box on a 1.4 stroke of `currentColor`, so the button's variant still
 * decides the colour and the whole set reads as one hand.
 */
import {TOOL_PATHS} from './tool-paths'

const Svg = ({children, size = 16}: {children: React.ReactNode; size?: number}) => (
    <svg
        width={size}
        height={size}
        viewBox='0 0 16 16'
        fill='none'
        stroke='currentColor'
        strokeWidth='1.4'
        strokeLinecap='round'
        strokeLinejoin='round'
        aria-hidden='true'
    >
        {children}
    </svg>
)

/* ---- the nine tools, in rail order ---- */

const ToolGlyph = ({paths}: {paths: readonly string[]}) => (
    <Svg>
        {paths.map(d => (
            <path
                key={d}
                d={d}
            />
        ))}
    </Svg>
)

export const DrawIcon = () => <ToolGlyph paths={TOOL_PATHS.draw} />
export const EraseIcon = () => <ToolGlyph paths={TOOL_PATHS.erase} />
export const FillIcon = () => <ToolGlyph paths={TOOL_PATHS.fill} />
export const PickIcon = () => <ToolGlyph paths={TOOL_PATHS.pick} />
export const MoveIcon = () => <ToolGlyph paths={TOOL_PATHS.move} />
export const RotateIcon = () => <ToolGlyph paths={TOOL_PATHS.rotate} />
export const ScaleIcon = () => <ToolGlyph paths={TOOL_PATHS.scale} />
export const CloneIcon = () => <ToolGlyph paths={TOOL_PATHS.clone} />
export const MeasureIcon = () => <ToolGlyph paths={TOOL_PATHS.measure} />

/* ---- brush shapes ---- */

export const SquareIcon = () => (
    <Svg>
        <rect
            x='3.5'
            y='3.5'
            width='9'
            height='9'
            rx='1'
        />
    </Svg>
)

export const CircleIcon = () => (
    <Svg>
        <circle
            cx='8'
            cy='8'
            r='4.6'
        />
    </Svg>
)

export const RingIcon = () => (
    <Svg>
        <circle
            cx='8'
            cy='8'
            r='5.2'
        />
        <circle
            cx='8'
            cy='8'
            r='2.2'
        />
    </Svg>
)

export const CubeIcon = () => (
    <Svg>
        <path d='M8 1.8 14 5v6l-6 3.2L2 11V5z' />
        <path d='M2 5l6 3.2L14 5M8 8.2v6' />
    </Svg>
)

/* ---- what a drag draws between its two ends ---- */

/**
 * The five figures, each drawn as the shape it produces with its two ends marked.
 *
 * The dots are the whole idea. A line, a rectangle and an ellipse are all "press here, release
 * there", and what distinguishes them is only what gets filled in between — so every one of these is
 * the same two endpoints with a different path joining them, and Free is the one where the path
 * wanders. The panel used to spell the four out in words, on the argument that a rectangle has no
 * icon better than its own name. It does: the rectangle.
 */
export const FreeIcon = () => (
    <Svg>
        <path d='M3 11.5c1.6-4.4 3-6.4 4.2-6 1.2.4.6 4 1.8 4.4 1.2.4 2.4-1.6 4-4.4' />
        <circle
            cx='3'
            cy='11.5'
            r='1.5'
            fill='currentColor'
            stroke='none'
        />
        <circle
            cx='13'
            cy='5.5'
            r='1.5'
            fill='currentColor'
            stroke='none'
        />
    </Svg>
)

export const LineIcon = () => (
    <Svg>
        <path d='M4 12 12 4' />
        <circle
            cx='4'
            cy='12'
            r='1.5'
            fill='currentColor'
            stroke='none'
        />
        <circle
            cx='12'
            cy='4'
            r='1.5'
            fill='currentColor'
            stroke='none'
        />
    </Svg>
)

export const RectIcon = () => (
    <Svg>
        <path d='M3.5 12.5v-9h9' />
        <path d='M3.5 12.5h9v-9' />
        <circle
            cx='3.5'
            cy='12.5'
            r='1.5'
            fill='currentColor'
            stroke='none'
        />
        <circle
            cx='12.5'
            cy='3.5'
            r='1.5'
            fill='currentColor'
            stroke='none'
        />
    </Svg>
)

export const RectFillIcon = () => (
    <Svg>
        <path
            d='M3.5 3.5h9v9h-9z'
            fill='currentColor'
        />
        <circle
            cx='3.5'
            cy='12.5'
            r='1.5'
            fill='currentColor'
            stroke='none'
        />
        <circle
            cx='12.5'
            cy='3.5'
            r='1.5'
            fill='currentColor'
            stroke='none'
        />
    </Svg>
)

export const EllipseIcon = () => (
    <Svg>
        <ellipse
            cx='8'
            cy='8'
            rx='5.5'
            ry='4'
        />
        <circle
            cx='2.5'
            cy='12'
            r='1.5'
            fill='currentColor'
            stroke='none'
        />
        <circle
            cx='13.5'
            cy='4'
            r='1.5'
            fill='currentColor'
            stroke='none'
        />
    </Svg>
)

/* ---- header and panel actions ---- */

export const SlidersIcon = () => (
    <Svg>
        <path d='M2.5 4.5h11M2.5 11.5h11M6 2.8v3.4M10.5 9.8v3.4' />
    </Svg>
)

export const UndoIcon = () => (
    <Svg>
        <path d='M3 7h7a3.5 3.5 0 0 1 0 7H6' />
        <path d='M5.6 4.2 2.8 7l2.8 2.8' />
    </Svg>
)

export const RedoIcon = () => (
    <Svg>
        <path d='M13 7H6a3.5 3.5 0 0 0 0 7h4' />
        <path d='M10.4 4.2 13.2 7l-2.8 2.8' />
    </Svg>
)

export const SunIcon = () => (
    <Svg>
        <circle
            cx='8'
            cy='8'
            r='3'
        />
        <path d='M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1' />
    </Svg>
)

export const ChevronIcon = () => (
    <Svg>
        <path d='M4.5 6.5 8 10l3.5-3.5' />
    </Svg>
)

export const MenuIcon = () => (
    <Svg>
        <path d='M2.5 4h11M2.5 8h11M2.5 12h11' />
    </Svg>
)

export const GearIcon = () => (
    <Svg>
        <circle
            cx='8'
            cy='8'
            r='2.2'
        />
        <path d='M8 1.6l.9 1.6 1.8-.4.5 1.8 1.8.4-.5 1.8L14 8l-1.5 1.2.5 1.8-1.8.4-.5 1.8-1.8-.4L8 14.4l-.9-1.6-1.8.4-.5-1.8-1.8-.4.5-1.8L2 8l1.5-1.2-.5-1.8 1.8-.4.5-1.8 1.8.4z' />
    </Svg>
)

export const DotsIcon = () => (
    <Svg>
        <path d='M4 8h.01M8 8h.01M12 8h.01' />
    </Svg>
)

export const CameraIcon = () => (
    <Svg>
        <path d='M2 5.5h2.5L6 3.5h4l1.5 2H14v7H2z' />
        <circle
            cx='8'
            cy='9'
            r='2.25'
        />
    </Svg>
)

export const TrashIcon = () => (
    <Svg>
        <path d='M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 6.5v5M9.5 6.5v5' />
    </Svg>
)

export const PlusIcon = () => (
    <Svg>
        <path d='M8 3.5v9M3.5 8h9' />
    </Svg>
)

export const MinusIcon = () => (
    <Svg>
        <path d='M3.5 8h9' />
    </Svg>
)

export const CopyIcon = () => (
    <Svg>
        <path d='M6 6h7.5v7.5H6z' />
        <path d='M10 6V2.5H2.5V10H6' />
    </Svg>
)

export const EyeIcon = () => (
    <Svg>
        <path d='M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z' />
        <circle
            cx='8'
            cy='8'
            r='2'
        />
    </Svg>
)

export const MagnetIcon = () => (
    <Svg>
        <path d='M3.5 3v5a4.5 4.5 0 0 0 9 0V3h-3v5a1.5 1.5 0 0 1-3 0V3z' />
        <path d='M3.5 6h3M9.5 6h3' />
    </Svg>
)

export const MouseIcon = () => (
    <Svg>
        <rect
            x='4.5'
            y='1.8'
            width='7'
            height='12.4'
            rx='3.5'
        />
        <path d='M8 4.5v2.5' />
    </Svg>
)

/* ---- animation transport ---- */

export const PlayIcon = () => (
    <Svg>
        <path
            d='M5.5 3.3 12.5 8l-7 4.7z'
            fill='currentColor'
        />
    </Svg>
)

export const StartIcon = () => (
    <Svg>
        <path d='M4 3.5v9' />
        <path
            d='M12.5 3.5 6 8l6.5 4.5z'
            fill='currentColor'
        />
    </Svg>
)

export const EndIcon = () => (
    <Svg>
        <path d='M12 3.5v9' />
        <path
            d='M3.5 3.5 10 8l-6.5 4.5z'
            fill='currentColor'
        />
    </Svg>
)

/** A tray with an arrow going into it, and the same tray with the arrow coming out. */
export const UploadIcon = () => (
    <Svg>
        <path d='M8 10V3M8 3 5.5 5.5M8 3l2.5 2.5' />
        <path d='M3 10v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2' />
    </Svg>
)

export const DownloadIcon = () => (
    <Svg>
        <path d='M8 3v7M8 10 5.5 7.5M8 10l2.5-2.5' />
        <path d='M3 10v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2' />
    </Svg>
)
