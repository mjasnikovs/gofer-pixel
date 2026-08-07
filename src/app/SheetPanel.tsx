import {Button} from '@astryxdesign/core/Button'
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl'
import {Text} from '@astryxdesign/core/Text'
import {encodePng} from '../image/png'
import type {Sheet} from '../sheet/sheet'
import {PixelCanvas} from './PixelCanvas'
import {SectionHead} from './SectionHead'

const CELL_SIZES = [32, 64, 128]

const download = async (name: string, width: number, height: number, data: Uint8Array) => {
    const png = await encodePng(width, height, data)
    const url = URL.createObjectURL(new Blob([png as BlobPart], {type: 'image/png'}))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    URL.revokeObjectURL(url)
}

const SheetPreview = ({
    title,
    sheet,
    data,
    file
}: {
    title: string
    sheet: Sheet
    data: Uint8Array
    file: string
}) => (
    <div className='sheet-preview'>
        <div className='sheet-preview-head'>
            <Text
                type='supporting'
                color='disabled'
            >
                {title}
            </Text>
            <span className='spacer' />
            <Button
                // Two buttons reading "Download" is two controls with one name; the accessible
                // name says which file, the visible text stays short.
                label={`Download ${file}`}
                size='sm'
                variant='ghost'
                clickAction={async () => {
                    await download(file, sheet.width, sheet.height, data)
                }}
            >
                Download
            </Button>
        </div>
        <div className='sheet-frame'>
            <PixelCanvas
                width={sheet.width}
                height={sheet.height}
                data={data}
                className='sheet-canvas'
                title={title}
            />
        </div>
    </div>
)

/**
 * The export half of `docs/featureset.png` §2 and §5: render every camera into one packed sheet,
 * show the colour and the normal map one above the other, and hand over the PNGs.
 *
 * Both sheets come out of the CPU raycaster in one pass, which is why they are aligned and why
 * `sheet.test.ts` can golden-hash the exact bytes the download button produces. Each one carries
 * its own download control, because the two files are used by different parts of an engine and
 * an artist often wants only one of them.
 */
export const SheetPanel = ({
    sheet,
    cell,
    onCell,
    onBake
}: {
    sheet: Sheet | undefined
    cell: number
    onCell: (cell: number) => void
    onBake: () => void
}) => (
    <section className='section section-grows'>
        <SectionHead title='Sprite sheet'>
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

        {sheet ?
            <div className='sheet-body'>
                <SheetPreview
                    title={`Colour · ${String(sheet.width)} × ${String(sheet.height)}`}
                    sheet={sheet}
                    data={sheet.color}
                    file='sprites.png'
                />
                <SheetPreview
                    title='Normal'
                    sheet={sheet}
                    data={sheet.normal}
                    file='sprites-normal.png'
                />
            </div>
        :   <div className='sheet-empty'>
                <Text
                    type='supporting'
                    color='disabled'
                >
                    No sheet yet — render one to see the sprites and their normal map.
                </Text>
            </div>
        }

        <div className='section-foot'>
            <Button
                label='Render sprite sheet'
                variant='primary'
                width='100%'
                onClick={onBake}
            />
        </div>
    </section>
)
