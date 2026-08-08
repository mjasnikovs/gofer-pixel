import {Button} from '@astryxdesign/core/Button'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'

/**
 * The guard in front of New and Open.
 *
 * A `Dialog` rather than the `AlertDialog` the object list uses, because this question has three
 * honest answers and `AlertDialog` offers two. Losing "Save first" would make the artist cancel,
 * press Ctrl+S, and open the menu again — three steps to say yes to the thing they wanted.
 *
 * Save is the primary and it is first, because whoever arrived here by accident wants their work
 * kept. Discard is the plain button rather than a red one: it is the answer for somebody who meant
 * it, and dressing every leaving-without-saving as a catastrophe teaches people to click through
 * warnings.
 */
export const UnsavedDialog = ({
    isOpen,
    name,
    everSaved,
    onSave,
    onDiscard,
    onCancel
}: {
    isOpen: boolean
    name: string
    /** Whether this document has ever been written to disk. Changes what is at stake. */
    everSaved: boolean
    onSave: () => void
    onDiscard: () => void
    onCancel: () => void
}) => (
    <Dialog
        isOpen={isOpen}
        purpose='form'
        width={400}
        onOpenChange={open => {
            if (!open) onCancel()
        }}
    >
        <DialogHeader
            title={`Leave ${name} unsaved?`}
            subtitle={
                everSaved ?
                    'There are changes here that the file on disk does not have.'
                :   'This document has never been written to disk.'
            }
            onOpenChange={open => {
                if (!open) onCancel()
            }}
        />
        <div className='dialog-actions'>
            <Button
                label='Cancel'
                variant='ghost'
                size='sm'
                onClick={onCancel}
            />
            <Button
                label='Discard'
                size='sm'
                onClick={onDiscard}
            />
            <Button
                label='Save first'
                variant='primary'
                size='sm'
                onClick={onSave}
            />
        </div>
    </Dialog>
)
