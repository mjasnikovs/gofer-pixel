import {expect, test} from 'bun:test'
import {basisFor, snap, type Camera} from './camera'
import {
    FACE_LIGHT,
    FACE_NORMAL,
    FACE_X_NEG,
    FACE_X_POS,
    FACE_Y_NEG,
    FACE_Y_POS,
    FACE_Z_POS
} from './faces'
import {render} from './raycast'
import {createVolume, setVoxel, voxelAt, type Volume} from './volume'

const N = 16
/** Four output pixels per voxel, so a voxel that vanishes takes 16 pixels with it. */
const SCALE = 4
const SIZE = N * SCALE

/** A shape with plenty of silhouette edge, holes and voxels flush against every box face. */
const testVolume = (): Volume => {
    const volume = createVolume(N, N, N, new Uint8Array(256 * 4))
    let seed = 0x2f6e2b1
    for (let z = 0; z < N; z += 1) {
        for (let y = 0; y < N; y += 1) {
            for (let x = 0; x < N; x += 1) {
                seed = (seed * 1103515245 + 12345) >>> 0
                const solid = (x + y + z) % 5 !== 0 && seed >>> 24 > 40
                if (solid) setVoxel(volume, x, y, z, 1 + ((x * 7 + y * 5 + z * 3) % 200))
            }
        }
    }
    for (let i = 0; i < 256; i += 1) {
        volume.palette[i * 4] = (i * 11) % 256
        volume.palette[i * 4 + 1] = (i * 37) % 256
        volume.palette[i * 4 + 2] = (i * 97) % 256
        volume.palette[i * 4 + 3] = 255
    }
    return volume
}

/** `zoom` in voxels over `height` in pixels is exactly `1 / SCALE` voxels per pixel. */
const axialCamera = (yaw: number): Camera => ({yaw, pitch: 0, zoom: N, panX: 0, panY: 0})

/**
 * The four axis-aligned yaws, each with the ray walk written out independently of the renderer:
 * `k` is how many voxels along the ray we are, `u` is the screen column in voxels, `v` the screen
 * row in voxels. If the renderer and this disagree, one of them lost a voxel column.
 */
const AXIAL = [
    {
        name: 'front (yaw 0)',
        yaw: 0,
        at: (u: number, v: number, k: number) => [u, N - 1 - k, v] as const,
        face: FACE_Y_POS
    },
    {
        name: 'right (yaw 90°)',
        yaw: Math.PI / 2,
        at: (u: number, v: number, k: number) => [N - 1 - k, N - 1 - u, v] as const,
        face: FACE_X_POS
    },
    {
        name: 'back (yaw 180°)',
        yaw: Math.PI,
        at: (u: number, v: number, k: number) => [N - 1 - u, k, v] as const,
        face: FACE_Y_NEG
    },
    {
        name: 'left (yaw 270°)',
        yaw: (3 * Math.PI) / 2,
        at: (u: number, v: number, k: number) => [k, u, v] as const,
        face: FACE_X_NEG
    }
]

test('a basis component that should be zero is exactly zero, and every component is float32', () => {
    expect(snap(Math.cos(Math.PI / 2))).toBe(0)
    expect(snap(-0)).toBe(0)
    expect(snap(0.1)).toBe(Math.fround(0.1))

    const volume = createVolume(N, N, N)
    for (const {yaw} of AXIAL) {
        const {forward, right, up} = basisFor(axialCamera(yaw), volume, SIZE)
        for (const component of [...forward, ...right, ...up]) {
            expect(Math.abs(component) === 0 || Math.abs(component) === 1).toBe(true)
            expect(Object.is(component, -0)).toBe(false)
        }
    }
})

/**
 * The property that has now bitten this project twice from two different directions: at
 * 0/90/180/270° an "axis-aligned" camera is not axis-aligned in floating point, `1 / dir` explodes,
 * and a fifth of the model disappears without anything failing. Every occupied voxel column has to
 * survive, and the exact voxel it shows has to be the nearest one along the ray.
 */
