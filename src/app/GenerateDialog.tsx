import {Button} from '@astryxdesign/core/Button'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {Text} from '@astryxdesign/core/Text'

/**
 * The shell of the generate dialog, with nothing behind it.
 *
 * `src/gen/` is gone — the local-AI pipeline, the worked-example bank, the scorers, the flags and
 * every measurement written against them. What is left is this dialog and the menu item that would
 * open it, and that item is disabled in `Header.tsx`, so nothing in the running app reaches here.
 *
 * It is kept rather than deleted because the region is still in `docs/featureset.png` and the
 * intent has not been dropped, only the implementation. Whatever replaces the pipeline arrives
 * behind this same door: one dialog, opened from the main menu, handing back a finished model.
 *
 * The old shape is in git. None of the ports it took survive here, because a port with nothing on
 * the other end is a claim about code that does not exist.
 */
export const GenerateDialog = ({onClose}: {onClose: () => void}) => (
    <Dialog
        isOpen
        purpose='form'
        width={420}
        onOpenChange={open => {
            if (!open) onClose()
        }}
    >
        <DialogHeader
            title='Generate a model'
            subtitle='Nothing is behind this yet.'
            onOpenChange={open => {
                if (!open) onClose()
            }}
        />

        <div
            className='generate'
            data-testid='generate-dialog'
        >
            <Text
                type='supporting'
                color='disabled'
            >
                Model generation has been removed. The menu item that opens this is disabled.
            </Text>

            <div className='dialog-actions'>
                <Button
                    label='Close'
                    variant='ghost'
                    size='sm'
                    onClick={onClose}
                />
            </div>
        </div>
    </Dialog>
)
