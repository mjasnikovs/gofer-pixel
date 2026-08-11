import {Button} from '@astryxdesign/core/Button'
import {IconButton} from '@astryxdesign/core/IconButton'
import {Text} from '@astryxdesign/core/Text'
import type {Dispatch} from 'react'
import {canRedo, canUndo} from '../doc/history'
import {countVoxels} from '../vox/vox-file'
import {MoreMenu} from '@astryxdesign/core/MoreMenu'
import {RedoIcon, SunIcon, UndoIcon} from './icons'
import type {AppAction, AppState} from './state'

/**
 * The title bar of `docs/editor.png`: what is open on the left, and the one coloured button in the
 * window on the right.
 *
 * The mockup's Model/Render workspace switch is gone. It moved a flag and changed nothing on screen,
 * because the workspace it named — `FEATURESET.md` §16, the sprite sheet — shipped as
 * `ExportDialog.tsx` instead. A disabled control that names a layout the artist cannot find is worse
 * than no control, and there is no layout left for it to name.
 *
 * Undo and redo are wired to the history and greyed only when their half of it is empty. They were
 * hardcoded disabled with a tooltip saying this build does not edit voxels, which stopped being true
 * the moment the tools landed — `Ctrl+Z` has worked for some time and the button next to it claimed
 * otherwise. A disabled control that lies is worse than no control: it teaches the artist that the
 * feature is missing, and they stop looking for the shortcut that would have worked.
 *
 * The sun is wired too, and the same argument applies: it was disabled with a tooltip handing
 * lighting to the game engine, which is right about a point light and wrong about a directional
 * one. See the comment on the button.
 *
 * Nothing in this row is disabled any more. A Shading button and a Scene options chevron sat right
 * of the sun, drawn from the mockup and wired to nothing. The renderer does have eight modes and the
 * viewport is pinned to colour, so the button had a real meaning available to it — but the export
 * dialog already previews all eight, so the only thing it would have added is orbiting while you
 * look at one. That is not worth a control in the title bar, and a promise nobody is keeping reads
 * as a missing feature rather than a postponed one.
 *
 * A Viewport settings gear was the last of those, and it went for a different reason: not that it
 * promised too much, but that it had nothing left to hold. Grid, edges, snap and invert are switches
 * in the tool rail; the sun is the button beside it; the ring pitch is a badge on the views strip;
 * the map and the preview size are the renders panel, and the viewport follows the first of them;
 * the frame rate is in the timeline. Every one of them already sits next to the thing it changes,
 * which is where a viewport setting belongs. Reopening it here would be a second place to change
 * each, and two controls over one field disagree the first time one of them is missed.
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
    onGenerate,
    onExport
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
    onExport: () => void
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

        <div className='header-group header-end'>
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
            {/*
             * The viewport's sun — `FEATURESET.md` §21. See `render/light.ts`.
             *
             * It was disabled with a tooltip handing lighting to the game engine, and that reading
             * was right: nothing this button does reaches a file. What it turns on is a modelling
             * aid, in the same category as the voxel lattice — the shape reads better under a
             * raking light while you are placing voxels, and the sprite you ship is flat.
             *
             * The tooltip has to say that in both states, because a sun is exactly the control an
             * artist would otherwise assume was baking into their export.
             */}
            <IconButton
                label='Lighting'
                tooltip={
                    state.lighting.on ?
                        'Lighting the viewport only — click for flat faces. No sprite carries it'
                    :   'Light the viewport while you model. Never exported: the game engine does '
                        + 'the lighting, off the normal map — see FEATURESET §21'
                }
                /*
                 * The glyph takes the accent when the sun is on; the button keeps its ghost face.
                 *
                 * Not `variant='primary'`, which fills the whole control — Export is the one filled
                 * button in this window and a second fill four places to its left would argue with
                 * it. Colouring the icon alone says "this one is doing something" in the same accent
                 * every on-state in the app already uses, at a weight that does not compete.
                 *
                 * The colour is on a span of ours *inside* the icon rather than on the button,
                 * because astryx styles its buttons with StyleX and a plain class on the same
                 * element loses to it — measured: the token reads `#a08cf6` in this header and the
                 * button still computed `rgb(197, 189, 243)`. Nothing targets this span but us.
                 */
                icon={
                    <span className={state.lighting.on ? 'lit-glyph' : undefined}>
                        <SunIcon />
                    </span>
                }
                size='sm'
                variant='ghost'
                aria-pressed={state.lighting.on}
                onClick={() => {
                    dispatch({type: 'lighting', lighting: {on: !state.lighting.on}})
                }}
            />
            {/*
             * Opens the export dialog rather than writing straight to disk.
             *
             * It used to bake and download on the click, which is `FEATURESET.md` §38's literal one
             * button — and the button wrote whatever the rail's preset happened to say, with no way
             * to see it first. §16 asks to "preview the actual PNG before exporting", and eight
             * maps of preview do not fit in a 384 px rail. One click to look, one to ship.
             */}
            <Button
                label='Export'
                tooltip='Preview every map and write the sprite sheet'
                variant='primary'
                size='sm'
                onClick={onExport}
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
