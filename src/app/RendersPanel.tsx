import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl'
import {Text} from '@astryxdesign/core/Text'
import type {NamedCamera} from '../doc/cameras'
import {
    MODE_AO,
    MODE_COLOR,
    MODE_DEPTH_VIEW,
    MODE_EMISSION,
    MODE_NORMAL
} from '../render/raycast.glsl'
import type {Volume} from '../render/volume'
import {SectionHead} from './SectionHead'
import {Thumbnail} from './Thumbnail'

/**
 * `docs/editor.png`'s RENDERS row and the preview under it — one camera, five maps.
 *
 * Colour, normal and depth are not three renderers: one ray already knows the voxel it hit, the
 * face it struck and how far it travelled, so switching between them re-reads a buffer the renderer
 * had already filled. That is `docs/featureset.png` §5 falling out of the raycaster rather than
 * being built.
 *
 * All five come off the same ray, so they are aligned by construction rather than by a later
 * resampling step — `docs/FEATURESET.md` §18 falling out of the raycaster rather than being built.
 * Occlusion is the one that costs anything: eight neighbour reads at the hit, interpolated to where
 * inside the cell the ray landed.
 */
const MAPS = [
    {value: MODE_COLOR, label: 'Color'},
    {value: MODE_NORMAL, label: 'Normal'},
    {value: MODE_DEPTH_VIEW, label: 'Depth'},
    {value: MODE_AO, label: 'AO'},
    {value: MODE_EMISSION, label: 'Emission'}
]

export const RendersPanel = ({
    volume,
    camera,
    map,
    onMap
}: {
    volume: Volume
    camera: NamedCamera | undefined
    map: number
    onMap: (map: number) => void
}) => (
    <section className='section section-holds'>
        <SectionHead title='Renders' />
        <div className='render-body'>
            <SegmentedControl
                label='Which map to preview'
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

            <div className='checker render-preview'>
                {camera ?
                    <Thumbnail
                        volume={volume}
                        camera={camera.camera}
                        size={128}
                        map={map}
                        className='render-canvas'
                    />
                :   <Text
                        type='supporting'
                        color='disabled'
                    >
                        The view has been moved — pick a camera to preview its maps.
                    </Text>
                }
            </div>
        </div>
    </section>
)
