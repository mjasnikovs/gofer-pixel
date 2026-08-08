import {expect, test} from 'bun:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {createCamera} from '../render/camera'
import {createVolume, setVoxel} from '../render/volume'
import {ViewCube} from './ViewportOverlay'

const volume = createVolume(8, 8, 8, new Uint8Array(256 * 4))
setVoxel(volume, 3, 3, 3, 1)

/**
 * The cube is drawn from the live basis, so its projected size is not constant: a corner-on view
 * spreads the eight corners over `sqrt(3)` times the half-diagonal, an axis-aligned one over `1`.
 * The `viewBox` has to hold the widest of those, not the narrowest, or the artist sees a cube with
 * its corners sliced off at exactly the angles they orbit to most.
 */
const cubeExtent = async (yaw: number, pitch: number): Promise<number> => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
        root.render(
            <ViewCube
                volume={volume}
                camera={createCamera(volume, yaw, pitch)}
            />
        )
    })

    const svg = host.querySelector('svg.view-cube')
    if (!svg) throw new Error('no view cube')
    const [, , width] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number)
    const stroke = Number(svg.querySelector('line')?.getAttribute('stroke-width') ?? 1)

    let reach = 0
    for (const line of svg.querySelectorAll('line'))
        for (const name of ['x1', 'y1', 'x2', 'y2'])
            reach = Math.max(reach, Math.abs(Number(line.getAttribute(name))) + stroke / 2)

    await act(async () => {
        root.unmount()
    })
    host.remove()
    return reach / ((width ?? 0) / 2)
}

test('the view cube fits inside its viewBox from every angle', async () => {
    const overflowing: string[] = []
    for (let yaw = 0; yaw < 360; yaw += 15)
        for (let pitch = -90; pitch <= 90; pitch += 15) {
            const fill = await cubeExtent((yaw * Math.PI) / 180, (pitch * Math.PI) / 180)
            if (fill > 1)
                overflowing.push(`yaw ${String(yaw)}° pitch ${String(pitch)}°: ${fill.toFixed(2)}×`)
        }
    expect(overflowing).toEqual([])
})

test('the view cube still fills its viewBox at the angle that spreads it widest', async () => {
    // A wireframe that never touches its box is a cube drawn small, which is the other failure.
    expect(await cubeExtent(Math.PI / 4, Math.atan(Math.SQRT1_2))).toBeGreaterThan(0.9)
})
