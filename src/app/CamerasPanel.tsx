import {IconButton} from '@astryxdesign/core/IconButton'
import {Text} from '@astryxdesign/core/Text'
import type {NamedCamera} from '../doc/cameras'
import type {Volume} from '../render/volume'
import {CameraIcon, CopyIcon, PlusIcon, TrashIcon} from './icons'
import {SectionHead} from './SectionHead'
import {Thumbnail} from './Thumbnail'

/**
 * The camera list from `docs/editor.png`: a three-wide grid of live thumbnails with the name laid
 * over the bottom of each tile, the selected one ringed in the accent, and a dashed tile at the end
 * that captures whatever the viewport is showing.
 *
 * Laid out as a radio group rather than as a set of cards, because that is what it is — one camera
 * is being looked at, and choosing another is a selection, not nine independent buttons. The
 * shutter glyph in each tile's corner is the mockup's way of saying the tile is a stored view, and
 * it is the same glyph the add tile carries.
 */
export const CamerasPanel = ({
    volume,
    cameras,
    selected,
    onSelect,
    onCapture,
    onDuplicate,
    onDelete
}: {
    volume: Volume
    cameras: readonly NamedCamera[]
    selected: string | undefined
    onSelect: (id: string) => void
    onCapture: () => void
    onDuplicate: () => void
    onDelete: (id: string) => void
}) => (
    <section className='section section-holds'>
        <SectionHead title='Cameras'>
            <IconButton
                label='Capture view as a camera'
                tooltip='Capture the current view'
                icon={<PlusIcon />}
                size='sm'
                variant='ghost'
                onClick={onCapture}
            />
            <IconButton
                label='Duplicate camera'
                tooltip='Duplicate the selected camera'
                icon={<CopyIcon />}
                size='sm'
                variant='ghost'
                isDisabled={selected === undefined}
                onClick={onDuplicate}
            />
            <IconButton
                label='Delete camera'
                tooltip='Delete the selected camera'
                icon={<TrashIcon />}
                size='sm'
                variant='ghost'
                isDisabled={selected === undefined}
                onClick={() => {
                    if (selected !== undefined) onDelete(selected)
                }}
            />
        </SectionHead>

        <div
            className='camera-grid'
            role='radiogroup'
            aria-label='Cameras'
        >
            {cameras.map(entry => (
                <button
                    key={entry.id}
                    type='button'
                    role='radio'
                    aria-checked={entry.id === selected}
                    className='camera-tile'
                    data-selected={entry.id === selected || undefined}
                    onClick={() => {
                        onSelect(entry.id)
                    }}
                >
                    <Thumbnail
                        volume={volume}
                        camera={entry.camera}
                    />
                    <span className='camera-name'>
                        <Text
                            type='supporting'
                            maxLines={1}
                        >
                            {entry.name}
                        </Text>
                        <span className='camera-badge'>
                            <CameraIcon />
                        </span>
                    </span>
                </button>
            ))}

            <button
                type='button'
                className='camera-add'
                onClick={onCapture}
            >
                <PlusIcon />
                <Text
                    type='supporting'
                    color='disabled'
                >
                    Add camera
                </Text>
            </button>
        </div>
    </section>
)
