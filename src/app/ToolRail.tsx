import {Text} from '@astryxdesign/core/Text'
import type {ReactNode} from 'react'
import {
    CloneIcon,
    DrawIcon,
    EraseIcon,
    EyeIcon,
    FillIcon,
    MagnetIcon,
    MeasureIcon,
    MoveIcon,
    PickIcon,
    RotateIcon,
    ScaleIcon
} from './icons'
import type {Axis} from '../doc/brush'
import type {Tool} from './state'

/**
 * The left rail of `docs/editor.png`: nine tools, icon over label, the armed one carried by an
 * accent fill and an accent border rather than by a tint you have to hunt for.
 *
 * The rail is a radio group, because exactly one tool is armed at a time and a screen reader should
 * hear that rather than nine unrelated buttons. Which tool is armed decides what the left button
 * does in the viewport: the first four write voxels, the next four work on a selection, and Measure
 * leaves the drag to the camera.
 */
const TOOL_ICONS: Record<Tool, ReactNode> = {
    draw: <DrawIcon />,
    erase: <EraseIcon />,
    fill: <FillIcon />,
    pick: <PickIcon />,
    move: <MoveIcon />,
    rotate: <RotateIcon />,
    scale: <ScaleIcon />,
    clone: <CloneIcon />,
    measure: <MeasureIcon />
}

const LABELS: Record<Tool, string> = {
    draw: 'Draw',
    erase: 'Erase',
    fill: 'Fill',
    pick: 'Pick',
    move: 'Move',
    rotate: 'Rotate',
    scale: 'Scale',
    clone: 'Clone',
    measure: 'Measure'
}

const ToolButton = ({
    tool,
    isArmed,
    onArm
}: {
    tool: Tool
    isArmed: boolean
    onArm: (tool: Tool) => void
}) => (
    <button
        type='button'
        role='radio'
        aria-checked={isArmed}
        className='tool'
        data-armed={isArmed || undefined}
        onClick={() => {
            onArm(tool)
        }}
    >
        <span className='tool-icon'>{TOOL_ICONS[tool]}</span>
        <span className='tool-label'>{LABELS[tool]}</span>
    </button>
)

export const ToolRail = ({
    tools,
    tool,
    onTool
}: {
    tools: readonly Tool[]
    tool: Tool
    onTool: (tool: Tool) => void
}) => (
    <div
        className='tool-rail'
        role='radiogroup'
        aria-label='Tool'
    >
        {tools.map(entry => (
            <ToolButton
                key={entry}
                tool={entry}
                isArmed={entry === tool}
                onArm={onTool}
            />
        ))}
    </div>
)

/**
 * The block under the rail: two switches and the one number that decides what a pixel means.
 *
 * A switch whose state is a word — ON, in the accent — rather than a track, because at this size
 * the mockup is right that a two-letter word is read faster than a 20 px slider, and because these
 * two are read far more often than they are changed.
 */
const Toggle = ({
    label,
    icon,
    isOn,
    onToggle
}: {
    label: string
    icon: ReactNode
    isOn: boolean
    onToggle: (on: boolean) => void
}) => (
    <button
        type='button'
        role='switch'
        aria-checked={isOn}
        aria-label={label}
        className='snap-toggle'
        data-on={isOn || undefined}
        onClick={() => {
            onToggle(!isOn)
        }}
    >
        <span className='snap-name'>{label}</span>
        <span className='snap-icon'>{icon}</span>
        <span className='snap-state'>{isOn ? 'ON' : 'OFF'}</span>
    </button>
)

/**
 * Draw-time symmetry, as three axis letters and a radial ring.
 *
 * Letters rather than switches: these four are read at a glance while drawing and are set once a
 * session, so they want to be small and unambiguous rather than large and legible from across the
 * room. Radial is disabled outright when the grid is not square in x and y, because a quarter turn
 * of an oblong box lands outside it — `FEATURESET.md` §10's "where mathematically voxel-safe" is a
 * disabled button, not a silent no-op.
 */
