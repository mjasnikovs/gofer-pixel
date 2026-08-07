/**
 * Three glyphs the icon registry does not carry.
 *
 * `astryx docs icons` lists what a theme resolves by name, and a camera shutter, a trash can and a
 * plus are not among them — but `IconButton` takes a node as well as a name, so these are drawn
 * here rather than approximated with a semantic icon that means something else. They inherit
 * `currentColor`, so the button's variant still decides what colour they are.
 */
const Svg = ({children}: {children: React.ReactNode}) => (
    <svg
        width='16'
        height='16'
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
