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

export const DrawIcon = () => (
    <Svg>
        <path d='M11.4 2.6a1.6 1.6 0 0 1 2.2 2.2L5.6 12.8 2.5 13.5l.7-3.1z' />
        <path d='M10 4l2 2' />
    </Svg>
)

export const EraseIcon = () => (
    <Svg>
        <path d='M9.2 2.8 2.8 9.2a1.5 1.5 0 0 0 0 2.1l1.9 1.9h4l6.5-6.5a1.5 1.5 0 0 0 0-2.1l-2-2a1.5 1.5 0 0 0-2 0z' />
        <path d='M6 6l4 4M4.7 13.2h8.6' />
    </Svg>
)

export const FillIcon = () => (
    <Svg>
        <path d='M6.4 2.2 12.6 8.4a1 1 0 0 1 0 1.4l-3.9 3.9a1 1 0 0 1-1.4 0L2.6 8.9z' />
        <path d='M4.5 4.1 3 2.6M14 11c.8 1.2 1.2 2 1.2 2.5a1.2 1.2 0 0 1-2.4 0c0-.5.4-1.3 1.2-2.5z' />
    </Svg>
)

export const PickIcon = () => (
    <Svg>
        <path d='M11 2.4a1.8 1.8 0 0 1 2.6 2.6l-1 1 .8.8-1.3 1.3-.8-.8-5 5-2.6.6.6-2.6 5-5-.8-.8L9.8 3.2l.8.8z' />
    </Svg>
)

export const MoveIcon = () => (
    <Svg>
        <path d='M8 1.8v12.4M1.8 8h12.4M8 1.8 6.2 3.8M8 1.8 9.8 3.8M8 14.2 6.2 12.2M8 14.2 9.8 12.2M1.8 8 3.8 6.2M1.8 8 3.8 9.8M14.2 8l-2-1.8M14.2 8l-2 1.8' />
    </Svg>
)

export const RotateIcon = () => (
    <Svg>
        <path d='M13.4 8a5.4 5.4 0 1 1-1.9-4.1' />
        <path d='M13.7 1.9v3h-3' />
    </Svg>
)

export const ScaleIcon = () => (
    <Svg>
        <path d='M2.5 2.5h11v11h-11z' />
        <path d='M5.5 10.5l5-5M10.5 5.5h-3M10.5 5.5v3' />
    </Svg>
)

export const CloneIcon = () => (
    <Svg>
        <path d='M5.5 5.5h8v8h-8z' />
        <path d='M10.5 5.5v-3h-8v8h3' />
    </Svg>
)

export const MeasureIcon = () => (
    <Svg>
        <path d='M2 9.9 9.9 2l4.1 4.1L6.1 14z' />
        <path d='M5 6.9l1.2 1.2M7 4.9l1.2 1.2M9 2.9l1.2 1.2M3 8.9l1.2 1.2' />
    </Svg>
)

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
