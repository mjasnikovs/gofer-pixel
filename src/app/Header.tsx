import {Button} from '@astryxdesign/core/Button'
import {IconButton} from '@astryxdesign/core/IconButton'
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl'
import {Text} from '@astryxdesign/core/Text'
import type {Dispatch} from 'react'
import {canRedo, canUndo} from '../doc/history'
import {countVoxels} from '../vox/vox-file'
import {MoreMenu} from '@astryxdesign/core/MoreMenu'
import {ChevronIcon, CubeIcon, RedoIcon, SlidersIcon, SunIcon, UndoIcon} from './icons'
import type {AppAction, AppState} from './state'

/**
 * The title bar of `docs/editor.png`: what is open on the left, which workspace on the centre line,
 * and the one coloured button in the window on the right.
 *
 * Undo and redo are wired to the history and greyed only when their half of it is empty. They were
 * hardcoded disabled with a tooltip saying this build does not edit voxels, which stopped being true
 * the moment the tools landed — `Ctrl+Z` has worked for some time and the button next to it claimed
 * otherwise. A disabled control that lies is worse than no control: it teaches the artist that the
 * feature is missing, and they stop looking for the shortcut that would have worked.
 *
 * The rest of this row genuinely does nothing yet and stays disabled, each saying so in its own
 * tooltip. A greyed button that names what it would do is a promise; an enabled one that swallows
 * the click is a bug report.
 */
/**
 * Restore-point labels, guaranteed distinct.
 *
 * Astryx derives a menu item's React key from its label (`renderDropdownItems.tsx`), and autosave
 * fires on every committed edit — so two strokes inside one second produce two snapshots a second
 * apart, one label, and a duplicate-key warning in the console. Rendering a *date* as well as a time
 * is worth having anyway once snapshots span sessions; the counter is what settles the remaining
 * same-second case, and it only appears when there is something to settle.
 */
const restoreLabels = (
    restores: readonly {key: string; at: number; name: string}[]
): readonly {key: string; label: string}[] => {
    const seen = new Map<string, number>()
    return restores.map(entry => {
        const when = new Date(entry.at)
        const base = `Restore ${entry.name} · ${when.toLocaleDateString()} ${when.toLocaleTimeString()}`
        const count = seen.get(base) ?? 0
        seen.set(base, count + 1)
        return {key: entry.key, label: count === 0 ? base : `${base} (${String(count + 1)})`}
    })
}

/**
 * What the header says about the file — the mockup's `Knight • Unsaved`.
 *
 * Three states rather than two, because "never written" and "written, then changed" are different
 * amounts of trouble to be in and the artist should be able to tell them apart at a glance.
 */
const savedLabel = ({dirty, savedAt}: AppState['doc']): string => {
    if (dirty) return 'Unsaved changes'
    if (savedAt === undefined) return 'Not saved'
    return `Saved ${new Date(savedAt).toLocaleTimeString()}`
}

export const Header = ({
    state,
    dispatch,
    restores,
    onRestore,
    onForget,
    overwrites,
    onNew,
    onOpen,
    onSave,
    onSaveAs,
    onGenerate
}: {
    state: AppState
    dispatch: Dispatch<AppAction>
    restores: readonly {key: string; at: number; name: string}[]
    /*
     * The seven callbacks below are what is left after the dispatches moved in here, and they are
     * exactly the ones that are not dispatches: every one goes through a port the app owns — the
     * disk or the autosave store — and may be cancelled. See `app/session.ts`.
     */
    onRestore: (key: string) => void
    onForget: () => void
    /** Whether Save can write back over the open file — see `doc/files.ts`. */
    overwrites: boolean
    onNew: () => void
    onOpen: () => void
    onSave: () => void
    onSaveAs: () => void
    onGenerate: () => void
}) => (
    <header className='app-header'>
        <div className='header-group'>
            <span className='app-mark' />
            <Text weight='semibold'>gofer-pixel</Text>
            <span className='app-divider' />
            <Text type='supporting'>{state.doc.name}</Text>
            <Text
                type='supporting'
                color='disabled'
            >
                · {state.volume.sx} × {state.volume.sy} × {state.volume.sz} ·{' '}
                {countVoxels(state.volume)} voxels · {savedLabel(state.doc)}
            </Text>
        </div>

        {/*
         * The mockup's two workspaces. Switching them moved a flag in the state and changed nothing
         * on screen, because there is no second layout to switch to — the render controls live in
         * the rail on the right and are visible in both. So it is disabled rather than left working:
         * a control that responds by highlighting itself and doing nothing is the most expensive
         * kind of dead, because the artist assumes the layout they wanted is one they cannot find.
         */}
        <SegmentedControl
            label='Workspace'
            value={state.workspace}
            isDisabled
            disabledMessage='One workspace for now — the render controls are in the right-hand rail'
            onChange={value => {
                dispatch({
                    type: 'chrome',
                    chrome: {workspace: value === 'render' ? 'render' : 'model'}
                })
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
                tooltip={
                    !canUndo(state.history) ? 'Nothing to undo' : 'Undo the last edit — Ctrl+Z'
                }
                icon={<UndoIcon />}
                size='sm'
                variant='ghost'
                isDisabled={!canUndo(state.history)}
                onClick={() => {
                    dispatch({type: 'undo'})
                }}
            />
            <IconButton
                label='Redo'
                tooltip={
                    !canRedo(state.history) ? 'Nothing to redo' : (
                        'Redo the last undone edit — Ctrl+Shift+Z'
                    )
                }
                icon={<RedoIcon />}
                size='sm'
                variant='ghost'
                isDisabled={!canRedo(state.history)}
                onClick={() => {
                    dispatch({type: 'redo'})
                }}
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
                tooltip='Render every camera and write the sprite sheet'
                variant='primary'
                size='sm'
                onClick={() => {
                    dispatch({type: 'bake'})
                }}
            />
            {/*
             * The file menu, and below it the snapshots — `FEATURESET.md` §32. Restoring is not
             * undo: undo covers the last 512 strokes of this session, and these cover the last few
             * sessions, which is the case undo cannot reach because the browser was closed.
             *
             * Save says what it will actually do. On a browser without the File System Access API
             * it cannot overwrite anything — every save is another file in the downloads folder —
             * and a menu item promising otherwise would be the disabled-control lie this header
             * already argues against, in its worse form: a control that lies while working.
             */}
            <MoreMenu
                label='Main menu'
                size='sm'
                items={[
                    {label: 'New project…', onClick: onNew},
                    {label: 'Open…', onClick: onOpen},
                    {
                        label: overwrites ? 'Save' : 'Save a copy',
                        onClick: onSave
                    },
                    {label: 'Save As…', onClick: onSaveAs},
                    {type: 'divider' as const},
                    /*
                     * Generation lives in the menu rather than on the toolbar, because it is a
                     * thing an artist does once before they start rather than while they draw —
                     * and because a candidate replaces the open document, which is a File-menu
                     * kind of promise, not a tool.
                     */
                    {label: 'Generate a model…', onClick: onGenerate},
                    ...(restores.length > 0 ? [{type: 'divider' as const}] : []),
                    ...restoreLabels(restores).map(entry => ({
                        label: entry.label,
                        onClick: () => {
                            onRestore(entry.key)
                        }
                    })),
                    {type: 'divider' as const},
                    {
                        label: 'Forget every snapshot',
                        isDisabled: restores.length === 0,
                        onClick: onForget
                    }
                ]}
            />
        </div>
    </header>
)
