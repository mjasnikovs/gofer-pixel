import {IconButton} from '@astryxdesign/core/IconButton'
import {Selector} from '@astryxdesign/core/Selector'
import {Text} from '@astryxdesign/core/Text'
import type {NamedCamera} from '../doc/cameras'
import type {Volume} from '../render/volume'
import {EndIcon, PlayIcon, PlusIcon, StartIcon} from './icons'
import {Thumbnail} from './Thumbnail'

/**
 * The animation bar along the bottom of `docs/editor.png`.
 *
 * The document holds one frame, and the strip shows one frame. `docs/FEATURESET.md` §24 postpones
 * animation but asks that the format be able to hold a *list* of voxel states from the start, so
 * the bar is here at its real size with the one frame that exists — the transport is disabled
 * because there is nothing to play, not because playing is unimplemented in some vaguer way.
 *
 * Filling the strip with ten copies of the same thumbnail would have matched the mockup exactly and
 * told the artist their model was animated. That is the trade this bar refuses.
 */
const FPS_OPTIONS = ['12', '24', '30', '60']

/** The ruler's labelled stops, the mockup's own. */
const TICKS = [1, 5, 10, 15, 20, 25, 30]

export const Timeline = ({
    volume,
    camera,
    frame,
    fps,
    onFps
}: {
    volume: Volume
    camera: NamedCamera | undefined
    frame: number
    fps: number
    onFps: (fps: number) => void
}) => (
    <footer className='timeline'>
        <div className='timeline-transport'>
            <Text
                type='supporting'
                weight='semibold'
            >
                Animation
            </Text>
            <IconButton
                label='Play'
                tooltip='One frame — nothing to play'
                icon={<PlayIcon />}
                variant='ghost'
                isDisabled
            />
            <IconButton
                label='First frame'
                tooltip='First frame'
                icon={<StartIcon />}
                size='sm'
                variant='ghost'
                isDisabled
            />
            <IconButton
                label='Last frame'
                tooltip='Last frame'
                icon={<EndIcon />}
                size='sm'
                variant='ghost'
                isDisabled
            />
            <Selector
                label='Frame rate'
                isLabelHidden
                size='sm'
                width={110}
                value={String(fps)}
                options={FPS_OPTIONS.map(value => ({value, label: `${value} FPS`}))}
                onChange={value => {
                    onFps(Number(value))
                }}
            />
        </div>

        <div className='timeline-track'>
            <div
                className='timeline-ruler'
                aria-hidden='true'
            >
                {TICKS.map(tick => (
                    <span
                        key={tick}
                        className='tick'
                        data-now={tick === frame || undefined}
                        style={{left: `${String(((tick - 1) / 30) * 100)}%`}}
                    >
                        {tick}
                    </span>
                ))}
            </div>

            <div className='timeline-frames'>
                <button
                    type='button'
                    className='frame-tile'
                    data-selected
                    aria-current='true'
                >
                    {camera ?
                        <Thumbnail
                            volume={volume}
                            camera={camera.camera}
                            size={64}
                        />
                    :   <span className='frame-blank' />}
                    <span className='frame-number'>{frame}</span>
                </button>

                <button
                    type='button'
                    className='frame-add'
                    disabled
                    title='Frames need an editable document — see FEATURESET §24'
                >
                    <PlusIcon />
                    <Text
                        type='supporting'
                        color='disabled'
                    >
                        Add frame
                    </Text>
                </button>
            </div>
        </div>
    </footer>
)
