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
import type {Tool} from './state'

/**
 * The left rail of `docs/editor.png`: nine tools, icon over label, the armed one carried by an
 * accent fill and an accent border rather than by a tint you have to hunt for.
 *
 * None of them writes a voxel — editing is on the proof of concept's do-not-build list — but which
 * tool is armed is real state, and arming one is what a hover, a cursor and eventually a stroke
 * will read. The rail is a radio group, because exactly one tool is armed at a time and a screen
 * reader should hear that rather than nine unrelated buttons.
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

export const GridPanel = ({
    grid,
    snap,
    voxelSize,
    onGrid,
    onSnap
}: {
    grid: boolean
    snap: boolean
    voxelSize: number
    onGrid: (on: boolean) => void
    onSnap: (on: boolean) => void
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
