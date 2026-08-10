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

/**
 * A solid block, with its shell and its inside painted different palette entries.
 *
 * `SHELL` is every cell with a face on the outside of the block; `CORE` is everything the artist
 * can never see. The block is deliberately not a cube and not centred, so a bug that only shows up
 * when `sx`, `sy` and `sz` differ has somewhere to land.
 */
const SHELL = 1
const CORE = 2
const BLOCK = {x0: 3, x1: 20, y0: 2, y1: 6, z0: 2, z1: 10}
const solidBlock = (): Volume => {
    const volume = createVolume(24, 9, 13, new Uint8Array(256 * 4))
    volume.palette.set([200, 200, 200, 255], SHELL * 4)
    volume.palette.set([40, 40, 40, 255], CORE * 4)
    const {x0, x1, y0, y1, z0, z1} = BLOCK
    for (let z = z0; z <= z1; z += 1) {
        for (let y = y0; y <= y1; y += 1) {
            for (let x = x0; x <= x1; x += 1) {
                const onShell = x === x0 || x === x1 || y === y0 || y === y1 || z === z0 || z === z1
                setVoxel(volume, x, y, z, onShell ? SHELL : CORE)
            }
        }
    }
    return volume
}

/**
 * How many pixels of a render show a cell that is buried inside the block.
 *
 * The whole measurement, and it is the reported symptom stated as a number: there is no camera from
 * which a `CORE` cell is the first voxel along the ray, so one such pixel is one layer that did not
 * render. The colour map is read as well as the id, because the two are written from the same hit
 * and a bug that moved one without the other would be worse, not better.
 *
 * The obvious second reading — a face pointing along the ray rather than back down it — is not
 * used, and that is worth writing down: `faces.ts` assigns a face from the axis the DDA stepped
 * along, so the face always points back at the camera whatever the ray walked through. It cannot
 * fail, which makes it a tautology rather than a check.
 */
const buriedPixels = (
    volume: Volume,
    camera: Camera,
    size: number
): {core: number; hits: number} => {
    const target = render(volume, basisFor(camera, volume, size), size, size)
    const core = volume.palette[CORE * 4] ?? 0
    let buried = 0
    let hits = 0
    for (let i = 0; i < size * size; i += 1) {
        const value = target.id[i] ?? 0
        if (value === 0) continue
        hits += 1
        // Every face light is a fraction of 256, so a `CORE` pixel is darker than the darkest
        // `SHELL` one whatever face it was struck on.
        if (value === CORE || (target.color[i * 4] ?? 255) <= core) buried += 1
    }
    return {core: buried, hits}
}

/**
 * The bug this is here for: "the outer layer does not render, and you can see inside the voxels."
 *
 * Reported against the viewport, so the browser suite carries the other half — that the shader and
 * this raycaster draw the running document identically. What is checked here is the algorithm: over
 * a sweep of the whole orbit, no ray may walk through a solid voxel and report the one behind it.
 *
 * The sweep is the point. The existing axial test covers 0/90/180/270°, which is where the last
 * defect of this shape lived; a layer lost at one oblique angle would sit between its four samples
 * and never show. The pitch range stops short of ±π/2 on purpose — straight down is an axial case
 * and it has its own test above.
 */
test('no camera can see inside a solid block: the near layer is never walked through', () => {
    const volume = solidBlock()
    const failures: string[] = []
    let total = 0
    for (let iy = 0; iy < 24; iy += 1) {
        for (let ip = -5; ip <= 5; ip += 1) {
            const camera: Camera = {
                yaw: (iy / 24) * Math.PI * 2,
                pitch: (ip / 5) * 1.3,
                zoom: 30,
                panX: 0,
                panY: 0
            }
            const {core, hits} = buriedPixels(volume, camera, 64)
            total += hits
            if (core > 0) {
                failures.push(
                    `yaw ${camera.yaw.toFixed(3)} pitch ${camera.pitch.toFixed(3)}: `
                        + `${String(core)} pixels show a buried voxel`
                )
            }
        }
    }
    expect(failures.slice(0, 5)).toEqual([])
    // A sweep that rendered nothing would pass every line above.
    expect(total).toBeGreaterThan(24 * 11 * 64 * 64 * 0.15)
})

/**
 * The reported fault, built on purpose, so the sweep above is known to be able to see it.
 *
 * Take the near shell layer away by hand — which is exactly "the outer layer does not render" — and
 * the same measurement fills with buried voxels. A check that only ever returns zero cannot tell a
 * working renderer from a measurement that was never looking.
 */
test('the fault the sweep is watching for, built by hand, is caught', () => {
    // Looking back along `+y`, so the wall removed below is the near one.
    const camera: Camera = {yaw: Math.PI, pitch: 0.35, zoom: 30, panX: 0, panY: 0}
    const volume = solidBlock()
    for (let z = BLOCK.z0; z <= BLOCK.z1; z += 1) {
        for (let x = BLOCK.x0; x <= BLOCK.x1; x += 1) setVoxel(volume, x, BLOCK.y0, z, 0)
    }
    const {core, hits} = buriedPixels(volume, camera, 64)

    expect(hits).toBeGreaterThan(0)
    expect(core).toBeGreaterThan(0)
})
