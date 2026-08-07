import {Button} from '@astryxdesign/core/Button'
import {IconButton} from '@astryxdesign/core/IconButton'
import {SelectableCard} from '@astryxdesign/core/SelectableCard'
import {Text} from '@astryxdesign/core/Text'
import {useMemo} from 'react'
import type {NamedCamera} from '../doc/cameras'
import {basisFor} from '../render/camera'
import {render} from '../render/raycast'
import type {Volume} from '../render/volume'
import {CameraIcon, TrashIcon} from './icons'
import {PixelCanvas} from './PixelCanvas'
import {SectionHead} from './SectionHead'

/**
 * The camera list from `docs/editor.png`: a three-wide grid of live thumbnails with the name laid
 * over the bottom of each tile, the selected one ringed in the accent, and a dashed tile at the end
 * that captures whatever the viewport is showing.
 *
 * The thumbnails come off the CPU raycaster — the same code that writes the exported sheet — so
 * what the artist picks from is what they get, rather than a preview drawn by a second renderer
 * that agrees with the first only most of the time. A 72 px thumbnail is a fraction of a
 * millisecond, so eight of them re-render whenever the list changes and nothing is cached.
 */
const THUMBNAIL = 72

const Thumbnail = ({volume, camera}: {volume: Volume; camera: NamedCamera['camera']}) => {
    const pixels = useMemo(
        () => render(volume, basisFor(camera, volume, THUMBNAIL), THUMBNAIL, THUMBNAIL).color,
        [volume, camera]
    )
    return (
        <PixelCanvas
            width={THUMBNAIL}
            height={THUMBNAIL}
            data={pixels}
            className='thumbnail'
        />
    )
}

export const CamerasPanel = ({
    volume,
    cameras,
    selected,
    onSelect,
    onCapture,
    onEightDirections,
    onDelete
}: {
    volume: Volume
    cameras: readonly NamedCamera[]
    selected: string | undefined
    onSelect: (id: string) => void
    onCapture: () => void
    onEightDirections: () => void
    onDelete: (id: string) => void
}) => (
    <section className='section section-holds'>
        <SectionHead title='Cameras'>
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

        <div className='camera-grid'>
            {cameras.map(entry => (
                <SelectableCard
                    key={entry.id}
                    label={entry.name}
                    isSelected={entry.id === selected}
                    onChange={() => {
                        onSelect(entry.id)
                    }}
                    padding={0}
                >
                    <div className='camera-tile'>
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
                        </span>
                    </div>
                </SelectableCard>
            ))}

            <button
                type='button'
                className='camera-add'
                onClick={onCapture}
            >
                <CameraIcon />
                <Text
                    type='supporting'
                    color='disabled'
                >
                    Capture view
                </Text>
            </button>
        </div>

        <div className='section-foot'>
            <Button
                label='Create 8 directions'
                size='sm'
                variant='ghost'
                width='100%'
                onClick={onEightDirections}
            />
        </div>
    </section>
)
