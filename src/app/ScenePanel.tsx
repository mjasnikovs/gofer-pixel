import {Text} from '@astryxdesign/core/Text'
import type {Dispatch} from 'react'
import type {Axis} from '../doc/brush'
import {canRadial as symmetryCanRadial} from '../doc/symmetry'
import {MagnetIcon} from './icons'
import type {AppAction, AppState} from './state'

/**
 * The tail of the brush column: symmetry, the drawing plane, the reference rows and the one number
 * that says what a pixel means.
 *
 * All four used to sit in a 193 × 260 box in the bottom-left corner, beside the four view switches
 * that are now in the rail. That box held 259 px of content — measured — so it was full before an
 * artist did anything, and the first dropped reference picture added 41 px to a `overflow: hidden`
 * panel and silently clipped the voxel size off the bottom. It is here because everything in it is
 * about the stroke about to be made, which is what the rest of this column is about, and because a
 * column that scrolls cannot clip.
 *
 * There is no heading over it, only a rule. Every row in it names itself, and a fifth upper-cased
 * word in a 216 px column would be the loudest thing in the column.
 */

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

export const ScenePanel = ({state, dispatch}: {state: AppState; dispatch: Dispatch<AppAction>}) => {
    const {symmetry, plane, references, volume} = state
    const canRadial = symmetryCanRadial(volume)
    /** How wide one voxel lands on screen. The zoom is pixels per world unit; a voxel is one. */
    const voxelSize = Math.max(1, Math.round(state.output.cell / state.orbit.camera.zoom))
    /**
     * The four things a reference row can do. Together here rather than as four callbacks, because
     * three of them need the row they act on and only this panel has it.
     */
    const onReference = (onto: Axis, op: 'fainter' | 'brighter' | 'lock' | 'drop'): void => {
        const found = references.find(entry => entry.plane === onto)
        if (!found) return
        if (op === 'lock') dispatch({type: 'reference-lock', plane: onto, on: !found.locked})
        else if (op === 'drop') dispatch({type: 'reference-drop', plane: onto})
        else {
            dispatch({
                type: 'reference-opacity',
                plane: onto,
                opacity: found.opacity + (op === 'brighter' ? 0.15 : -0.15)
            })
        }
    }
    return (
        <div className='panel scene-panel'>
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
                                dispatch({type: 'symmetry', axis, on})
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
                            dispatch({type: 'symmetry', axis: 'radial', on})
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
                                dispatch({type: 'plane', axis: entry.axis})
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
             * controls for nothing. Opacity steps rather than slides: this is a 216 px column, and the
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
}
