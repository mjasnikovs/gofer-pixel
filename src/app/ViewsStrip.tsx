import {Text} from '@astryxdesign/core/Text'
import type {NamedCamera} from '../doc/cameras'
import type {Volume} from '../render/volume'
import {CameraIcon, PlusIcon} from './icons'
import {SectionHead} from './SectionHead'
import {Thumbnail} from './Thumbnail'

/**
 * The VIEWS strip that runs under the viewport in `docs/editor.png`.
 *
 * It is the same camera list as the rail, at a size you can actually judge a sprite at, laid along
 * the axis a sprite sheet is read along. The mockup shows both, and it is right to: the rail is for
 * managing cameras and this is for looking at their output, which is why the tiles here are twice
 * the size and carry the name under the picture rather than over it.
 */
export const ViewsStrip = ({
    volume,
    cameras,
    selected,
    onSelect,
    onCapture
}: {
    volume: Volume
    cameras: readonly NamedCamera[]
    selected: string | undefined
    onSelect: (id: string) => void
    onCapture: () => void
}) => (
    <div className='panel views-panel'>
        <SectionHead title='Views' />
        <div
            className='views-strip'
            role='radiogroup'
            aria-label='Views'
        >
            {cameras.map(entry => (
                <button
                    key={entry.id}
                    type='button'
                    role='radio'
                    aria-checked={entry.id === selected}
                    className='view-tile'
                    data-selected={entry.id === selected || undefined}
                    onClick={() => {
                        onSelect(entry.id)
                    }}
                >
                    <span className='view-shot'>
                        <Thumbnail
                            volume={volume}
                            camera={entry.camera}
                            size={96}
                        />
                        {entry.id === selected ?
                            <span className='view-badge'>
                                <CameraIcon />
                            </span>
                        :   undefined}
                    </span>
                    <Text
                        type='supporting'
                        maxLines={1}
                    >
                        {entry.name}
                    </Text>
                </button>
            ))}

            <button
                type='button'
                className='view-add'
                onClick={onCapture}
            >
                <PlusIcon />
                <Text
                    type='supporting'
                    color='disabled'
                >
                    Capture view
                </Text>
            </button>
        </div>
    </div>
)