const SymmetryButton = ({
    label,
    title,
    isOn,
    isDisabled,
    onToggle
}: {
    label: string
    title: string
    isOn: boolean
    isDisabled: boolean
    onToggle: (on: boolean) => void
}) => (
    <button
        type='button'
        role='switch'
        aria-checked={isOn}
        aria-label={title}
        aria-disabled={isDisabled}
        className='symmetry-axis'
        data-on={isOn || undefined}
        onClick={() => {
            if (!isDisabled) onToggle(!isOn)
        }}
    >
        {label}
    </button>
)

const PLANES: readonly {axis: Axis | undefined; label: string; title: string}[] = [
    {axis: undefined, label: 'Face', title: 'Draw on the face under the cursor'},
    {axis: 0, label: 'YZ', title: 'Lock drawing to the YZ plane'},
    {axis: 1, label: 'XZ', title: 'Lock drawing to the XZ plane'},
    {axis: 2, label: 'XY', title: 'Lock drawing to the XY plane'}
]

export const GridPanel = ({
    grid,
    snap,
    voxelSize,
    symmetry,
    canRadial,
    plane,
    onGrid,
    onSnap,
    onSymmetry,
    onPlane
}: {
    grid: boolean
    snap: boolean
    voxelSize: number
    symmetry: {x: boolean; y: boolean; z: boolean; radial: boolean}
    canRadial: boolean
    plane: Axis | undefined
    onGrid: (on: boolean) => void
    onSnap: (on: boolean) => void
    onSymmetry: (axis: 'x' | 'y' | 'z' | 'radial', on: boolean) => void
    onPlane: (axis: Axis | undefined) => void
}) => (
    <div className='panel snap-panel'>
        <div className='snap-row'>
            <Toggle
                label='Grid'
                icon={<EyeIcon />}
                isOn={grid}
                onToggle={onGrid}
            />
            <Toggle
                label='Snap'
                icon={<MagnetIcon />}
                isOn={snap}
                onToggle={onSnap}
            />
        </div>
        <div className='snap-size'>
            <Text
                type='supporting'
                color='disabled'
            >
                Symmetry
            </Text>
            <span className='spacer' />
            <span className='symmetry-row'>
                {(['x', 'y', 'z'] as const).map(axis => (
                    <SymmetryButton
                        key={axis}
                        label={axis.toUpperCase()}
                        title={`Mirror drawing across ${axis.toUpperCase()}`}
                        isOn={symmetry[axis]}
                        isDisabled={false}
                        onToggle={on => {
                            onSymmetry(axis, on)
                        }}
                    />
                ))}
                <SymmetryButton
                    label='◴'
                    title={
                        canRadial ?
                            'Four-fold radial symmetry'
                        :   'Radial symmetry needs a grid that is square in X and Y'
                    }
                    isOn={symmetry.radial}
                    isDisabled={!canRadial}
                    onToggle={on => {
                        onSymmetry('radial', on)
                    }}
                />
            </span>
        </div>
        {/*
         * Which plane a stroke is flattened onto — `FEATURESET.md` §5. "Face" is the default and
         * means the canvas is whatever surface the cursor is on, which is where the stroke pins
         * itself anyway; the other three override that with a plane of the grid.
         */}
        <div className='snap-size'>
            <Text
                type='supporting'
                color='disabled'
            >
                Plane
            </Text>
            <span className='spacer' />
            <span
                className='symmetry-row'
                role='radiogroup'
                aria-label='Drawing plane'
            >
                {PLANES.map(entry => (
                    <button
                        key={entry.label}
                        type='button'
                        role='radio'
                        aria-checked={plane === entry.axis}
                        aria-label={entry.title}
                        className='symmetry-axis'
                        data-on={plane === entry.axis || undefined}
                        onClick={() => {
                            onPlane(entry.axis)
                        }}
                    >
                        {entry.label}
                    </button>
                ))}
            </span>
        </div>
        <div className='snap-size'>
            <Text
                type='supporting'
                color='disabled'
            >
                Voxel size
            </Text>
            <span className='spacer' />
            <Text
                type='supporting'
                hasTabularNumbers
            >
                {voxelSize} px
            </Text>
        </div>
    </div>
)
