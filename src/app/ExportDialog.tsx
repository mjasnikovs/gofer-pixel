import {Button} from '@astryxdesign/core/Button'
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {IconButton} from '@astryxdesign/core/IconButton'
import {MoreMenu} from '@astryxdesign/core/MoreMenu'
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl'
import {Selector} from '@astryxdesign/core/Selector'
import {Switch} from '@astryxdesign/core/Switch'
import {Text} from '@astryxdesign/core/Text'
import {useMemo, useState, type Dispatch} from 'react'
import type {Files} from '../doc/files'
import {reseeded, seeded, shipped, toggled} from '../sheet/choice'
import {emptyMaps} from '../sheet/empty'
import {allPresets} from '../sheet/presets'
import {cutCell, renderSheet, SHEET_MAPS, type SheetMap} from '../sheet/sheet'
import type {Volume} from '../render/volume'
import {writeSheetMap} from './download'
import {writeExportPack, writeLoose, writeSheetMetadata, writeSprites} from './export'
import {GearIcon} from './icons'
import {PixelCanvas, type Pixels} from './PixelCanvas'
import type {AppAction, AppState} from './state'

/**
 * Export, as a dialog — the whole of `FEATURESET.md` §16, §17, §37 and §38 behind the one coloured
 * button in the header.
 *
 * It used to be the third section of the right-hand rail, on screen for every stroke of every
 * session. That is a lot of window spent on a control an artist reaches for at the end, and the
 * space it wanted — a preview of eight maps, big enough to see a normal from a height — was space
 * a rail does not have. §39 is explicit about this: the app should not advertise how powerful it is
 * by covering the screen in buttons.
 *
 * **The preview is the export.** Every cell on screen is `cutCell` out of the sheet the buttons
 * write, so what the artist looks at is the file's own bytes at the offset the metadata JSON
 * records. Nothing here re-renders anything for display — `app/sprite-cache.ts` exists for the
 * viewport, covers five of the eight maps, and its depth is a *view* mode that is deliberately not
 * what gets exported. Using it here would have made the preview disagree with the download for
 * three maps out of eight, silently, in the one place whose job is to show what lands on disk.
 */

const MAP_LABELS: Record<SheetMap, string> = {
    color: 'colour',
    normal: 'normal',
    depth: 'depth',
    height: 'height',
    ao: 'occlusion',
    emission: 'emission',
    index: 'palette index',
    object: 'object id'
}

/** What a map is *for*, since the difference between depth and height is a convention, not a look. */
const MAP_NOTES: Record<SheetMap, string> = {
    color: 'The sprite itself. Always written.',
    normal: 'Surface direction, for an engine that lights the sprite.',
    depth: 'Distance from the camera. White is near.',
    height: 'The same measurement the other way round. White is far.',
    ao: 'Creases and contact shadows, baked from the geometry.',
    emission: 'What glows, from the palette’s emissive column.',
    index: 'The palette index in the red channel, for indexed-colour pipelines.',
    object: 'Which object owns each pixel, in the red channel.'
}

/** Why a map is greyed out. Both reasons are facts about this model, not settings. */
const EMPTY_NOTES: Partial<Record<SheetMap, string>> = {
    emission: 'Nothing in this model glows, so this map would be black.',
    object: 'This model is one object, so this map would be one flat value.'
}

/** A texel each side is what stops a sampler bleeding one sprite into the next; four is generous. */
const PADDINGS = [0, 1, 2, 4] as const

const CELL_SIZES = [32, 64, 128]

