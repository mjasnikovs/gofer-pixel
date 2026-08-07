import {IconButton} from '@astryxdesign/core/IconButton'
import {Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import {matching, type Objects, type VoxObject} from '../doc/objects'
import {EyeIcon, MagnetIcon, PlusIcon, TrashIcon} from './icons'
import {SectionHead} from './SectionHead'
import type {ObjectOp} from './state'

/**
 * The object list — `FEATURESET.md` §8 and §28, which asks for these to be called Objects and not
 * Layers, and for the list to stop at search, hide, lock and solo.
 *
 * It is not in `docs/editor.png`, which draws no object list at all. The mockup wins where the two
 * *disagree*; here it is simply silent, so this follows the feature set and borrows the cameras
 * panel's chrome so the rail still reads as one thing.
 *
 * A row is one line: a name that renames in place, and three switches. Hide and Lock are per
 * object; Solo is exclusive, and clicking the soloed one again lets everybody back.
 */
const Row = ({
    entry,
    isActive,
    isSoloed,
    onOp
}: {
    entry: VoxObject
    isActive: boolean
    isSoloed: boolean
    onOp: (op: ObjectOp) => void
}) => (
    <div
        className='object-row'
        data-active={isActive || undefined}
    >
        <button
            type='button'
            role='radio'
            aria-checked={isActive}
            aria-label={`Draw into ${entry.name}`}
            title={`Draw into ${entry.name}`}
            className='object-name'
            onClick={() => {
                onOp({kind: 'active', id: entry.id})
            }}
        >
            <Text type='supporting'>{entry.name}</Text>
        </button>

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
            role='switch'
            aria-checked={!entry.hidden}
            aria-label={`Show ${entry.name}`}
            title={entry.hidden ? `Show ${entry.name}` : `Hide ${entry.name}`}
            className='object-flag'
            data-on={!entry.hidden || undefined}
            onClick={() => {
                onOp({kind: 'hidden', id: entry.id, on: !entry.hidden})
            }}
        >
            <EyeIcon />
        </button>
    </div>
)

export const ObjectsPanel = ({
    objects,
    query,
    canRemove,
    onQuery,
    onRename,
    onOp
}: {
    objects: Objects
    query: string
    canRemove: boolean
    onQuery: (query: string) => void
    onRename: (name: string) => void
    onOp: (op: ObjectOp) => void
}) => {
    const rows = matching(objects, query)
    const active = objects.list.find(entry => entry.id === objects.active)
    return (
        <section className='section section-holds'>
            <SectionHead title='Objects'>
                <IconButton
                    label='Add an object'
                    tooltip='Add an object'
                    icon={<PlusIcon />}
                    size='sm'
                    variant='ghost'
                    onClick={() => {
                        onOp({kind: 'add'})
                    }}
                />
                <IconButton
                    label='Delete the active object'
                    tooltip={
                        canRemove ?
                            'Delete the active object and its voxels'
                        :   'A document keeps at least one object'
                    }
                    icon={<TrashIcon />}
                    size='sm'
                    variant='ghost'
                    isDisabled={!canRemove}
                    onClick={() => {
                        onOp({kind: 'remove', id: objects.active})
                    }}
                />
            </SectionHead>

            <div className='object-body'>
                {/*
                 * Search over a list this small is a filter, and that is the whole feature §28
                 * asks for. The rename box below is the same input twice over: naming the active
                 * object is the only rename anyone does, so there is no second place to do it.
                 */}
                <TextInput
                    label='Search objects'
                    isLabelHidden
                    size='sm'
                    placeholder='Search'
                    value={query}
                    onChange={onQuery}
                />

                <div
                    className='object-list'
                    role='radiogroup'
                    aria-label='Object'
                >
                    {rows.map(entry => (
                        <Row
                            key={entry.id}
                            entry={entry}
                            isActive={entry.id === objects.active}
                            isSoloed={objects.solo === entry.id}
                            onOp={onOp}
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

                <TextInput
                    label='Rename the active object'
                    isLabelHidden
                    size='sm'
                    placeholder='Name'
                    value={active?.name ?? ''}
                    onChange={onRename}
                />
            </div>
        </section>
    )
}
