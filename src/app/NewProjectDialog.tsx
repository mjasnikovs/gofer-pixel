import {Button} from '@astryxdesign/core/Button'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {NumberInput} from '@astryxdesign/core/NumberInput'
import {RadioList, RadioListItem} from '@astryxdesign/core/RadioList'
import {Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import {useState} from 'react'
import {
    clampAxis,
    DEFAULT_NAME,
    DEFAULT_TEMPLATE,
    MAX_AXIS,
    TEMPLATES,
    templateNamed
} from '../doc/templates'

/**
 * What New asks — `FEATURESET.md` §36's templates, without §36's project browser.
 *
 * A dialog rather than one hardcoded default, because the grid cannot be resized afterwards: the
 * size chosen here is the size the model has for its whole life, and MagicaVoxel's own answer to
 * the same problem is a resize command the artist has to find. Five named sizes and a custom
 * triple is the smaller version of that, and it costs one click for anyone who wants the default.
 *
 * `Custom` is a radio like the rest rather than a mode the number fields switch into, so nothing
 * changes what is selected while the artist is typing in it.
 */
const CUSTOM = 'Custom'

/**
 * Mounted only while it is open — `App.tsx` renders it behind the flag rather than passing one.
 *
 * That is what resets it. A dialog that stayed mounted would keep last time's half-typed name and
 * quietly offer to call the artist's second project after their first, and the alternative fix is
 * clearing three pieces of state from an effect, which is a cascade of renders to do the job an
 * unmount already does.
 */
export const NewProjectDialog = ({
    onClose,
    onCreate
}: {
    onClose: () => void
    onCreate: (size: readonly [number, number, number], name: string) => void
}) => {
    const [choice, setChoice] = useState(DEFAULT_TEMPLATE)
    const [name, setName] = useState(DEFAULT_NAME)
    const [custom, setCustom] = useState<readonly [number, number, number]>([32, 32, 32])

    const size = choice === CUSTOM ? custom : templateNamed(choice).size
    const [cx, cy, cz] = custom

    const axis = (index: 0 | 1 | 2, label: string) => (
        <NumberInput
            label={label}
            size='sm'
            min={1}
            max={MAX_AXIS}
            step={1}
            value={custom[index]}
            onChange={value => {
                const next: [number, number, number] = [cx, cy, cz]
                next[index] = clampAxis(value)
                setCustom(next)
                setChoice(CUSTOM)
            }}
        />
    )

    return (
        <Dialog
            isOpen
            purpose='form'
            width={420}
            onOpenChange={open => {
                if (!open) onClose()
            }}
        >
            <DialogHeader
                title='New project'
                subtitle='The grid cannot be resized later, so pick the box the model has to fit in.'
                onOpenChange={open => {
                    if (!open) onClose()
                }}
            />

            <div className='new-project'>
                <TextInput
                    label='Name'
                    size='sm'
                    value={name}
                    placeholder={DEFAULT_NAME}
                    onChange={value => {
                        setName(value)
                    }}
                />

                <RadioList
                    label='Template'
                    size='sm'
                    value={choice}
                    onChange={setChoice}
                >
                    {TEMPLATES.map(entry => (
                        <RadioListItem
                            key={entry.name}
                            label={entry.name}
                            value={entry.name}
                            description={entry.size.join(' × ')}
                        />
                    ))}
                    <RadioListItem
                        label={CUSTOM}
                        value={CUSTOM}
                        description={custom.join(' × ')}
                    />
                </RadioList>

                <div className='new-project-axes'>
                    {axis(0, 'X')}
                    {axis(1, 'Y')}
                    {axis(2, 'Z')}
                </div>

                {/* Z is up here, and an artist arriving from a 2D tool has no reason to know it. */}
                <Text
                    type='supporting'
                    color='disabled'
                >
                    Z is up — a character is tall in Z, a tile is flat in it.
                </Text>

                <div className='new-project-actions'>
                    <Button
                        label='Cancel'
                        variant='ghost'
                        size='sm'
                        onClick={onClose}
                    />
                    <Button
                        label='Create'
                        variant='primary'
                        size='sm'
                        onClick={() => {
                            onCreate(
                                [clampAxis(size[0]), clampAxis(size[1]), clampAxis(size[2])],
                                name.trim() || DEFAULT_NAME
                            )
                        }}
                    />
                </div>
            </div>
        </Dialog>
    )
}
