import {expect, test} from 'bun:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import type {NamedCamera} from '../doc/cameras'
import {basisFor, createCamera} from '../render/camera'
import {render} from '../render/raycast'
import {createVolume, setVoxel} from '../render/volume'
import {facingShare, LIGHT_CONVENTION} from './lightcheck'
import {NormalCheck} from './NormalCheck'

const palette = new Uint8Array(256 * 4)
palette.set([200, 200, 200, 255], 1 * 4)

const volume = createVolume(8, 8, 8, palette)
// A slab with a top and a front: two face directions, so the share is neither 0 nor 1.
for (let x = 0; x < 8; x += 1)
    for (let y = 0; y < 8; y += 1) for (let z = 0; z < 3; z += 1) setVoxel(volume, x, y, z, 1)

const named = (yaw: number, pitch: number): NamedCamera => ({
    id: 'test',
    name: 'Test',
    camera: createCamera(volume, yaw, pitch)
})

const SIZE = 24

const show = async (camera: NamedCamera) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
        root.render(
            <NormalCheck
                volume={volume}
                camera={camera}
                size={SIZE}
            />
        )
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

test('the check draws the lit map at the size asked for', async () => {
    const shown = await show(named(0, 0.6))

    const canvas = shown.host.querySelector('canvas.render-canvas')
    expect(canvas?.getAttribute('data-pixels')).toBe('24x24')

    await shown.done()
})

/*
 * §19's whole point: a preview that looks plausible and does not say what it assumed cannot tell
 * anyone they are wrong. The convention is part of the diagnostic, not a caption on it.
 */
test('the check states the axis convention it lit the map under', async () => {
    const shown = await show(named(0, 0.6))

    expect(shown.host.textContent).toContain(LIGHT_CONVENTION)

    await shown.done()
})

test('the percentage shown is the share of the map that faces the light', async () => {
    const camera = named(0.4, 0.6)
    const {normal} = render(volume, basisFor(camera.camera, volume, SIZE), SIZE, SIZE)
    const share = facingShare(normal)
    const shown = await show(camera)

    expect(share).toBeGreaterThan(0)
    expect(share).toBeLessThan(1)
    expect(shown.host.textContent).toContain(
        `${String(Math.round(share * 100))}% of the sprite faces the light`
    )

    await shown.done()
})

/*
 * The number is what the diagnostic is for, so it has to move. A slab seen from above is nearly all
 * top faces, which the light is over; seen from below it is nearly all bottom faces, which it is
 * not. If those two read the same, the check is decoration.
 */
test('looking up at the model reads lower than looking down at it', async () => {
    const above = await show(named(0, Math.PI / 2))
    const below = await show(named(0, -Math.PI / 2))

    const percent = (text: string): number => Number(/(\d+)%/.exec(text)?.[1] ?? -1)
    expect(percent(above.host.textContent)).toBeGreaterThan(percent(below.host.textContent))

    await above.done()
    await below.done()
})

test('a camera pointing away from the model reports nothing rather than dividing by zero', async () => {
    // Panned right off the frame: no hits, so no lit pixels and no total to divide by.
    const camera = named(0, 0)
    const shown = await show({...camera, camera: {...camera.camera, panX: 500}})

    expect(shown.host.textContent).toContain('0% of the sprite faces the light')

    await shown.done()
})
