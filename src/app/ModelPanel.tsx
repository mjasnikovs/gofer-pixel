import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl'
import {Text} from '@astryxdesign/core/Text'
import {MODE_COLOR, MODE_DEPTH_VIEW, MODE_ID_VIEW, MODE_NORMAL} from '../render/raycast.glsl'
import type {Volume} from '../render/volume'
import {countVoxels} from '../vox/vox-file'
import {SectionHead} from './SectionHead'

/**
 * What is loaded, and which of the maps the viewport is drawing.
 *
 * The four maps are not four renderers: one ray already knows the voxel it hit, the face it struck
 * and how far it travelled, so switching between them changes a uniform and nothing else. That is
 * `docs/featureset.png` §5 falling out of the renderer rather than being built.
 */
const MAPS = [
    {value: MODE_COLOR, label: 'Colour'},
    {value: MODE_NORMAL, label: 'Normal'},
    {value: MODE_DEPTH_VIEW, label: 'Depth'},
    {value: MODE_ID_VIEW, label: 'Voxel'}
]

const Row = ({name, value}: {name: string; value: string}) => (
    <div className='model-row'>
        <Text
            type='supporting'
            color='disabled'
        >
            {name}
        </Text>
        <Text
            type='supporting'
            hasTabularNumbers
        >
            {value}
        </Text>
    </div>
)

export const ModelPanel = ({
    name,
    volume,
    map,
    onMap
}: {
    name: string
    volume: Volume
    map: number
    onMap: (map: number) => void
}) => (
    <div className='panel'>
        <section className='section'>
            <SectionHead title='Model' />
            <div className='section-body'>
                <Row
                    name='File'
                    value={name}
                />
                <Row
                    name='Size'
                    value={`${String(volume.sx)} × ${String(volume.sy)} × ${String(volume.sz)}`}
                />
                <Row
                    name='Voxels'
                    value={String(countVoxels(volume))}
                />
            </div>
        </section>

        <section className='section'>
            <SectionHead title='Renders' />
            <div className='section-body'>
                <SegmentedControl
                    label='Which map the viewport draws'
                    size='sm'
                    layout='fill'
                    value={String(map)}
                    onChange={value => {
                        onMap(Number(value))
                    }}
                >
                    {MAPS.map(({value, label}) => (
                        <SegmentedControlItem
                            key={value}
                            value={String(value)}
                            label={label}
                        />
                    ))}
                </SegmentedControl>
            </div>
        </section>

        <section className='section section-pinned'>
            <SectionHead title='Controls' />
            <div className='section-body'>
                <Row
                    name='Drag'
                    value='Orbit'
                />
                <Row
                    name='Shift drag'
                    value='Pan'
                />
                <Row
                    name='Wheel'
                    value='Zoom'
                />
            </div>
        </section>
    </div>
)