for (const {name, yaw, at, face} of AXIAL) {
    test(`every occupied voxel column survives at ${name}`, () => {
        const volume = testVolume()
        const target = render(volume, basisFor(axialCamera(yaw), volume, SIZE), SIZE, SIZE)

        let columns = 0
        let hits = 0
        for (let row = 0; row < SIZE; row += 1) {
            const v = (SIZE - 1 - row) >> 2
            for (let px = 0; px < SIZE; px += 1) {
                const u = px >> 2
                let expected = 0
                for (let k = 0; k < N && expected === 0; k += 1) {
                    const [x, y, z] = at(u, v, k)
                    expected = voxelAt(volume, x, y, z)
                }
                const got = target.id[row * SIZE + px] ?? 0
                if (got !== expected) {
                    throw new Error(
                        `${name}: pixel ${String(px)},${String(row)} (voxel column ${String(u)},${String(v)}) `
                            + `is ${String(got)}, expected ${String(expected)}`
                    )
                }
                if (expected !== 0) hits += 1
            }
        }
        for (let v = 0; v < N; v += 1) {
            for (let u = 0; u < N; u += 1) {
                for (let k = 0; k < N; k += 1) {
                    const [x, y, z] = at(u, v, k)
                    if (voxelAt(volume, x, y, z) !== 0) {
                        columns += 1
                        break
                    }
                }
            }
        }

        // A whole-voxel count, so a single lost column is 16 missing pixels and cannot round away.
        expect(hits).toBe(columns * SCALE * SCALE)
        expect(columns).toBeGreaterThan(N * N * 0.9)

        // An axial view sees exactly one face, and it is the one pointing at the camera.
        const first = target.id.findIndex(value => value !== 0)
        expect(target.normal[first * 4]).toBe(FACE_NORMAL[face * 3])
        expect(target.normal[first * 4 + 1]).toBe(FACE_NORMAL[face * 3 + 1])
        expect(target.normal[first * 4 + 2]).toBe(FACE_NORMAL[face * 3 + 2])
    })
}

test('a top-down view lights the top face and reads the highest voxel', () => {
    const volume = createVolume(4, 4, 4, new Uint8Array(256 * 4))
    volume.palette.set([200, 100, 50, 255], 7 * 4)
    setVoxel(volume, 1, 1, 0, 9)
    setVoxel(volume, 1, 1, 3, 7)

    // Straight down: `right` is +x and `up` is -y, so voxel column (1, 1) lands at pixel (5, 5).
    const camera: Camera = {yaw: 0, pitch: Math.PI / 2, zoom: 4, panX: 0, panY: 0}
    const target = render(volume, basisFor(camera, volume, 16), 16, 16)
    const pixel = 5 * 16 + 5
    const at = pixel * 4

    expect(target.id[pixel]).toBe(7)
    expect(target.normal[at + 2]).toBe(FACE_NORMAL[FACE_Z_POS * 3 + 2])
    const light = FACE_LIGHT[FACE_Z_POS] ?? 0
    expect(target.color[at]).toBe(Math.floor((200 * light) / 256))
    expect(target.color[at + 1]).toBe(Math.floor((100 * light) / 256))
    expect(target.color[at + 2]).toBe(Math.floor((50 * light) / 256))
    expect(target.color[at + 3]).toBe(255)
})

test('a miss writes nothing at all, and every map agrees on where the hits are', () => {
    const volume = testVolume()
    const camera: Camera = {yaw: 0.7, pitch: 0.5, zoom: 40, panX: 0, panY: 0}
    const target = render(volume, basisFor(camera, volume, 64), 64, 64)

    let hits = 0
    for (let i = 0; i < 64 * 64; i += 1) {
        const hit = (target.id[i] ?? 0) !== 0
        expect((target.color[i * 4 + 3] ?? 0) === 255).toBe(hit)
        expect((target.normal[i * 4 + 3] ?? 0) === 255).toBe(hit)
        expect((target.depth[i] ?? 0) > 0).toBe(hit)
        if (hit) hits += 1
    }
    // Zoomed out to 40 voxels over 64 pixels, the model covers part of the frame and not all of it.
    expect(hits).toBeGreaterThan(500)
    expect(hits).toBeLessThan(64 * 64)
})

test('depth grows with distance along the ray', () => {
    const volume = createVolume(8, 8, 8, new Uint8Array(256 * 4))
    volume.palette.set([255, 255, 255, 255], 4)
    setVoxel(volume, 7, 7, 4, 1)
    setVoxel(volume, 0, 0, 4, 1)

    // Looking down -x at one voxel per pixel, so x=7 is the near one and `right` is -y.
    const camera: Camera = {yaw: Math.PI / 2, pitch: 0, zoom: 8, panX: 0, panY: 0}
    const target = render(volume, basisFor(camera, volume, 8), 8, 8)
    const near = target.depth[3 * 8 + 0] ?? 0
    const far = target.depth[3 * 8 + 7] ?? 0

    expect(near).toBeGreaterThan(0)
    expect(far).toBeGreaterThan(near)
})
