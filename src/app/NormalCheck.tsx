import {Text} from '@astryxdesign/core/Text'
import {useMemo} from 'react'
import type {NamedCamera} from '../doc/cameras'
import {basisFor} from '../render/camera'
import {render} from '../render/raycast'
import type {Volume} from '../render/volume'
import {facingShare, LIGHT_CONVENTION, lightNormals} from './lightcheck'
import {PixelCanvas} from './PixelCanvas'

/**
 * The normal-map diagnostic — `FEATURESET.md` §19.
 *
 * One light, on a fixed and labelled axis convention, over the normal map of the camera being
 * previewed. Its only job is to catch an inverted green channel before the artist ships a map that
 * lights backwards, and the labelling is half of that job: a preview that looks plausible and does
 * not say what it assumed cannot tell anyone they are wrong.
 *
 * The lighting comes from `lightcheck.ts`, which imports nothing from the renderer on purpose. See
 * the note at the top of that file.
 *
 * It appears under the Normal tab and nowhere else. It is not a render mode, it is not a map, and
 * it is never exported — a lighting preview that could be saved is a lighting model, and §21 is
 * postponed so that this editor does not have one.
 */
export const NormalCheck = ({
    volume,
    camera,
    size
}: {
    volume: Volume
    camera: NamedCamera
    size: number
}) => {
    const {pixels, share} = useMemo(() => {
        const {normal} = render(volume, basisFor(camera.camera, volume, size), size, size)
        return {pixels: lightNormals(normal), share: facingShare(normal)}
    }, [volume, camera, size])

    return (
        <div className='normal-check'>
            <div className='checker render-preview'>
                <PixelCanvas
                    width={size}
                    height={size}
                    data={pixels}
                    className='render-canvas'
                />
            </div>
            <Text
                type='supporting'
                color='disabled'
            >
                {LIGHT_CONVENTION}
            </Text>
            <Text
                type='supporting'
                hasTabularNumbers
            >
                {Math.round(share * 100)}% of the sprite faces the light
            </Text>
        </div>
    )
}
