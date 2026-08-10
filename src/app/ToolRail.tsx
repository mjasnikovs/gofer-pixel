import type {Dispatch, ReactNode} from 'react'
import {
    CloneIcon,
    DrawIcon,
    EraseIcon,
    EyeIcon,
    FillIcon,
    LatticeIcon,
    MagnetIcon,
    MeasureIcon,
    MouseIcon,
    MoveIcon,
    PickIcon,
    RotateIcon,
    ScaleIcon
} from './icons'
import type {AppAction, AppState, Tool} from './state'

/**
 * The left rail of `docs/editor.png`: nine tools, icon over label, the armed one carried by an
 * accent fill and an accent border rather than by a tint you have to hunt for.
 *
 * The rail is a radio group, because exactly one tool is armed at a time and a screen reader should
 * hear that rather than nine unrelated buttons. Which tool is armed decides what the left button
 * does in the viewport: the first four write voxels, the next four work on a selection, and Measure
 * leaves the drag to the camera.
 *
 * Under a divider it also carries the four view switches, which used to be a box in the bottom-left
 * corner with symmetry, the drawing plane, the reference rows and the voxel size crammed in beside
 * them — 259 px of content in a 260 px box, so one dropped reference picture clipped its own
 * controls. The rest of that box is `ScenePanel.tsx`, under the palette.
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

/** The four fields of `AppState` the rail's switches turn on and off. */
type Switchable = 'grid' | 'edges' | 'snap' | 'invert'

/**
 * The view switches: four icons in two rows of two, under the divider.
 *
 * They used to be icon, name and a track, one to a row. The argument for the track stands — a
 * position is seen where a word has to be read — and it does not survive the move, because the rail
 * is 96 px and a track plus a name that says what the track is for needs about 160.
 *
 * Nor do they wear the tool's face. Tried, and it was wrong: three of the four are on by default,
 * so three accent-filled boxes sat under one armed tool and the loudest thing in the column was its
 * resting state. The name goes to the tooltip and the state is carried by the icon's colour alone,
 * which is the one place in this rail that is affordable — there are four of them, they are read at
 * a glance while drawing, and none of them is destructive.
 *
 * Off is the same grey as an unarmed tool rather than the dimming `[data-dead]` uses, because in
 * this column faded already means "not built yet" and Measure is sitting four rows up saying so.
 *
 * They are `role='switch'` in a group of their own, so nothing hears them as a tenth tool, and the
 * `aria-label` is what carries the name now that nothing is drawn under the icon.
 */
const SWITCHES: readonly {field: Switchable; label: string; hint: string; icon: ReactNode}[] = [
    {
        field: 'grid',
        label: 'Grid',
        hint: 'Draw the ground grid under the model',
        icon: <EyeIcon />
    },
    {
        // Next to the ground grid because they are the same question asked twice — where the cells
        // are — and an artist looking for one of them looks here for the other.
        field: 'edges',
        label: 'Edges',
        hint: 'Outline each voxel on the model, so a flat face can be counted in cells',
        icon: <LatticeIcon />
    },
    {
        field: 'snap',
        label: 'Snap',
        hint: 'Hold zoom and pan to whole voxels, so a voxel edge lands on a pixel edge',
        icon: <MagnetIcon />
    },
    {
        // Which way a drag turns the model — an old argument with no right answer, which is why it
        // is a setting. Off is "grab the model and turn it", on is "swing the camera around it",
        // and an artist coming from a package that picked the other one wants this on the first day
        // rather than to relearn their hands.
        field: 'invert',
        label: 'Invert',
        hint: 'Reverse the direction a drag turns the view',
        icon: <MouseIcon />
    }
]

export const ToolRail = ({
    tools,
    state,
    dispatch
}: {
    tools: readonly Tool[]
    state: AppState
    dispatch: Dispatch<AppAction>
}) => (
    <div className='tool-rail'>
        <div
            className='tool-group'
            role='radiogroup'
            aria-label='Tool'
        >
            {tools.map(entry => (
                <ToolButton
                    key={entry}
                    tool={entry}
                    isArmed={entry === state.tool}
                    onArm={armed => {
                        dispatch({type: 'tool', tool: armed})
                    }}
                />
            ))}
        </div>

        <div className='tool-divider' />

        <div
            className='tool-group tool-switches'
            role='group'
            aria-label='View'
        >
            {SWITCHES.map(({field, label, hint, icon}) => (
                <button
                    key={field}
                    type='button'
                    role='switch'
                    aria-checked={state[field]}
                    aria-label={label}
                    // The tooltip is the only place the name is written now, so it leads with it.
                    title={`${label} — ${hint}`}
                    className='tool'
                    data-armed={state[field] || undefined}
                    onClick={() => {
                        dispatch({type: 'chrome', chrome: {[field]: !state[field]}})
                    }}
                >
                    <span className='tool-icon'>{icon}</span>
                </button>
            ))}
        </div>
    </div>
)
