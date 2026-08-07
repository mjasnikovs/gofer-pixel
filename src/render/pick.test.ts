import {expect, test} from 'bun:test'
import {basisFor, type Camera} from './camera'
import {FACE_NORMAL, FACE_STEP, FACE_Z_POS} from './faces'
import {pick, pickGround, pickRay} from './pick'
import {render} from './raycast'
import {createVolume, setVoxel, voxelAt, type Volume} from './volume'

const N = 16
const SIZE = 48

const testVolume = (): Volume => {
    const volume = createVolume(N, N, N, new Uint8Array(256 * 4))
    let seed = 0x2f6e2b1
    for (let z = 0; z < N; z += 1) {
        for (let y = 0; y < N; y += 1) {
            for (let x = 0; x < N; x += 1) {
                seed = (seed * 1103515245 + 12345) >>> 0
                if ((x + y + z) % 5 !== 0 && seed >>> 24 > 40) {
                    setVoxel(volume, x, y, z, 1 + ((x * 7 + y * 5 + z * 3) % 200))
                }
            }
        }
    }
    return volume
}

const CAMERAS: readonly {name: string; camera: Camera}[] = [
    {name: 'oblique', camera: {yaw: 0.7, pitch: 0.5, zoom: N, panX: 0, panY: 0}},
    {name: 'front', camera: {yaw: 0, pitch: 0, zoom: N, panX: 0, panY: 0}},
    {name: 'right', camera: {yaw: Math.PI / 2, pitch: 0, zoom: N, panX: 0, panY: 0}},
    {name: 'top', camera: {yaw: 0, pitch: Math.PI / 2, zoom: N, panX: 0, panY: 0}},
    {name: 'panned', camera: {yaw: 1.2346, pitch: 0.3457, zoom: 22, panX: 3, panY: -2}}
]

/**
 * The claim that keeps a second copy of the DDA honest: pick every pixel of a render and demand the
 * voxel and the face the renderer drew there. Checked against the exporter, which is the thing that
 * actually ships a sprite — a stronger guarantee than sharing a function would be.
 */
for (const {name, camera} of CAMERAS) {
    test(`picking every pixel agrees with the render — ${name}`, () => {
        const volume = testVolume()
        const basis = basisFor(camera, volume, SIZE)
        const target = render(volume, basis, SIZE, SIZE)

        let hits = 0
        for (let row = 0; row < SIZE; row += 1) {
            for (let column = 0; column < SIZE; column += 1) {
                const at = row * SIZE + column
                const drew = target.id[at] ?? 0
                const hit = pickRay(volume, basis, column, row, SIZE, SIZE)
                if (drew === 0) {
                    expect(hit).toBeUndefined()
                    continue
                }
                hits += 1
                if (!hit) throw new Error(`${name}: no hit at ${String(column)},${String(row)}`)
                expect(hit.value).toBe(drew)
                expect(voxelAt(volume, hit.x, hit.y, hit.z)).toBe(drew)
                expect(FACE_NORMAL[hit.face * 3]).toBe(target.normal[at * 4])
                expect(FACE_NORMAL[hit.face * 3 + 1]).toBe(target.normal[at * 4 + 1])
                expect(FACE_NORMAL[hit.face * 3 + 2]).toBe(target.normal[at * 4 + 2])
            }
        }
        expect(hits).toBeGreaterThan(SIZE * SIZE * 0.3)
    })
}

test('the cell a draw writes is empty, touches the hit and lies in front of its face', () => {
    const volume = testVolume()
    const camera: Camera = {yaw: 0.7, pitch: 0.5, zoom: N, panX: 0, panY: 0}
    const basis = basisFor(camera, volume, SIZE)

    let checked = 0
    for (let row = 0; row < SIZE; row += 2) {
        for (let column = 0; column < SIZE; column += 2) {
            const hit = pickRay(volume, basis, column, row, SIZE, SIZE)
            if (!hit) continue
            checked += 1
            const [px, py, pz] = hit.place
            expect(voxelAt(volume, px, py, pz)).toBe(0)
            const [dx, dy, dz] = FACE_STEP[hit.face] ?? [0, 0, 0]
            expect([px - hit.x, py - hit.y, pz - hit.z]).toEqual([dx, dy, dz])
            expect(Math.abs(dx) + Math.abs(dy) + Math.abs(dz)).toBe(1)
        }
    }
    expect(checked).toBeGreaterThan(100)
})

test('an empty document still has somewhere to put the first voxel', () => {
    const volume = createVolume(8, 8, 8)
    const camera: Camera = {yaw: 0.6, pitch: 0.6, zoom: 12, panX: 0, panY: 0}
    const basis = basisFor(camera, volume, 32)

    const cells = new Set<string>()
    for (let row = 0; row < 32; row += 1) {
        for (let column = 0; column < 32; column += 1) {
            expect(pickRay(volume, basis, column, row, 32, 32)).toBeUndefined()
            const ground = pick(volume, basis, column, row, 32, 32)
            if (!ground) continue
            const [x, y, z] = ground.place
            expect(ground.face).toBe(FACE_Z_POS)
            expect(ground.value).toBe(0)
            expect(z).toBe(0)
            expect(x).toBeGreaterThanOrEqual(0)
            expect(x).toBeLessThan(8)
            expect(y).toBeGreaterThanOrEqual(0)
            expect(y).toBeLessThan(8)
            cells.add(`${String(x)},${String(y)}`)
        }
    }
    // The whole floor of the grid is reachable from a three-quarter view, which is what makes an
    // empty document drawable at all.
    expect(cells.size).toBe(64)

    // Seen from underneath, the floor is the wrong side of a plane, and not a place to draw.
    const away: Camera = {yaw: 0, pitch: -Math.PI / 2, zoom: 12, panX: 0, panY: 0}
    expect(pickGround(volume, basisFor(away, volume, 32), 16, 16, 32, 32)).toBeUndefined()
})

test('the model wins over the floor when both are under the cursor', () => {
    const volume = createVolume(8, 8, 8)
    setVoxel(volume, 4, 4, 4, 3)
    const camera: Camera = {yaw: 0, pitch: Math.PI / 2, zoom: 8, panX: 0, panY: 0}
    const basis = basisFor(camera, volume, 8)

    // Straight down: `right` is +x and `up` is -y, so column (4, 4) is pixel (4, 4).
    const hit = pick(volume, basis, 4, 4, 8, 8)
    expect(hit?.value).toBe(3)
    expect(hit?.z).toBe(4)
    expect(hit?.place).toEqual([4, 4, 5])
})
