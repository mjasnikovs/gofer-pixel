import {Button} from '@astryxdesign/core/Button'
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {IconButton} from '@astryxdesign/core/IconButton'
import {MoreMenu} from '@astryxdesign/core/MoreMenu'
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl'
import {Selector} from '@astryxdesign/core/Selector'
import {Switch} from '@astryxdesign/core/Switch'
import {Text} from '@astryxdesign/core/Text'
import {useEffect, useMemo, useRef, useState, type Dispatch} from 'react'
import type {Files} from '../doc/files'
import {shownVolume} from '../doc/objects'
import {reseeded, seeded, shipped, toggled} from '../sheet/choice'
import {emptyMaps} from '../sheet/empty'
import {sheetMetadata, type SheetMetadata} from '../sheet/metadata'
import {allPresets} from '../sheet/presets'
import {cutCell, renderSheet, SHEET_MAPS, type SheetMap} from '../sheet/sheet'
import {evenCell, unevenCount} from '../render/perfect'
import type {Volume} from '../render/volume'
import {writeMetadata, writePack, writeSheet, writeSheetMap, writeSprites} from './download'
import {GearIcon} from './icons'
import {PixelCanvas, type Pixels} from './PixelCanvas'
import {previewScale, wholeRows} from './preview'
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
    const {cell, cellH, preset, padding, bounds} = state.output

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
        () => renderSheet(volume, cameras, {cellW: cell, cellH}, SHEET_MAPS, padding),
        [volume, cameras, cell, cellH, padding]
    )

    /** Which of the eight would be written blank, asked of the sheet itself — see `sheet/empty.ts`. */
    const empty = useMemo(() => emptyMaps(sheet), [sheet])

    /*
     * How much of this sheet would not land on the pixel grid, and whether another sprite size
     * would fix all of it — see `render/perfect.ts`. Asked of the cameras rather than the sheet,
     * because it is a question about the projection and the sheet is downstream of the answer.
     */
    const angles = useMemo(() => cameras.map(entry => entry.camera), [cameras])
    // The height, not the width: the scale comes off `cellH` alone, so a wider cell can neither
    // break the grid nor mend it.
    const uneven = useMemo(() => unevenCount(angles, volume, cellH), [angles, volume, cellH])
    const evenAt = useMemo(
        () => (uneven === 0 ? undefined : evenCell(angles, volume, cellH, CELL_SIZES)),
        [uneven, angles, volume, cellH]
    )

    /** Which map the grid is showing. Not a tick: looking at a map and shipping it are separate. */
    const [shown, setShown] = useState<SheetMap>('color')

    /*
     * How wide the preview grid actually is, so a sprite can be drawn at a whole multiple of its
     * own pixels — see `previewScale`. Measured rather than assumed: the column is `1fr` of a
     * dialog whose padding belongs to astryx, and hard-coding a number here would be a second
     * opinion about the layout that goes stale the first time the dialog is resized.
     *
     * `0` until the observer has spoken, which is also what a unit test sees — happy-dom has no
     * `ResizeObserver`, and the same guard is in `Viewport.tsx` for the same reason. Scale 1 is the
     * honest fallback: never a fractional one.
     */
    const gridRef = useRef<HTMLDivElement>(null)
    const [room, setRoom] = useState(0)
    useEffect(() => {
        const host = gridRef.current
        if (!host || typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(([entry]) => {
            const box = entry?.contentRect
            if (box) setRoom(box.width)
        })
        observer.observe(host)
        return () => {
            observer.disconnect()
        }
    }, [])
    const scale = room === 0 ? 1 : previewScale(room, cell)

    /*
     * The map list, cut to a whole number of rows — see `wholeRows`. Same measure-then-snap as the
     * preview above it, and for the same reason: a row sliced through the middle is a rendering
     * fault as far as an artist is concerned, not an invitation to scroll.
     *
     * Measured **uncapped**, and that is the whole difficulty. Astryx's dialog is `max-height`, not
     * `height`, so it is sized by its content: capping the list shrinks the dialog, which shrinks
     * the room the list was measured against, which lowers the cap again. Measured, every version
     * that reads the capped layout walks down to a single row — the list itself, its column minus
     * its siblings, and an absolutely-positioned slot all did.
     *
     * So the cap comes off before the tape measure goes on. Reading `clientHeight` forces the
     * layout, so what comes back is the room the list has when it is free to ask for all of it —
     * a number the cap cannot move. It is redone on a window resize and nowhere else: a
     * `ResizeObserver` would see the cap it had just applied and fire again forever.
     *
     * The list stays in normal flow, which is not incidental. An absolutely-positioned list was
     * tried and is worse in a way that looks like a fix: out-of-flow content adds nothing to the
     * dialog's height, so the dialog never grew for it and the room stayed at 24 px at every window
     * size. The measurement only means anything while the list is something the dialog can see.
     */
    const mapsRef = useRef<HTMLDivElement>(null)
    const [listTall, setListTall] = useState<number>()
    useEffect(() => {
        const measure = (): void => {
            const list = mapsRef.current
            if (!list) return
            list.style.maxHeight = ''
            // Where each row ends, cumulative. The rules between rows are part of a row's own
            // height, so the running total is exactly the set of places a cut would not show.
            let run = 0
            const edges = [...list.children].map(kid => {
                run += kid instanceof HTMLElement ? kid.offsetHeight : 0
                return run
            })
            // No layout at all — happy-dom, and the first paint. Capping on a zero would hide it.
            if (run <= 0) return
            /*
             * The rows are content and `max-height` is border-box here, so the box's own border has
             * to go back on. Without it the cap is two pixels short of the row it was aimed at and
             * the last one is clipped by exactly that — which is the defect, at a smaller size.
             */
            const chrome = list.offsetHeight - list.clientHeight
            setListTall(wholeRows(list.clientHeight, edges) + chrome)
        }
        measure()
        globalThis.addEventListener('resize', measure)
        return () => {
            globalThis.removeEventListener('resize', measure)
        }
    }, [])

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
     * The JSON an engine reads next to the sheet — `FEATURESET.md` §37.
     *
     * `shownVolume(state.volume, …)` and deliberately not the `volume` prop, which is sliced — the
     * one place in the app that measures something other than the grid as the artist sees it. The
     * bake itself honours slice mode, so a sheet baked in slice mode has boxes described from a
     * fuller model than the pixels came from. Left as it was: changing it changes exported files,
     * which is a decision about the format rather than about where this code lives. It is an opt-out
     * from `doc/gesture.ts`'s derivation, not a second spelling of it.
     *
     * Called from the two menu items that need it rather than memoised, because `shownVolume` walks
     * the whole grid and no render of this dialog reads the answer.
     */
    const metadata = (): SheetMetadata =>
        sheetMetadata(shownVolume(state.volume, state.objects), cameras, sheet, bounds)

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
                                dispatch({
                                    type: 'preset',
                                    op: {kind: 'save', name: named, maps: choice.maps}
                                })
                            }}
                        />
                    </div>

                    {/*
                     * What the sprite size costs, said before the download rather than after.
                     *
                     * A sheet whose cell does not divide by a camera's zoom exports voxels of two
                     * different widths — `3 2 2 2 2 2 2 2 3` for the camera a 16³ document opens
                     * on — and every part of this dialog was happy to write it silently. It is a
                     * note and not a block: `FEATURESET.md` wants pixel-perfectness to be the
                     * engine's constraint, but an artist who wants a 64 px sheet of an isometric
                     * ring is not wrong, and no sprite size exists that would grant it.
                     */}
                    {uneven > 0 && (
                        <div
                            className='field-row export-uneven'
                            role='status'
                        >
                            <Text
                                type='supporting'
                                color='secondary'
                            >
                                {uneven === cameras.length ?
                                    `A voxel is not a whole number of pixels at ${String(cellH)} px tall, so the sprites staircase unevenly.`
                                :   `${String(uneven)} of ${String(cameras.length)} cameras staircase unevenly at ${String(cellH)} px tall.`
                                }
                            </Text>
                            {evenAt !== undefined && (
                                <button
                                    type='button'
                                    className='symmetry-axis'
                                    title={`Every camera lands on whole pixels at ${String(evenAt)} px tall`}
                                    onClick={() => {
                                        dispatch({type: 'output', output: {cellH: evenAt}})
                                    }}
                                >
                                    {`Use ${String(evenAt)} px tall`}
                                </button>
                            )}
                        </div>
                    )}

                    {/*
                     * Two controls, because a sprite cell is not required to be square. A character
                     * taller than it is wide used to be packed into a square and given air on both
                     * sides for it, and that air is texture an engine pays for in every atlas.
                     *
                     * They are not symmetrical questions and the tooltips say so. The height is
                     * what sets the scale — `basisFor` derives voxels-per-pixel from it alone — so
                     * it is the one that decides how big the model is and whether it lands on the
                     * grid. The width only says how far the frame reaches either side of the pivot.
                     */}
                    {(
                        [
                            {
                                label: 'Height',
                                value: cellH,
                                name: 'Sprite height',
                                hint: 'How tall one sprite is. This is what sets the scale of the model.',
                                set: (size: number): AppAction => ({
                                    type: 'output',
                                    output: {cellH: size}
                                })
                            },
                            {
                                label: 'Width',
                                value: cell,
                                name: 'Sprite width',
                                hint: 'How wide one sprite is. Wider is more room either side, not a bigger model.',
                                set: (size: number): AppAction => ({
                                    type: 'output',
                                    output: {cell: size}
                                })
                            }
                        ] as const
                    ).map(axis => (
                        <div
                            key={axis.label}
                            className='field-row'
                            title={axis.hint}
                        >
                            <Text
                                type='supporting'
                                color='disabled'
                            >
                                {axis.label}
                            </Text>
                            <span className='spacer' />
                            <SegmentedControl
                                label={axis.name}
                                size='sm'
                                value={String(axis.value)}
                                onChange={value => {
                                    dispatch(axis.set(Number(value)))
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
                        </div>
                    ))}

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
                        ref={mapsRef}
                        style={listTall === undefined ? undefined : {maxHeight: listTall}}
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
                    <div
                        className='checker export-grid'
                        ref={gridRef}
                    >
                        {cameras.map((entry, index) => (
                            <PixelCanvas
                                key={entry.id}
                                width={cell}
                                height={cellH}
                                data={cells[index] ?? (() => new Uint8Array(0))}
                                title={entry.name}
                                className='export-sprite'
                                style={{width: cell * scale, height: cellH * scale}}
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
                                void writeSheet(files, sheet, maps)
                            }
                        },
                        {
                            label: 'Download every sprite separately',
                            onClick: () => {
                                void writeSprites(
                                    files,
                                    sheet,
                                    cameras.map(entry => entry.name)
                                )
                            }
                        },
                        {
                            label: 'Download metadata JSON',
                            onClick: () => {
                                void writeMetadata(files, metadata())
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
                        void writePack(files, sheet, maps, metadata(), state.doc.name)
                    }}
                />
            </div>
        </Dialog>
    )
}
