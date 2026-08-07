import {Text} from '@astryxdesign/core/Text'
import type {Axis} from '../doc/transform'
import {CopyIcon, RotateIcon, ScaleIcon, TrashIcon} from './icons'
import type {TransformOp} from './state'

/**
 * The controls that appear next to a selection and nowhere else — `FEATURESET.md` §4 and §39.
 *
 * Nine transforms would be nine permanent buttons in a panel, which is exactly the screen the
 * feature set says not to build. They live over the viewport, they exist only while something is
 * selected, and they take the space back when it is not.
 *
 * The axis letters are this project's axes, not the mockup's: `.vox` is z-up and so is the
 * raycaster, so Z is the vertical one. The gizmo in the corner says the same thing.
 */
const AXES: readonly {axis: Axis; label: string}[] = [
    {axis: 0, label: 'X'},
    {axis: 1, label: 'Y'},
    {axis: 2, label: 'Z'}
]

const Action = ({
    label,
    children,
    onPress
}: {
    label: string
    children: React.ReactNode
    onPress: () => void
}) => (
    <button
        type='button'
        className='selection-action'
        aria-label={label}
        title={label}
        onClick={onPress}
    >
        {children}
    </button>
)

export const SelectionBar = ({
    count,
    onTransform,
    onClear
}: {
    count: number
    onTransform: (op: TransformOp) => void
    onClear: () => void
}) => {
    if (count === 0) return undefined
    return (
        <div
            className='selection-bar'
            role='toolbar'
            aria-label='Selection'
        >
            <Text
                type='supporting'
                hasTabularNumbers
            >
                {count} voxels
            </Text>
            <span className='hint-divider' />

            <span className='selection-group'>
                <span className='selection-caption'>
                    <RotateIcon />
                </span>
                {AXES.map(({axis, label}) => (
                    <Action
                        key={`rotate-${label}`}
                        label={`Rotate 90° about ${label}`}
                        onPress={() => {
                            onTransform({kind: 'rotate', axis})
                        }}
                    >
                        {label}
                    </Action>
                ))}
            </span>

            <span className='selection-group'>
                <span className='selection-caption'>
                    <ScaleIcon />
                </span>
                {AXES.map(({axis, label}) => (
                    <Action
                        key={`flip-${label}`}
                        label={`Flip ${label}`}
                        onPress={() => {
                            onTransform({kind: 'flip', axis})
                        }}
                    >
                        {label}
                    </Action>
                ))}
            </span>

            <span className='selection-group'>
                <span className='selection-caption'>Mirror</span>
                {AXES.map(({axis, label}) => (
                    <Action
                        key={`mirror-${label}`}
                        label={`Mirror across ${label}`}
                        onPress={() => {
                            onTransform({kind: 'mirror', axis})
                        }}
                    >
                        {label}
                    </Action>
                ))}
            </span>

            <span className='hint-divider' />
            <Action
                label='Duplicate one voxel up'
                onPress={() => {
                    onTransform({kind: 'duplicate', delta: [0, 0, 1]})
                }}
            >
                <CopyIcon />
            </Action>
            <Action
                label='Delete selected voxels'
                onPress={() => {
                    onTransform({kind: 'delete'})
                }}
            >
                <TrashIcon />
            </Action>
            <Action
                label='Deselect'
                onPress={onClear}
            >
                Esc
            </Action>
        </div>
    )
}
