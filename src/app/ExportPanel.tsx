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
import {PRESETS} from './state'

const MAP_LABELS: Record<SheetMap, string> = {
    color: 'colour',
    normal: 'normal',
    depth: 'depth',
    height: 'height',
    ao: 'occlusion',
    emission: 'emission'
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
    onPreset,
    onCell,
    onExport
}: {
    volume: Volume
    cameras: readonly NamedCamera[]
    cell: number
    sheet: Sheet | undefined
    preset: string
    onPreset: (preset: string) => void
    onCell: (cell: number) => void
    onExport: () => void
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
                    options={PRESETS.map(entry => ({value: entry.name, label: entry.name}))}
                    onChange={onPreset}
                />
                <IconButton
                    label='Preset settings'
                    tooltip='Preset settings'
                    icon={<GearIcon />}
                    size='sm'
                    variant='ghost'
                    isDisabled
                />
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
                    `Written: ${String(sheet.width)} × ${String(sheet.height)}, ${String(sheet.columns)} across`
                :   `${String(cameras.length)} sprites at ${String(cell)} px — colour and normal`}
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
                    {label: 'Individual sprites (not built)', isDisabled: true},
                    {label: 'Metadata JSON (not built)', isDisabled: true}
                ]}
            />
        </div>
    </section>
)
