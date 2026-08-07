import {Button} from '@astryxdesign/core/Button'
import {IconButton} from '@astryxdesign/core/IconButton'
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl'
import {Text} from '@astryxdesign/core/Text'
import {countVoxels} from '../vox/vox-file'
import {ChevronIcon, CubeIcon, MenuIcon, RedoIcon, SlidersIcon, SunIcon, UndoIcon} from './icons'
import type {AppState} from './state'

/**
 * The title bar of `docs/editor.png`: what is open on the left, which workspace on the centre line,
 * and the one coloured button in the window on the right.
 *
 * Undo and redo are drawn disabled rather than left out. The mockup has them, an editor is expected
 * to have them, and a greyed control that says "nothing to undo" is honest in a way that a missing
 * one is not — undo needs edits, and edits are on the proof of concept's do-not-build list.
 */
export const Header = ({
    name,
    state,
    onWorkspace,
    onExport
}: {
    name: string
    state: AppState
    onWorkspace: (workspace: AppState['workspace']) => void
    onExport: () => void
}) => (
    <header className='app-header'>
        <div className='header-group'>
            <span className='app-mark' />
            <Text weight='semibold'>gofer-pixel</Text>
            <span className='app-divider' />
            <Text type='supporting'>{name}</Text>
            <Text
                type='supporting'
                color='disabled'
            >
                · {state.volume.sx} × {state.volume.sy} × {state.volume.sz} ·{' '}
                {countVoxels(state.volume)} voxels · Unsaved
            </Text>
        </div>

        <SegmentedControl
            label='Workspace'
            value={state.workspace}
            onChange={value => {
                onWorkspace(value === 'render' ? 'render' : 'model')
            }}
        >
            <SegmentedControlItem
                value='model'
                label='Model'
            />
            <SegmentedControlItem
                value='render'
                label='Render'
            />
        </SegmentedControl>

        <div className='header-group header-end'>
            <IconButton
                label='Viewport settings'
                tooltip='Viewport settings'
                icon={<SlidersIcon />}
                size='sm'
                variant='ghost'
                isDisabled
            />
            <IconButton
                label='Undo'
                tooltip='Nothing to undo — this build does not edit voxels'
                icon={<UndoIcon />}
                size='sm'
                variant='ghost'
                isDisabled
            />
            <IconButton
                label='Redo'
                tooltip='Nothing to redo — this build does not edit voxels'
                icon={<RedoIcon />}
                size='sm'
                variant='ghost'
                isDisabled
            />
            <span className='app-divider' />
            <IconButton
                label='Lighting'
                tooltip='Lighting is the game engine’s job — see FEATURESET §21'
                icon={<SunIcon />}
                size='sm'
                variant='ghost'
                isDisabled
            />
            <IconButton
                label='Shading'
                tooltip='Shading modes'
                icon={<CubeIcon />}
                size='sm'
                variant='ghost'
                isDisabled
            />
            <IconButton
                label='Scene options'
                tooltip='Scene options'
                icon={<ChevronIcon />}
                size='sm'
                variant='ghost'
                isDisabled
            />
            <Button
                label='Export'
                variant='primary'
                size='sm'
                onClick={onExport}
            />
            <IconButton
                label='Main menu'
                tooltip='Main menu'
                icon={<MenuIcon />}
                size='sm'
                variant='ghost'
                isDisabled
            />
        </div>
    </header>
)
