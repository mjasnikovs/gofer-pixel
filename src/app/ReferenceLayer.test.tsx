import {expect, test} from 'bun:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import type {Axis} from '../doc/brush'
import type {Reference} from '../doc/reference'
import {createCamera, type Camera} from '../render/camera'
import {createVolume} from '../render/volume'
import {ReferenceLayer} from './ReferenceLayer'

const volume = createVolume(8, 8, 8, new Uint8Array(256 * 4))

const PICTURE = 'data:image/png;base64,iVBORw0KGgo='

const reference = (plane: Axis, extra: Partial<Reference> = {}): Reference => ({
    plane,
    url: PICTURE,
    opacity: 0.5,
    locked: false,
    ...extra
})

/** The layer's whole output is one `<svg>` of `<image>` elements, so the test reads them back. */
const draw = async (
    camera: Camera,
    references: readonly Reference[]
): Promise<{svg: SVGSVGElement | null; images: SVGImageElement[]; done: () => Promise<void>}> => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
        root.render(
            <ReferenceLayer
                volume={volume}
                camera={camera}
                references={references}
            />
        )
    })
    return {
        svg: host.querySelector('svg.reference-layer'),
        images: [...host.querySelectorAll('image')],
        done: async () => {
            await act(async () => {
                root.unmount()
            })
            host.remove()
        }
    }
}

/** The six numbers out of `transform="matrix(a b c d e f)"`. */
const matrixOf = (image: SVGImageElement | undefined): number[] => {
    if (!image) throw new Error('no reference image')
    return (/matrix\(([^)]*)\)/.exec(image.getAttribute('transform') ?? '')?.[1] ?? '')
        .split(' ')
        .map(Number)
}

test('no references means no layer at all, not an empty one', async () => {
    const drawn = await draw(createCamera(volume, 0, 0), [])

    expect(drawn.svg).toBeNull()
    await drawn.done()
})

/*
 * The point of §33 is that a 32×32 front view lines up with a 32-wide model without the artist
 * doing arithmetic. Straight on, that means the picture's box is exactly the grid's own box: the
 * unit square maps to the volume's full width and height, centred.
 */
test('a front reference under a front camera covers exactly the grid box', async () => {
    const drawn = await draw(createCamera(volume, 0, 0), [reference(1)])

    expect(matrixOf(drawn.images[0])).toEqual([8, 0, 0, 8, -4, -4])
    await drawn.done()
})

test('a top reference under a top-down camera covers exactly the grid box', async () => {
    const drawn = await draw(createCamera(volume, 0, Math.PI / 2), [reference(2)])

    // Axis-aligned again: no shear, and the same 8 × 8 extent as the model seen from above.
    const [a, b, c, d] = matrixOf(drawn.images[0])
    expect([b, c]).toEqual([0, 0])
    expect([Math.abs(a ?? 0), Math.abs(d ?? 0)]).toEqual([8, 8])
    await drawn.done()
})

/*
 * The other half of §33: it is projected, not pasted. A plane seen off-axis has to shear, or the
 * artist is building against a picture that stopped agreeing with the model the moment they orbited.
 */
test('an off-axis camera shears the picture instead of leaving it square', async () => {
    const drawn = await draw(createCamera(volume, Math.PI / 4, 0.6), [reference(1)])

    const [, b, c] = matrixOf(drawn.images[0])
    expect(Math.abs(b ?? 0) + Math.abs(c ?? 0)).toBeGreaterThan(0.1)
    await drawn.done()
})

test('a side reference turns edge-on when the camera looks straight at its plane', async () => {
    // Looking down -y, the side plane (x = 0) is seen edge-on, so it projects to no width at all.
    const drawn = await draw(createCamera(volume, 0, 0), [reference(0)])

    const [a, b] = matrixOf(drawn.images[0])
    expect(Math.hypot(a ?? 0, b ?? 0)).toBeCloseTo(0, 6)
    await drawn.done()
})

test('the viewBox is the camera zoom, so the picture scales with it', async () => {
    const camera = createCamera(volume, 0, 0)
    const drawn = await draw({...camera, zoom: 20}, [reference(1)])

    expect(drawn.svg?.getAttribute('viewBox')).toBe('-10 -10 20 20')
    await drawn.done()
})

test('a pan moves the picture with the model rather than leaving it behind', async () => {
    const camera = createCamera(volume, 0, 0)
    const still = await draw(camera, [reference(1)])
    const stillMatrix = matrixOf(still.images[0])
    await still.done()

    const panned = await draw({...camera, panX: 3}, [reference(1)])
    const pannedMatrix = matrixOf(panned.images[0])
    await panned.done()

    // Same shape, shifted three voxels along `right`.
    expect(pannedMatrix.slice(0, 4)).toEqual(stillMatrix.slice(0, 4))
    expect((pannedMatrix[4] ?? 0) - (stillMatrix[4] ?? 0)).toBeCloseTo(-3, 6)
})

test('every plane gets its own image, with its own opacity and url', async () => {
    const drawn = await draw(createCamera(volume, 0.5, 0.5), [
        reference(0, {opacity: 0.25}),
        reference(1, {opacity: 1}),
        reference(2, {opacity: 0.4})
    ])

    expect(drawn.images).toHaveLength(3)
    expect(drawn.images.map(image => image.getAttribute('opacity'))).toEqual(['0.25', '1', '0.4'])
    for (const image of drawn.images) expect(image.getAttribute('href')).toBe(PICTURE)
    await drawn.done()
})

test('the layer is hidden from assistive tech — it is scenery, not content', async () => {
    const drawn = await draw(createCamera(volume, 0, 0), [reference(1)])

    expect(drawn.svg?.getAttribute('aria-hidden')).toBe('true')
    await drawn.done()
})
