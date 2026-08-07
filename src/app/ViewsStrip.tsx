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
 *
 * It is also where the sheet gets reordered — `FEATURESET.md` §16's "drag to reorder". This strip
 * runs in the same order the sheet packs its cells, so dragging a tile along it is dragging a cell
 * along the sheet, which is the only place that reads as what it does.
 *
 * The drag is pointer-down here, pointer-*enter* there: no drag image, no drop zones, no HTML5
 * drag-and-drop. A tile moves the moment the cursor is over it, so the strip is the preview, and
 * the whole gesture is two handlers dispatching one action the reducer already had.
 */
export const ViewsStrip = ({
    volume,
    cameras,
    selected,
    dragging,
    onSelect,
    onCapture,
    onDragStart,
    onDragOver,
    onDragEnd
}: {
    volume: Volume
    cameras: readonly NamedCamera[]
    selected: string | undefined
    dragging: string | undefined
    onSelect: (id: string) => void
    onCapture: () => void
    onDragStart: (id: string) => void
    onDragOver: (to: number) => void
    onDragEnd: () => void
}) => (
    <div className='panel views-panel'>
        <SectionHead title='Views' />
        <div
            className='views-strip'
            role='radiogroup'
            aria-label='Views'
            // A pointer that leaves the strip mid-drag has dropped the tile; the alternative is a
            // drag that survives the mouse going somewhere else entirely.
            onPointerLeave={onDragEnd}
        >
            {cameras.map((entry, index) => (
                <button
                    key={entry.id}
                    type='button'
                    role='radio'
                    aria-checked={entry.id === selected}
                    title={`${entry.name} — click to look through it, drag to reorder the sheet`}
                    className='view-tile'
                    data-selected={entry.id === selected || undefined}
                    data-dragging={entry.id === dragging || undefined}
                    onClick={() => {
                        onSelect(entry.id)
                    }}
                    onPointerDown={() => {
                        onDragStart(entry.id)
                    }}
                    onPointerEnter={() => {
                        if (dragging !== undefined && dragging !== entry.id) onDragOver(index)
                    }}
                    onPointerUp={onDragEnd}
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
                title='Store the current view as a new camera'
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
