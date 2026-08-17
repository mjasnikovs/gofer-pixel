import {IconButton} from '@astryxdesign/core/IconButton'
import {Slider} from '@astryxdesign/core/Slider'
import type {Dispatch} from 'react'
import {DEFAULT_LIGHTING, type Lighting} from '../render/light'
import {ResetIcon} from './icons'
import {SectionHead} from './SectionHead'
import type {AppAction, AppState} from './state'

/**
 * The viewport's sun — `FEATURESET.md` §21, see `render/light.ts`.
 *
 * **Nothing here reaches a sprite.** Lighting is the game engine's job, which is what §21 said and
 * what the normal, depth and AO maps are for: an exported colour map that had already been lit
 * would be lit twice, by two lights that know nothing about each other. So this is a modelling aid,
 * and it sits in the same place as the voxel lattice — one thing the viewport draws that the CPU
 * exporter is never asked for. Every thumbnail in the window, the render panel and the whole export
 * dialog stay flat, because those all stand for a file.
 *
 * It appears and disappears the way `ScenePanel`'s reference rows do: the switch that summons it is
 * the header's sun, lighting is off by default, and four rows of controls for a feature nobody has
 * turned on is a section of the rail spent saying nothing. Off, this is not a greyed section; it is
 * no section.
 *
 * Sliders rather than steppers, and the rail rather than the brush column, because the two are the
 * same decision. A sun is aimed, not set: the artist is looking at the model and turning the light
 * until the shape reads, which is a gesture with no number in it. That needs a track wide enough to
 * sweep — about 160 px — and the brush column is 216 px total against this rail's 384.
 *
 * **`onChange`, not `onChangeEnd`** — the light follows the drag. It is the right default and it is
 * also the cheap one, which is only true because the sun stops at the viewport: a step redraws one
 * GPU frame, 0.17 ms idle and 2.4 ms with something else on the same card, and no thumbnail, no
 * sprite cache entry and no sheet is touched. A sun that only moved when the mouse came up would be
 * asking the artist to aim a light they cannot see moving.
 */
const SLIDERS: readonly {
    field: keyof Omit<Lighting, 'on'>
    label: string
    hint: string
    max: number
    step: number
    format: (value: number) => string
}[] = [
    {
        field: 'azimuth',
        label: 'Angle',
        hint: 'Which way the sun comes from. 0° is out along +x, turning toward +y',
        max: 359,
        step: 5,
        format: value => `${String(Math.round(value))}°`
    },
    {
        field: 'elevation',
        label: 'Height',
        hint: 'How far the sun is off the horizon. 90° is straight overhead',
        max: 90,
        step: 5,
        format: value => `${String(Math.round(value))}°`
    },
    {
        field: 'sun',
        label: 'Sun',
        hint: 'How much brighter a face turned into the sun is than one turned away',
        max: 1,
        step: 0.05,
        format: value => `${String(Math.round(value * 100))}%`
    },
    {
        field: 'ambient',
        label: 'Ambient',
        hint: 'The floor under every face — what a face turned right away still gets',
        max: 1,
        step: 0.05,
        format: value => `${String(Math.round(value * 100))}%`
    }
]

export const LightPanel = ({state, dispatch}: {state: AppState; dispatch: Dispatch<AppAction>}) => {
    const {lighting} = state
    if (!lighting.on) return undefined

    /*
     * Compared field by field rather than by identity, because the artist can nudge a slider and
     * put it back — and a reset button that stayed live after that would be claiming there is
     * something to undo when there is not. `on` is not in it: it is true for as long as this
     * section exists, so it can never be the field that makes the answer no.
     */
    const atDefault = SLIDERS.every(({field}) => lighting[field] === DEFAULT_LIGHTING[field])

    return (
        <section className='section section-holds'>
            <SectionHead title='Sun'>
                {/*
                 * Back to the default angle, and no further — `on` is left alone.
                 *
                 * Resetting a panel must not close it. The switch that opened this section is four
                 * hundred pixels away in the header, so a reset that also turned the sun off would
                 * read as the button having removed the whole feature.
                 *
                 * Greyed once there is nothing to put back, rather than hidden: a control that
                 * vanishes when it has no work is a control the artist has to rediscover.
                 */}
                <IconButton
                    label='Reset the sun'
                    tooltip={
                        atDefault ?
                            'The sun is already at its default angle'
                        :   'Put the sun back to its default angle and strength'
                    }
                    icon={<ResetIcon />}
                    size='sm'
                    variant='ghost'
                    isDisabled={atDefault}
                    onClick={() => {
                        // `on` is deliberately not in it — see above. Spreading the whole default
                        // would carry `on: false` and close the section the click was aimed at.
                        dispatch({type: 'lighting', lighting: {...DEFAULT_LIGHTING, on: true}})
                    }}
                />
            </SectionHead>
            <div className='render-body'>
                {SLIDERS.map(({field, label, hint, max, step, format}) => (
                    <Slider
                        key={field}
                        label={label}
                        labelTooltip={hint}
                        min={0}
                        max={max}
                        step={step}
                        value={lighting[field]}
                        valueDisplay='text'
                        formatValue={format}
                        /*
                         * Straight to the reducer on every step of the drag. The clamp and the
                         * azimuth's wrap are not here and must not be: `withLight` owns them, so a
                         * slider and a keyboard arrow land in the same range.
                         */
                        onChange={(value: number) => {
                            dispatch({type: 'lighting', lighting: {[field]: value}})
                        }}
                    />
                ))}
            </div>
        </section>
    )
}
