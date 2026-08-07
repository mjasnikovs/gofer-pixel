import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl'
import {Text} from '@astryxdesign/core/Text'
import type {NamedCamera} from '../doc/cameras'
import {MODE_COLOR, MODE_DEPTH_VIEW, MODE_NORMAL} from '../render/raycast.glsl'
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
 * AO and emission are drawn and disabled. Both are promised by `docs/FEATURESET.md` §18 and neither
 * exists yet — AO needs a second trace per hit, emission needs the per-colour emissive flag that
 * §20 keeps as its single exception. A tab that renders a plausible grey square instead would be
 * the one lie this panel cannot afford, because the whole claim being made is that the maps line up
 * with the colour sprite.
 */
const MAPS = [
    {value: MODE_COLOR, label: 'Color'},
    {value: MODE_NORMAL, label: 'Normal'},
    {value: MODE_DEPTH_VIEW, label: 'Depth'}
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
                <SegmentedControlItem
                    value='ao'
                    label='AO'
                    isDisabled
                />
                <SegmentedControlItem
                    value='emission'
                    label='Emission'
                    isDisabled
                />
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
