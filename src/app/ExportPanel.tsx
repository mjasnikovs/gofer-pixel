import {Button} from '@astryxdesign/core/Button'
import {IconButton} from '@astryxdesign/core/IconButton'
import {MoreMenu} from '@astryxdesign/core/MoreMenu'
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl'
import {Selector} from '@astryxdesign/core/Selector'
import {Text} from '@astryxdesign/core/Text'
import type {NamedCamera} from '../doc/cameras'
import {SHEET_MAPS, type Sheet, type SheetMap} from '../sheet/sheet'
import type {Volume} from '../render/volume'
import {writeSheetMap} from './download'
import {GearIcon} from './icons'
import {SectionHead} from './SectionHead'
import {Thumbnail} from './Thumbnail'
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
    volume,
    cameras,
    cell,
    sheet,
    preset,
    presets,
    padding,
    bounds,
    onPreset,
    onCell,
    onExport,
    onPadding,
    onBounds,
    onSprites,
    onMetadata,
    onSavePreset
}: {
    volume: Volume
    cameras: readonly NamedCamera[]
    cell: number
    sheet: Sheet | undefined
    preset: string
    presets: readonly {name: string; maps: readonly SheetMap[]}[]
    padding: number
    bounds: boolean
    onPreset: (preset: string) => void
    onCell: (cell: number) => void
    onExport: () => void
    onPadding: (padding: number) => void
    onBounds: (on: boolean) => void
    onSprites: () => void
    onMetadata: () => void
    onSavePreset: () => void
}) => (
    <section className='section section-grows'>
        <SectionHead title='Export preset'>
            <SegmentedControl
                label='Sprite size'
                size='sm'
                value={String(cell)}
                onChange={value => {
                    onCell(Number(value))
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
        </SectionHead>

        <div className='export-body'>
            <div className='field-row'>
                <Selector
                    label='Export preset'
                    isLabelHidden
                    size='sm'
                    width='100%'
                    value={preset}
                    options={presets.map(entry => ({value: entry.name, label: entry.name}))}
                    onChange={onPreset}
                />
                <IconButton
                    label='Save these maps as a preset'
                    tooltip='Save the maps this preset writes under a new name'
                    icon={<GearIcon />}
                    size='sm'
                    variant='ghost'
                    onClick={onSavePreset}
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
                            className='symmetry-axis'
                            data-on={size === padding || undefined}
                            onClick={() => {
                                onPadding(size)
                            }}
                        >
                            {size}
                        </button>
                    ))}
                </span>
                <button
                    type='button'
                    role='switch'
                    aria-checked={bounds}
                    aria-label='Write collision bounds into the metadata'
                    className='symmetry-axis'
                    data-on={bounds || undefined}
                    onClick={() => {
                        onBounds(!bounds)
                    }}
                >
                    BOX
                </button>
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
                variant='primary'
                width='100%'
                onClick={onExport}
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
                        onClick: onSprites
                    },
                    {label: 'Download metadata JSON', isDisabled: !sheet, onClick: onMetadata}
                ]}
            />
        </div>
    </section>
)
