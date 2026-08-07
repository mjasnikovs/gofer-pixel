import {Switch} from '@astryxdesign/core/Switch'
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
    MouseIcon,
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

/** What each tool does with the left button, said in the tooltip rather than left to be found. */
const HINTS: Record<Tool, string> = {
    draw: 'Write voxels in the loaded colour',
    erase: 'Clear the voxels under the brush',
    fill: 'Flood the connected region of one colour',
    pick: 'Load the colour of the voxel under the cursor',
    move: 'Drag out a selection, then drag it to move it. Ctrl-click adds to it',
    rotate: 'Grab a face and drag sideways to turn the selection 90°',
    scale: 'Pull a face of the selection to extrude it',
    clone: 'Drag a selection to leave a copy behind',
    measure: 'Not built yet — the left button still turns the view'
}

/**
 * Measure is in the rail because `docs/editor.png` draws nine tools, and it does nothing: arming it
 * leaves the left button to the camera. So it is greyed, and its tooltip says which. It stays
 * visible rather than being cut because the rail's nine-slot shape is the mockup's, and an artist who
 * has read the feature set should be able to see that this one is coming.
 */
const DEAD: ReadonlySet<Tool> = new Set<Tool>(['measure'])

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
        aria-disabled={DEAD.has(tool) || undefined}
        title={HINTS[tool]}
        className='tool'
        data-armed={isArmed || undefined}
        data-dead={DEAD.has(tool) || undefined}
        onClick={() => {
            if (!DEAD.has(tool)) onArm(tool)
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
 * The block under the rail: the switches, and the one number that decides what a pixel means.
 *
 * These used to be buttons whose state was the word ON or OFF in the accent colour, on the argument
 * that a two-letter word reads faster than a track. It does not — a word has to be read, and reading
 * it only tells you the state if you already know which of the two words to expect. A track is a
 * position, and a position is seen rather than read. It is also the shape every other application on
 * the artist's machine uses for exactly this, which is worth more than any argument about pixels.
 *
 * The icon stays, in its circle, and still lights in the accent: it is what names the switch at a
 * glance, and the label beside it is what names it exactly.
 */
const Toggle = ({
    label,
    hint,
    icon,
    isOn,
    onToggle
}: {
    label: string
    hint: string
    icon: ReactNode
    isOn: boolean
    onToggle: (on: boolean) => void
}) => (
    <div
        className='snap-toggle'
        data-on={isOn || undefined}
        title={hint}
    >
        <span className='snap-icon'>{icon}</span>
        {/* Name first, then the track, so the three rows read down the column as a settings list. */}
        <Switch
            label={label}
            size='sm'
            labelPosition='start'
            labelSpacing='spread'
            value={isOn}
            onChange={onToggle}
        />
    </div>
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
        title={title}
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
    invert,
    voxelSize,
    symmetry,
    canRadial,
    plane,
    references,
    onGrid,
    onSnap,
    onInvert,
    onSymmetry,
    onPlane,
    onReference
}: {
    grid: boolean
    snap: boolean
    invert: boolean
    voxelSize: number
    symmetry: {x: boolean; y: boolean; z: boolean; radial: boolean}
    canRadial: boolean
    plane: Axis | undefined
    references: readonly {plane: Axis; opacity: number; locked: boolean}[]
    onGrid: (on: boolean) => void
    onSnap: (on: boolean) => void
    onInvert: (on: boolean) => void
    onSymmetry: (axis: 'x' | 'y' | 'z' | 'radial', on: boolean) => void
    onPlane: (axis: Axis | undefined) => void
    onReference: (plane: Axis, op: 'fainter' | 'brighter' | 'lock' | 'drop') => void
}) => (
    <div className='panel snap-panel'>
        <div className='snap-row'>
            <Toggle
                label='Grid'
                hint='Draw the ground grid under the model'
                icon={<EyeIcon />}
                isOn={grid}
                onToggle={onGrid}
            />
            <Toggle
                label='Snap'
                hint='Hold zoom and pan to whole voxels, so a voxel edge lands on a pixel edge'
                icon={<MagnetIcon />}
                isOn={snap}
                onToggle={onSnap}
            />
            {/*
             * Which way a drag turns the model — an old argument with no right answer, which is why
             * it is a setting. Off is "grab the model and turn it", on is "swing the camera around
             * it", and an artist coming from a package that picked the other one wants this on the
             * first day rather than to relearn their hands.
             */}
            <Toggle
                label='Invert'
                hint='Reverse the direction a drag turns the view'
                icon={<MouseIcon />}
                isOn={invert}
                onToggle={onInvert}
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
                        title={entry.title}
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
        {/*
         * Reference art — `FEATURESET.md` §33. It appears only once something has been dropped on
         * the viewport, because a row of controls for a picture that is not there is a row of
         * controls for nothing. Opacity steps rather than slides: this is a 97 px column, and the
         * artist wants fainter or brighter, not a number.
         */}
        {references.map(entry => (
            <div
                className='snap-size'
                key={entry.plane}
            >
                <Text
                    type='supporting'
                    color='disabled'
                >
                    {PLANES.find(({axis}) => axis === entry.plane)?.label ?? 'Ref'} ref
                </Text>
                <span className='spacer' />
                <span className='symmetry-row'>
                    <button
                        type='button'
                        className='symmetry-axis'
                        aria-label='Fainter reference'
                        title='Fade the reference picture'
                        aria-disabled={entry.locked}
                        onClick={() => {
                            onReference(entry.plane, 'fainter')
                        }}
                    >
                        −
                    </button>
                    <button
                        type='button'
                        className='symmetry-axis'
                        aria-label='Brighter reference'
                        title='Bring the reference picture up'
                        aria-disabled={entry.locked}
                        onClick={() => {
                            onReference(entry.plane, 'brighter')
                        }}
                    >
                        +
                    </button>
                    <button
                        type='button'
                        role='switch'
                        aria-checked={entry.locked}
                        aria-label='Lock the reference'
                        title={
                            entry.locked ? 'Unlock the reference' : (
                                'Lock it, so it cannot be faded or dropped by accident'
                            )
                        }
                        className='symmetry-axis'
                        data-on={entry.locked || undefined}
                        onClick={() => {
                            onReference(entry.plane, 'lock')
                        }}
                    >
                        <MagnetIcon />
                    </button>
                    <button
                        type='button'
                        className='symmetry-axis'
                        aria-label='Remove the reference'
                        title='Drop the reference picture'
                        aria-disabled={entry.locked}
                        onClick={() => {
                            onReference(entry.plane, 'drop')
                        }}
                    >
                        ×
                    </button>
                </span>
            </div>
        ))}

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
