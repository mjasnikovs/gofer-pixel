import {expect, test} from 'bun:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {basisFor, createCamera, type Camera} from '../render/camera'
import {render} from '../render/raycast'
import {
    MODE_AO,
    MODE_COLOR,
    MODE_DEPTH_VIEW,
    MODE_EMISSION,
    MODE_NORMAL
} from '../render/raycast.glsl'
import {createVolume, setVoxel} from '../render/volume'
import {spriteFor} from './sprite-cache'
import {Thumbnail} from './Thumbnail'

/**
 * A palette with one plain colour and one bright one, so emission is not uniformly black and the
 * colour map is not uniformly one shade.
 */
const palette = new Uint8Array(256 * 4)
palette.set([200, 40, 40, 255], 1 * 4)
palette.set([40, 200, 40, 255], 2 * 4)

const volume = createVolume(8, 8, 8, palette)
/*
 * The camera below looks down -y, so it sees high y first. A wall at the far side and one voxel
 * standing seven cells nearer is the minimum a depth map has to tell apart.
 */
for (let x = 0; x < 8; x += 1) for (let z = 0; z < 4; z += 1) setVoxel(volume, x, 0, z, 1)
setVoxel(volume, 3, 7, 0, 2)

const SIZE = 16
const camera = createCamera(volume, 0, 0)

const buffer = (map: number, cam: Camera = camera): Uint8Array =>
    spriteFor(volume, cam, SIZE, map)()

test('every map comes back as one RGBA buffer the size of the sprite', () => {
    for (const map of [MODE_COLOR, MODE_NORMAL, MODE_DEPTH_VIEW, MODE_AO, MODE_EMISSION])
        expect(buffer(map).length).toBe(SIZE * SIZE * 4)
})

test('colour and normal are the raycaster’s own buffers, not a second rendering of them', () => {
    const target = render(volume, basisFor(camera, volume, SIZE), SIZE, SIZE)

    expect(buffer(MODE_COLOR)).toEqual(target.color)
    expect(buffer(MODE_NORMAL)).toEqual(target.normal)
    expect(buffer(MODE_EMISSION)).toEqual(target.emission)
})

/*
 * The depth view exists because the exported buffer is unreadable: it runs over `depthRange`, twice
 * the sum of the sides, and the model occupies a sliver of it. Stretched across the volume's own
 * diagonal instead, two voxels at different distances have to come out as two different greys.
 */
test('the depth view separates a near voxel from a far one, and leaves the miss transparent', () => {
    const target = render(volume, basisFor(camera, volume, SIZE), SIZE, SIZE)
    const pixels = buffer(MODE_DEPTH_VIEW)

    const greys = new Set<number>()
    let missIsClear = true
    let hitIsOpaque = true
    for (let i = 0; i < SIZE * SIZE; i += 1) {
        const [r, g, b, a] = [
            pixels[i * 4] ?? 0,
            pixels[i * 4 + 1] ?? 0,
            pixels[i * 4 + 2] ?? 0,
            pixels[i * 4 + 3] ?? 0
        ]
        if ((target.id[i] ?? 0) === 0) {
            if (r + g + b + a !== 0) missIsClear = false
            continue
        }
        if (a !== 255) hitIsOpaque = false
        // Grey means the three channels agree.
        expect([g, b]).toEqual([r, r])
        greys.add(r)
    }

    expect(missIsClear).toBe(true)
    expect(hitIsOpaque).toBe(true)
    expect(greys.size).toBeGreaterThan(1)
})

test('nearer is brighter in the depth view', () => {
    const target = render(volume, basisFor(camera, volume, SIZE), SIZE, SIZE)
    const pixels = buffer(MODE_DEPTH_VIEW)

    let near = -1
    let far = -1
    for (let i = 0; i < SIZE * SIZE; i += 1) {
        if ((target.id[i] ?? 0) === 0) continue
        const depth = target.depth[i] ?? 0
        if (near < 0 || depth < (target.depth[near] ?? 0)) near = i
        if (far < 0 || depth > (target.depth[far] ?? 0)) far = i
    }

    expect(near).toBeGreaterThanOrEqual(0)
    expect(pixels[near * 4] ?? 0).toBeGreaterThan(pixels[far * 4] ?? 0)
})

test('occlusion becomes grey where the ray hit and nothing where it missed', () => {
    const target = render(volume, basisFor(camera, volume, SIZE), SIZE, SIZE)
    const pixels = buffer(MODE_AO)

    for (let i = 0; i < SIZE * SIZE; i += 1) {
        if ((target.id[i] ?? 0) === 0) {
            expect(pixels.subarray(i * 4, i * 4 + 4)).toEqual(new Uint8Array(4))
            continue
        }
        const shade = target.ao[i] ?? 0
        expect(pixels.subarray(i * 4, i * 4 + 4)).toEqual(
            new Uint8Array([shade, shade, shade, 255])
        )
    }
})

/*
 * The cache is what keeps a window with twenty-six previews on it from rendering the same sprite
 * three times. It is keyed by the camera's *values* because `eightDirections` builds fresh objects
 * on every run, so identity would miss on every render and the cache would be a memory leak with
 * no upside.
 */
test('the same camera values hit the cache even from a different object', () => {
    const once = spriteFor(volume, camera, SIZE, MODE_COLOR)
    const again = spriteFor(volume, {...camera}, SIZE, MODE_COLOR)

    expect(again).toBe(once)
})

test('a different camera, size or map is a different sprite', () => {
    const base = spriteFor(volume, camera, SIZE, MODE_COLOR)

    expect(spriteFor(volume, {...camera, yaw: 1}, SIZE, MODE_COLOR)).not.toBe(base)
    expect(spriteFor(volume, {...camera, panX: 2}, SIZE, MODE_COLOR)).not.toBe(base)
    expect(spriteFor(volume, camera, SIZE + 1, MODE_COLOR)).not.toBe(base)
    expect(spriteFor(volume, camera, SIZE, MODE_NORMAL)).not.toBe(base)
})

test('two documents do not share a cache', () => {
    const other = createVolume(8, 8, 8, palette)
    setVoxel(other, 0, 0, 0, 1)

    expect(spriteFor(other, camera, SIZE, MODE_COLOR)).not.toBe(
        spriteFor(volume, camera, SIZE, MODE_COLOR)
    )
})

const mount = async (node: React.ReactNode) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
        root.render(node)
    })
    return {
        host,
        done: async () => {
            await act(async () => {
                root.unmount()
            })
            host.remove()
        }
    }
}

test('a thumbnail is one canvas at the size asked for', async () => {
    const mounted = await mount(
        <Thumbnail
            volume={volume}
            camera={camera}
            size={24}
            map={MODE_AO}
            className='export-sprite'
        />
    )

    const canvas = mounted.host.querySelector('canvas')
    expect(canvas?.getAttribute('data-pixels')).toBe('24x24')
    expect(canvas?.className).toBe('export-sprite')

    await mounted.done()
})

test('with nothing said, a thumbnail is 72 px of colour', async () => {
    const mounted = await mount(
        <Thumbnail
            volume={volume}
            camera={camera}
        />
    )

    const canvas = mounted.host.querySelector('canvas')
    expect(canvas?.getAttribute('data-pixels')).toBe('72x72')
    expect(canvas?.className).toBe('thumbnail')

    await mounted.done()
})
