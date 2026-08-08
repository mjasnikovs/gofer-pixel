import {AlertDialog} from '@astryxdesign/core/AlertDialog'
import {IconButton} from '@astryxdesign/core/IconButton'
import {Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import {useMemo, useState} from 'react'
import {
    duplicateOffset,
    isShown,
    matching,
    objectExtents,
    type Extent,
    type Objects,
    type VoxObject
} from '../doc/objects'
import type {Volume} from '../render/volume'
import {CopyIcon, EyeIcon, MagnetIcon, PlusIcon, TrashIcon} from './icons'
import {SectionHead} from './SectionHead'
import type {ObjectOp} from './state'

/**
 * The object list — `FEATURESET.md` §8 and §28, and panel 4 of `docs/featureset.png`.
 *
 * `docs/editor.png` draws no object list, but `docs/featureset.png` draws one: an eye, a name, and
 * a `…` menu, six rows, no search box. The eye, the name and the row shape are followed. The `…`
 * is not, and that is deliberate — it was built and then taken out again.
 *
 * A `…` costs a click and a read before anything happens, and it hides state: whether an object is
 * soloed or locked is a fact about the row, and a fact behind a menu is a fact nobody has. Every
 * switch is a button on the row instead, lit when it is on, so the whole list can be read at a
 * glance and every one of them is one click. That is worth more than the tidier row, on a panel
 * the artist works out of rather than visits.
 *
 * The row therefore carries more than the mockup draws: a voxel count, so "what is in this object"
 * is answerable without hiding everything else, and five switches. Rename is the exception — it is
 * a double-click on the name, because there is nothing to show and a sixth button would be noise.
 *
 * Search survives, but only once the list is long enough for a filter to beat reading it. A search
 * box over the one object a freshly opened `.vox` file has is an empty room — the same argument
 * `FEATURESET.md` §29 makes against the command palette.
 *
 * Three pieces of state live here rather than in the reducer: which row is being renamed, which
 * row is being dragged, and whether the delete dialog is up. None of them is part of the document,
 * none survives a reload, and none is worth a round trip through `reduce`.
 */

/** Below this many objects the list is quicker to read than to filter. */
export const SEARCH_FROM = 8

const Row = ({
    entry,
    extent,
    volume,
    canRemove,
    isActive,
    isSoloed,
    shown,
    isRenaming,
    isDragging,
    onRename,
    onRenameEnd,
    onOp,
    onDelete,
    onDragStart,
    onDragOver,
    onDragEnd
}: {
    entry: VoxObject
    extent: Extent | undefined
    volume: Volume
    canRemove: boolean
    isActive: boolean
    isSoloed: boolean
    shown: boolean
    isRenaming: boolean
    isDragging: boolean
    onRename: () => void
    onRenameEnd: () => void
    onOp: (op: ObjectOp) => void
    onDelete: () => void
    onDragStart: () => void
    onDragOver: () => void
    onDragEnd: () => void
}) => {
    const count = extent?.count ?? 0
    const room = duplicateOffset(volume, extent) !== undefined
    return (
        <div
            className='object-row'
            data-active={isActive || undefined}
            data-dragging={isDragging || undefined}
            onPointerEnter={onDragOver}
            onPointerUp={onDragEnd}
        >
            <button
                type='button'
                role='switch'
                aria-checked={shown}
                aria-label={`Show ${entry.name}`}
                title={
                    isSoloed ? `Only ${entry.name} is shown`
                    : entry.hidden ?
                        `Show ${entry.name}`
                    :   `Hide ${entry.name}`
                }
                className='object-flag'
                data-on={shown || undefined}
                onClick={() => {
                    onOp({kind: 'hidden', id: entry.id, on: !entry.hidden})
                }}
            >
                <EyeIcon />
            </button>

            {isRenaming ?
                <TextInput
                    label={`Rename ${entry.name}`}
                    isLabelHidden
                    size='sm'
                    hasAutoFocus
                    value={entry.name}
                    onChange={name => {
                        onOp({kind: 'rename', id: entry.id, name})
                    }}
                    onBlur={onRenameEnd}
                    onKeyDown={event => {
                        if (event.key === 'Enter' || event.key === 'Escape') onRenameEnd()
                    }}
                />
            :   <button
                    type='button'
                    role='radio'
                    aria-checked={isActive}
                    aria-label={`Draw into ${entry.name}`}
                    title={`Draw into ${entry.name} — drag to reorder`}
                    className='object-name'
                    onDoubleClick={onRename}
                    // The drag starts on the name and nowhere else. Starting it on the row would
                    // arm a reorder every time one of the switches beside it was pressed.
                    onPointerDown={onDragStart}
                    onClick={() => {
                        onOp({kind: 'active', id: entry.id})
                    }}
                >
                    <Text type='supporting'>{entry.name}</Text>
                </button>
            }

            <span
                className='object-count'
                title={`${entry.name} holds ${String(count)} voxels`}
            >
                {count === 0 ? 'empty' : count}
            </span>

            <button
                type='button'
                role='switch'
                aria-checked={isSoloed}
                aria-label={`Show only ${entry.name}`}
                title={isSoloed ? 'Let every object back' : `Show only ${entry.name}`}
                className='object-flag'
                data-on={isSoloed || undefined}
                onClick={() => {
                    onOp({kind: 'solo', id: entry.id})
                }}
            >
                S
            </button>

            <button
                type='button'
                role='switch'
                aria-checked={entry.locked}
                aria-label={`Lock ${entry.name}`}
                title={entry.locked ? `Unlock ${entry.name}` : `Lock ${entry.name} against edits`}
                className='object-flag'
                data-on={entry.locked || undefined}
                onClick={() => {
                    onOp({kind: 'locked', id: entry.id, on: !entry.locked})
                }}
            >
                <MagnetIcon />
            </button>

            <button
                type='button'
                aria-label={`Duplicate ${entry.name}`}
                // The copy stands beside the original, so a full grid has nowhere to put it — see
                // `duplicateOffset`. A disabled button that says why beats one that does nothing.
                title={
                    room ?
                        `Duplicate ${entry.name} beside itself`
                    :   `No room beside ${entry.name} for a copy`
                }
                className='object-flag'
                disabled={!room}
                onClick={() => {
                    onOp({kind: 'copy', id: entry.id})
                }}
            >
                <CopyIcon />
            </button>

            <button
                type='button'
                aria-label={`Delete ${entry.name}`}
                title={
                    canRemove ?
                        `Delete ${entry.name} and its voxels`
                    :   'A document keeps at least one object'
                }
                className='object-flag'
                disabled={!canRemove}
                onClick={onDelete}
            >
                <TrashIcon />
            </button>
        </div>
    )
}

export const ObjectsPanel = ({
    objects,
    volume,
    query,
    canRemove,
    onQuery,
    onOp
}: {
    objects: Objects
    volume: Volume
    query: string
    canRemove: boolean
    onQuery: (query: string) => void
    onOp: (op: ObjectOp) => void
}) => {
    const [renaming, setRenaming] = useState<number | undefined>(undefined)
    const [dragging, setDragging] = useState<number | undefined>(undefined)
    const [pending, setPending] = useState<VoxObject | undefined>(undefined)

    const extents = useMemo(() => objectExtents(volume), [volume])
    const searchable = objects.list.length > SEARCH_FROM
    // A hidden box must not go on filtering. Deleting rows down past the threshold takes the box
    // away, and a filter nobody can see or clear is a list that has silently lost its rows.
    const rows = matching(objects, searchable ? query : '')

    const doomed = pending
    const doomedCount = doomed ? (extents.get(doomed.id)?.count ?? 0) : 0

    return (
        <section className='section section-holds'>
            <SectionHead title='Objects'>
                <IconButton
                    label='Add an object'
                    tooltip='Add an empty object and draw into it'
                    icon={<PlusIcon />}
                    size='sm'
                    variant='ghost'
                    onClick={() => {
                        onOp({kind: 'add'})
                    }}
                />
            </SectionHead>

            <div className='object-body'>
                {searchable ?
                    <TextInput
                        label='Search objects'
                        isLabelHidden
                        size='sm'
                        placeholder='Search'
                        value={query}
                        onChange={onQuery}
                    />
                :   undefined}

                <div
                    className='object-list'
                    role='radiogroup'
                    aria-label='Object'
                    // A pointer that leaves the list mid-drag has dropped the row, the same rule
                    // the views strip follows. The alternative is a drag that outlives the mouse.
                    onPointerLeave={() => {
                        setDragging(undefined)
                    }}
                >
                    {rows.map((entry, index) => (
                        <Row
                            key={entry.id}
                            entry={entry}
                            extent={extents.get(entry.id)}
                            volume={volume}
                            canRemove={canRemove}
                            isActive={entry.id === objects.active}
                            isSoloed={objects.solo === entry.id}
                            shown={isShown(objects, entry.id)}
                            isRenaming={renaming === entry.id}
                            isDragging={dragging === entry.id}
                            onRename={() => {
                                setRenaming(entry.id)
                            }}
                            onRenameEnd={() => {
                                setRenaming(undefined)
                            }}
                            onOp={onOp}
                            onDelete={() => {
                                setPending(entry)
                            }}
                            onDragStart={() => {
                                setDragging(entry.id)
                            }}
                            onDragOver={() => {
                                if (dragging !== undefined && dragging !== entry.id) {
                                    onOp({kind: 'reorder', id: dragging, to: index})
                                }
                            }}
                            onDragEnd={() => {
                                setDragging(undefined)
                            }}
                        />
                    ))}
                    {rows.length === 0 ?
                        <Text
                            type='supporting'
                            color='disabled'
                        >
                            No object matches that.
                        </Text>
                    :   undefined}
                </div>
            </div>

            {/*
             * Deleting an object takes its voxels with it. Undo brings both back — see the `remove`
             * case in `state.ts` — but "you can undo it" is not a reason to let a stray click cost
             * an hour in silence. The dialog says the name and the count, which is the whole of
             * what is about to be lost, in the same spirit as the drag hint's voxel toll.
             */}
            <AlertDialog
                isOpen={doomed !== undefined}
                onOpenChange={() => {
                    setPending(undefined)
                }}
                title={doomed ? `Delete ${doomed.name}?` : 'Delete object?'}
                description={
                    doomedCount === 0 ?
                        'It is empty, so this only takes the name. Ctrl-Z brings it back.'
                    :   `This takes ${String(doomedCount)} voxels with it. Ctrl-Z brings them back.`
                }
                actionLabel='Delete'
                onAction={() => {
                    if (doomed) onOp({kind: 'remove', id: doomed.id})
                    setPending(undefined)
                }}
            />
        </section>
    )
}
