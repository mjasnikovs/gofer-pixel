import {Text} from '@astryxdesign/core/Text'
import type {Dispatch} from 'react'
import type {Axis} from '../doc/brush'
import {PLANES} from './planes'
import {MagnetIcon} from './icons'
import type {AppAction, AppState} from './state'

/**
 * The tail of the brush column: the reference pictures, and nothing else.
 *
 * It held four things once — symmetry, the drawing plane, the reference rows and the voxel size —
 * and before that all four sat in a 193 × 260 box in the bottom-left corner beside the four view
 * switches that are now in the rail. That box held 259 px of content, measured, so it was full
 * before an artist did anything, and the first dropped reference picture added 41 px to an
 * `overflow: hidden` panel and silently clipped the voxel size off the bottom.
 *
 * The other three have found their own homes since, and both moves were the same argument. Symmetry
 * and the drawing plane are properties of the next stroke, so they are in the Brush section with
 * Size, Shape and Figure rather than four hundred pixels below them, under a whole palette. The
 * voxel size is a fact about the orbit camera and moves with the wheel, so it is over the viewport
 * in `HintBar`, beside the Wheel/Zoom hint that changes it.
 *
 * What is left is the one thing that is neither: a picture the artist is building against. It stays
 * here because it appears and disappears — a row per dropped picture, none at all until one is
 * dropped — and this is the column that scrolls and therefore cannot clip.
 *
 * There is no heading over it, only a rule. Every row in it names itself, and another upper-cased
 * word in a 216 px column would be the loudest thing in the column.
 */
export const ScenePanel = ({state, dispatch}: {state: AppState; dispatch: Dispatch<AppAction>}) => {
    const {references} = state
    /**
     * The four things a reference row can do. Together here rather than as four callbacks, because
     * three of them need the row they act on and only this panel has it.
     */
    const onReference = (onto: Axis, op: 'fainter' | 'brighter' | 'lock' | 'drop'): void => {
        const found = references.find(entry => entry.plane === onto)
        if (!found) return
        if (op === 'lock') {
            dispatch({type: 'reference', op: {kind: 'lock', plane: onto, on: !found.locked}})
        } else if (op === 'drop') {
            dispatch({type: 'reference', op: {kind: 'drop', plane: onto}})
        } else {
            dispatch({
                type: 'reference',
                op: {
                    kind: 'fade',
                    plane: onto,
                    opacity: found.opacity + (op === 'brighter' ? 0.15 : -0.15)
                }
            })
        }
    }

    /*
     * Nothing dropped, nothing drawn — not even the panel's own rule.
     *
     * It used to be four rows deep whatever the artist had done, so an empty `.scene-panel` was
     * never a shape anyone saw. It is only reference rows now, and a bordered box with nothing in it
     * is a divider under the palette that promises a section and delivers none.
     */
    if (references.length === 0) return undefined

    return (
        <div className='panel scene-panel'>
            {/*
             * Reference art — `FEATURESET.md` §33. Opacity steps rather than slides: this is a
             * 216 px column, and the artist wants fainter or brighter, not a number.
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
        </div>
    )
}