export const ExportDialog = ({
    state,
    dispatch,
    volume,
    files,
    onClose
}: {
    state: AppState
    dispatch: Dispatch<AppAction>
    /**
     * The grid as the artist sees it — hidden objects emptied out, sliced if slice mode is on.
     *
     * Memoised in `App.tsx`. A prop rather than `state.volume` for the reason every derivation is
     * one: rebuilding it here would rebuild a whole grid, and the bake below is keyed on its
     * identity.
     */
    volume: Volume
    /** The disk the buttons write to — see `doc/files.ts`. A port, so a test can read the bytes. */
    files: Files
    onClose: () => void
}) => {
    const {cameras} = state
    const {cell, preset, padding, bounds} = state.output

    /*
     * The sheet, rebaked whenever anything it is made of moves.
     *
     * All eight maps, always, whatever the preset asks for — the point of a tab per map is to be
     * able to look at emission *before* deciding to ship it. They all come off one ray, so the
     * eighth map costs a buffer and no extra raycasting; at 128 px and eight cameras that is 4 MB
     * for as long as the dialog is open.
     *
     * This is also what killed `sheet/baked.ts`. A bake used to outlive the click that made it, so
     * "is that still the sheet for this document?" needed a key of seven identities and a
     * comparison, and twenty-four reducer cases had to remember not to break it. A dialog that
     * rebakes on every input it can see cannot show a stale sheet, and a `useMemo` dependency list
     * *is* that key — with the compiler checking it instead of a convention.
     */
    const sheet = useMemo(
        () => renderSheet(volume, cameras, cell, SHEET_MAPS, padding),
        [volume, cameras, cell, padding]
    )

    /** Which of the eight would be written blank, asked of the sheet itself — see `sheet/empty.ts`. */
    const empty = useMemo(() => emptyMaps(sheet), [sheet])

    /** Which map the grid is showing. Not a tick: looking at a map and shipping it are separate. */
    const [shown, setShown] = useState<SheetMap>('color')

    /*
     * The ticks, seeded from the selected preset — see `sheet/choice.ts`.
     *
     * Reseeded during render rather than from an effect, which is React's own answer to state that
     * follows a prop: an effect would paint one frame of the previous preset's ticks before
     * correcting itself, and the artist would see the boxes move after the selector had already
     * closed.
     */
    const [held, setHeld] = useState(() => seeded(state.output))
    const choice = reseeded(held, state.output)
    if (choice !== held) setHeld(choice)

    /** What actually gets written: the ticks minus anything this sheet would write blank. */
    const maps = shipped(choice, empty)

    /*
     * One cut per camera of the map on screen, behind a closure — see `PixelCanvas`.
     *
     * Memoised together so the buffers keep their identity across a re-render. A fresh closure per
     * render would re-run every canvas's effect and redraw the whole grid on a hover.
     */
    const cells = useMemo(
        (): readonly Pixels[] =>
            cameras.map((_, index) => {
                const cut = cutCell(sheet, shown, index) ?? new Uint8Array(0)
                return () => cut
            }),
        [sheet, shown, cameras]
    )

    const row = (map: SheetMap) => {
        const label = MAP_LABELS[map]
        const blank = empty.has(map)
        return (
            <div
                key={map}
                className='export-map'
                data-map={map}
                data-on={map === shown || undefined}
            >
                <button
                    type='button'
                    className='export-map-pick'
                    aria-label={`Preview the ${label} map`}
                    aria-pressed={map === shown}
                    title={blank ? EMPTY_NOTES[map] : MAP_NOTES[map]}
                    onClick={() => {
                        setShown(map)
                    }}
                >
                    <span className='export-map-name'>{label}</span>
                    {blank && (
                        <Text
                            type='supporting'
                            color='disabled'
                        >
                            empty
                        </Text>
                    )}
                </button>
                <CheckboxInput
                    label={`Write the ${label} map`}
                    isLabelHidden
                    size='sm'
                    value={choice.maps.includes(map) && !blank}
                    isDisabled={map === 'color' || blank}
                    disabledMessage={
                        map === 'color' ?
                            'Every sprite sheet has a colour map'
                        :   (EMPTY_NOTES[map] ?? '')
                    }
                    onChange={on => {
                        setHeld(toggled(choice, map, on))
                    }}
                />
            </div>
        )
    }

    return (
        <Dialog
            isOpen
            purpose='form'
            width={880}
            onOpenChange={open => {
                if (!open) onClose()
            }}
        >
            <DialogHeader
                title='Export'
                subtitle='Every cell below is cut out of the sheet these buttons write.'
                onOpenChange={open => {
                    if (!open) onClose()
                }}
            />

            <div className='export-dialog'>
                <div className='export-settings'>
                    <div className='field-row'>
                        <span
                            className='grows'
                            title='Which set of maps an export writes'
                        >
                            <Selector
                                label='Export preset'
                                size='sm'
                                width='100%'
                                value={preset}
                                options={allPresets(state.output).map(entry => ({
                                    value: entry.name,
                                    label: entry.name
                                }))}
                                onChange={chosen => {
                                    dispatch({type: 'output', output: {preset: chosen}})
                                }}
                            />
                        </span>
                        <IconButton
                            label='Save these maps as a preset'
                            tooltip='Save the ticked maps under a new name'
                            icon={<GearIcon />}
                            size='sm'
                            variant='ghost'
                            onClick={() => {
                                const named = globalThis.prompt('Name this preset')
                                if (named === null) return
                                // The ticks, not the sheet's blanks: a preset is a set of choices
                                // and travels to models that do have something glowing in them.
                                dispatch({type: 'save-preset', name: named, maps: choice.maps})
                            }}
                        />
                    </div>

                    <span title='Edge of one sprite in the sheet, in pixels'>
                        <SegmentedControl
                            label='Sprite size'
                            size='sm'
                            value={String(cell)}
                            onChange={value => {
                                dispatch({type: 'output', output: {cell: Number(value)}})
                            }}
                        >
                            {CELL_SIZES.map(size => (
                                <SegmentedControlItem
                                    key={size}
                                    value={String(size)}
                                    label={`${String(size)} px`}
                                />
                            ))}
                        </SegmentedControl>
                    </span>

                    {/*
                     * Padding and collision bounds — `FEATURESET.md` §16 and §37. The two together
                     * are the whole of "what shape does the engine get", so they share a row.
                     */}
                    <div className='field-row'>
                        <Text
                            type='supporting'
                            color='disabled'
                        >
                            Padding
                        </Text>
                        <span className='spacer' />
                        <span
                            className='symmetry-row'
                            role='radiogroup'
                            aria-label='Padding between sprites'
                        >
                            {PADDINGS.map(size => (
                                <button
                                    key={size}
                                    type='button'
                                    role='radio'
                                    aria-checked={size === padding}
                                    aria-label={`${String(size)} pixels of padding`}
                                    title={
                                        size === 0 ?
                                            'Pack the sprites edge to edge'
                                        :   `Leave ${String(size)} transparent pixels around each sprite`
                                    }
                                    className='symmetry-axis'
                                    data-on={size === padding || undefined}
                                    onClick={() => {
                                        dispatch({type: 'output', output: {padding: size}})
                                    }}
                                >
                                    {size}
                                </button>
                            ))}
                        </span>
                    </div>

                    <span title='Write each sprite’s collision box into the metadata JSON'>
                        <Switch
                            label='Collision box in the JSON'
                            size='sm'
                            labelPosition='start'
                            value={bounds}
                            onChange={on => {
                                dispatch({type: 'output', output: {bounds: on}})
                            }}
                        />
                    </span>

                    <div
                        className='export-maps'
                        role='group'
                        aria-label='Maps to write'
                    >
                        {SHEET_MAPS.map(row)}
                    </div>
                </div>

                <div className='export-preview'>
                    {/*
                     * The checkerboard is not decoration: a sprite sheet is mostly transparent, and
                     * on a flat panel there is no telling an empty pixel from one the model happens
                     * to have painted panel-coloured.
                     */}
                    <div className='checker export-grid'>
                        {cameras.map((entry, index) => (
                            <PixelCanvas
                                key={entry.id}
                                width={cell}
                                height={cell}
                                data={cells[index] ?? (() => new Uint8Array(0))}
                                title={entry.name}
                                className='export-sprite'
                            />
                        ))}
                    </div>
                    <Text
                        type='supporting'
                        color='disabled'
                    >
                        {`${MAP_LABELS[shown]} · ${String(sheet.width)} × ${String(sheet.height)}, `
                            + `${String(sheet.columns)} across · ${String(maps.length)} `
                            + `${maps.length === 1 ? 'map' : 'maps'} and the JSON`}
                    </Text>
                </div>
            </div>

            <div className='export-foot'>
                <MoreMenu
                    label='More export options'
                    size='md'
                    items={[
                        {
                            label: 'Download the maps as loose PNGs',
                            onClick: () => {
                                void writeLoose(files, sheet, maps)
                            }
                        },
                        {
                            label: 'Download every sprite separately',
                            onClick: () => {
                                void writeSprites(files, state, sheet)
                            }
                        },
                        {
                            label: 'Download metadata JSON',
                            onClick: () => {
                                void writeSheetMetadata(files, state, sheet)
                            }
                        },
                        {type: 'divider'},
                        ...SHEET_MAPS.map((map: SheetMap) => ({
                            label: `Download ${MAP_LABELS[map]} sheet only`,
                            // A map that would be blank has no file worth writing; the menu says so
                            // rather than quietly handing over a black PNG.
                            isDisabled: empty.has(map),
                            onClick: () => {
                                void writeSheetMap(files, sheet, map)
                            }
                        }))
                    ]}
                />
                <span className='spacer' />
                <Button
                    label='Close'
                    variant='ghost'
                    size='md'
                    onClick={onClose}
                />
                <Button
                    label='Export pack'
                    tooltip='One .zip: the ticked maps and the metadata JSON'
                    variant='primary'
                    size='md'
                    onClick={() => {
                        void writeExportPack(files, state, sheet, maps)
                    }}
                />
            </div>
        </Dialog>
    )
}
