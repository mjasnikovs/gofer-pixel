import type {Dispatch} from 'react'
import {IconButton} from '@astryxdesign/core/IconButton'
import {Text} from '@astryxdesign/core/Text'
import {DIRECTION_COUNTS} from '../doc/cameras'
import type {Volume} from '../render/volume'
import {CameraIcon, CopyIcon, PlusIcon, TrashIcon} from './icons'
import {SectionHead} from './SectionHead'
import {Thumbnail} from './Thumbnail'
import type {AppAction, AppState} from './state'

/**
 * The VIEWS strip that runs under the viewport in `docs/editor.png`, and the only camera list there
 * is.
 *
 * The mockup drew this strip and a CAMERAS grid in the rail, and for a while the app had both. They
 * were the same list, the same selection and the same capture button at two sizes, so the rail one
 * is gone and its controls moved here. A camera is judged by its picture, and this is the place the
 * picture is big enough to judge — laid along the axis a sprite sheet is read along.
 *
 * The head carries what the rail used to: `FEATURESET.md` §13's one-click direction rings, §14's
 * alignment, and capture/duplicate/delete for the selected camera.
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
    state,
    dispatch,
    volume
}: {
    state: AppState
    dispatch: Dispatch<AppAction>
    /** The grid with hidden objects taken out — memoised in `App.tsx`. See `ExportPanel`. */
    volume: Volume
}) => {
    const {cameras, selected, draggingCamera: dragging} = state
    const onCapture = (): void => {
        dispatch({type: 'capture'})
    }
    /** A drag that ends anywhere — off the strip, on a row, or with the pointer released. */
    const onDragEnd = (): void => {
        if (dragging !== undefined) dispatch({type: 'chrome', chrome: {draggingCamera: undefined}})
    }
    return (
        <div className='panel views-panel'>
            <SectionHead title='Views'>
                {DIRECTION_COUNTS.map(count => (
                    <button
                        key={count}
                        type='button'
                        className='symmetry-axis'
                        aria-label={`Create ${String(count)} directions`}
                        title={`Replace the list with ${String(count)} cameras around one pivot`}
                        onClick={() => {
                            dispatch({type: 'directions', count})
                        }}
                    >
                        {count}
                    </button>
                ))}
                <button
                    type='button'
                    className='symmetry-axis'
                    aria-label='Align the view to the nearest stop'
                    title='Turn the view to the nearest eighth and the nearest pitch'
                    onClick={() => {
                        dispatch({type: 'align'})
                    }}
                >
                    ⌖
                </button>
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
                    onClick={() => {
                        dispatch({type: 'duplicate'})
                    }}
                />
                <IconButton
                    label='Delete camera'
                    tooltip='Delete the selected camera'
                    icon={<TrashIcon />}
                    size='sm'
                    variant='ghost'
                    isDisabled={selected === undefined}
                    onClick={() => {
                        if (selected !== undefined) dispatch({type: 'delete', id: selected})
                    }}
                />
            </SectionHead>
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
                            dispatch({type: 'select', id: entry.id})
                        }}
                        onPointerDown={() => {
                            dispatch({type: 'chrome', chrome: {draggingCamera: entry.id}})
                        }}
                        onPointerEnter={() => {
                            if (dragging !== undefined && dragging !== entry.id) {
                                dispatch({type: 'reorder-camera', id: dragging, to: index})
                            }
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
}
