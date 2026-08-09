import {Button} from '@astryxdesign/core/Button'
import {IconButton} from '@astryxdesign/core/IconButton'
import {MoreMenu} from '@astryxdesign/core/MoreMenu'
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl'
import {Selector} from '@astryxdesign/core/Selector'
import {Switch} from '@astryxdesign/core/Switch'
import {Text} from '@astryxdesign/core/Text'
import type {Dispatch} from 'react'
import {SHEET_MAPS, type Sheet, type SheetMap} from '../sheet/sheet'
import type {Volume} from '../render/volume'
import {writeSheetMap} from './download'
import {writeSheetMetadata, writeSprites} from './export'
import {GearIcon} from './icons'
import {SectionHead} from './SectionHead'
import {Thumbnail} from './Thumbnail'
import {allPresets, presetMaps, type AppAction, type AppState} from './state'
/** A texel each side is what stops a sampler bleeding one sprite into the next; four is generous. */
const PADDINGS = [0, 1, 2, 4] as const

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

/**
 * The export half of `docs/editor.png`: a preset, the sprites that preset would write, and the one
 * button that writes them.
 *
 * The grid is not a picture of the sheet — it is the sheet's cells, each rendered by the same CPU
 * raycaster that packs them, so what is on screen is what lands in the PNG. The checkerboard behind
 * it is not decoration either: a sprite sheet is mostly transparent, and on a flat panel there is
 * no way to tell an empty pixel from one the model happens to have painted panel-coloured.
 *
 * Only the first preset is wired to anything and the selector says so. A preset is a named set of
 * export choices (`docs/FEATURESET.md` §38) and the choices it would name — individual PNGs,
 * metadata JSON, an engine's folder layout — are not built.
 */
const CELL_SIZES = [32, 64, 128]

export const ExportPanel = ({
    state,
    dispatch,
    volume,
    sheet
}: {
    state: AppState
    dispatch: Dispatch<AppAction>
    /**
     * The grid with hidden objects taken out of it, memoised in `App.tsx`.
     *
     * A prop rather than `state.volume`, and it is the reason panels do not simply take the state
     * and read everything off it: this is a *derivation*, and recomputing it here would rebuild a
     * whole grid on every render of a panel that is mostly switches.
     */
    volume: Volume
    /** The last bake if it is still this document's — derived in `App.tsx`; see `sheet/baked.ts`. */
    sheet: Sheet | undefined
}) => {
    const {cameras} = state
    const {cell, preset, padding, bounds} = state.output
    return (
        <section className='section section-grows'>
            <SectionHead title='Export preset'>
                {/* Astryx's controls take no `title`, so the hover text hangs off a wrapper. */}
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
            </SectionHead>

            <div className='export-body'>
                <div className='field-row'>
                    <span
                        className='grows'
                        title='Which set of maps an export writes'
                    >
                        <Selector
                            label='Export preset'
                            isLabelHidden
                            size='sm'
                            width='100%'
                            value={preset}
                            options={allPresets(state).map(entry => ({
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
                        tooltip='Save the maps this preset writes under a new name'
                        icon={<GearIcon />}
                        size='sm'
                        variant='ghost'
                        onClick={() => {
                            const chosen = globalThis.prompt('Name this preset')
                            if (chosen === null) return
                            dispatch({
                                type: 'save-preset',
                                name: chosen,
                                maps: presetMaps(state, preset)
                            })
                        }}
                    />
                </div>

                {/*
                 * Padding and collision bounds — `FEATURESET.md` §16 and §37. Padding is in the same
                 * row as the switch that decides whether the JSON carries a box, because the two are
                 * the whole of "what shape does the engine get" and neither needs a section.
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
                    <span title='Write each sprite’s collision box into the metadata JSON'>
                        <Switch
                            label='Box'
                            size='sm'
                            labelPosition='start'
                            value={bounds}
                            onChange={on => {
                                dispatch({type: 'output', output: {bounds: on}})
                            }}
                        />
                    </span>
                </div>

                <div className='checker export-grid'>
                    {cameras.map(entry => (
                        <Thumbnail
                            key={entry.id}
                            volume={volume}
                            camera={entry.camera}
                            size={cell}
                            className='export-sprite'
                        />
                    ))}
                </div>

                <Text
                    type='supporting'
                    color='disabled'
                >
                    {sheet ?
                        `Written: ${String(sheet.width)} × ${String(sheet.height)}, `
                        + `${String(sheet.columns)} across`
                    :   `${String(cameras.length)} sprites at ${String(cell)} px`}
                </Text>
            </div>

            <div className='export-foot'>
                <Button
                    label='Export sprite sheet'
                    tooltip='Render every camera and write the PNGs this preset asks for'
                    variant='primary'
                    width='100%'
                    onClick={() => {
                        dispatch({type: 'bake'})
                    }}
                />
                <MoreMenu
                    label='More export options'
                    size='md'
                    items={[
                        ...SHEET_MAPS.map((map: SheetMap) => ({
                            label: `Download ${MAP_LABELS[map]} sheet only`,
                            // A map the preset did not ask for was never baked, so there is no file to
                            // write; the menu says so rather than quietly doing nothing.
                            isDisabled: !sheet?.maps[map],
                            onClick: () => {
                                if (sheet) void writeSheetMap(sheet, map)
                            }
                        })),
                        {type: 'divider'},
                        {
                            label: 'Download every sprite separately',
                            isDisabled: !sheet,
                            onClick: () => {
                                void writeSprites(state)
                            }
                        },
                        {
                            label: 'Download metadata JSON',
                            isDisabled: !sheet,
                            onClick: () => {
                                writeSheetMetadata(state)
                            }
                        }
                    ]}
                />
            </div>
        </section>
    )
}
