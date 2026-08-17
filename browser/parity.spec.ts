import {expect, test, type Page} from '@playwright/test'
import {basisFor, type Camera} from '../src/render/camera'
import {
    MODE_AO,
    MODE_COLOR,
    MODE_DEPTH,
    MODE_EMISSION,
    MODE_ID,
    MODE_NORMAL
} from '../src/render/raycast.glsl'
import {FACE_LIGHT} from '../src/render/faces'
import {lightFor} from '../src/render/light'
import {render} from '../src/render/raycast'
import {createVolume, setVoxel, type Volume} from '../src/render/volume'

/**
 * The test the whole architecture rests on.
 *
 * The exporter is TypeScript so that a golden-pixel test needs no browser; that is only allowed
 * to be true if the shader the artist is actually looking at draws the same thing. Written before
 * the viewport, deliberately — if these two ever diverge, the CPU is right by definition and the
 * shader is the bug.
 */

const N = 32
const W = 128
const H = 128

/** A sphere with a bite taken out and a floating cube: as much silhouette edge as fits in 32³. */
const testVolume = (): Volume => {
    const volume = createVolume(N, N, N, new Uint8Array(256 * 4))
    const c = (N - 1) / 2
    for (let z = 0; z < N; z += 1) {
        for (let y = 0; y < N; y += 1) {
            for (let x = 0; x < N; x += 1) {
                const d = Math.hypot(x - c, y - c, z - c)
                const inSphere = d < N * 0.4
                const bite = x > c && y > c && z > c && d < N * 0.32
                const cube = x > 3 && x < 8 && y > 24 && y < 29 && z > 3 && z < 8
                if ((inSphere && !bite) || cube) {
                    setVoxel(volume, x, y, z, 1 + ((x * 5 + y * 3 + z) % 200))
                }
            }
        }
    }
    for (let i = 0; i < 256; i += 1) {
        volume.palette[i * 4] = (i * 13 + 20) % 256
        volume.palette[i * 4 + 1] = (i * 53 + 90) % 256
        volume.palette[i * 4 + 2] = (i * 101 + 160) % 256
        volume.palette[i * 4 + 3] = 255
        // A third of the palette glows, at a strength that is not a round number, so the emission
        // map has both lit and unlit voxels in it and cannot pass by being uniformly black.
        volume.emissive[i] = i % 3 === 0 ? (i * 7 + 40) % 256 : 0
    }
    return volume
}

const volume = testVolume()
const wire = {
    sx: volume.sx,
    sy: volume.sy,
    sz: volume.sz,
    data: Array.from(volume.data),
    palette: Array.from(volume.palette),
    emissive: Array.from(volume.emissive)
}

const CAMERAS: {name: string; camera: Camera}[] = [
    {name: 'oblique', camera: {yaw: 0.7, pitch: 0.5, zoom: N, panX: 0, panY: 0}},
    {
        name: 'isometric',
        camera: {yaw: Math.PI / 4, pitch: Math.atan(Math.SQRT1_2), zoom: N, panX: 0, panY: 0}
    },
    {name: 'axis-aligned front', camera: {yaw: 0, pitch: 0, zoom: N, panX: 0, panY: 0}},
    {name: 'axis-aligned side', camera: {yaw: Math.PI / 2, pitch: 0, zoom: N, panX: 0, panY: 0}},
    {
        name: 'arbitrary',
        camera: {yaw: 1.234567, pitch: 0.345678, zoom: N * 1.3, panX: 2.5, panY: -1.5}
    }
]

const gpu = (page: Page, camera: Camera, mode: number, edges = false): Promise<number[]> =>
    page.evaluate(
        ([v, b, m, w, h, e]) =>
            window.gofer.gpuRender(
                v as Parameters<typeof window.gofer.gpuRender>[0],
                b as Parameters<typeof window.gofer.gpuRender>[1],
                m as number,
                w as number,
                h as number,
                e as boolean
            ),
        [wire, basisFor(camera, volume, H), mode, W, H, edges] as unknown[]
    )

for (const {name, camera} of CAMERAS) {
    test(`the shader matches the CPU raycast — ${name}`, async ({page}) => {
        await page.goto('/browser/harness.html')
        const cpu = render(volume, basisFor(camera, volume, H), W, H)

        const [colour, normal, depth, ids, ao, emission] = await Promise.all([
            gpu(page, camera, MODE_COLOR),
            gpu(page, camera, MODE_NORMAL),
            gpu(page, camera, MODE_DEPTH),
            gpu(page, camera, MODE_ID),
            gpu(page, camera, MODE_AO),
            gpu(page, camera, MODE_EMISSION)
        ])

        let opaque = 0
        let colourDiffers = 0
        let normalDiffers = 0
        let idDiffers = 0
        let emissionDiffers = 0
        let worstDepth = 0
        let worstAo = 0
        let litPixels = 0
        for (let row = 0; row < H; row += 1) {
            for (let px = 0; px < W; px += 1) {
                const here = row * W + px
                // The framebuffer's row 0 is the bottom; a RenderTarget's row 0 is the top.
                const there = (H - 1 - row) * W + px
                if ((cpu.id[here] ?? 0) !== 0) opaque += 1
                for (let byte = 0; byte < 4; byte += 1) {
                    if (cpu.color[here * 4 + byte] !== colour[there * 4 + byte]) colourDiffers += 1
                    if (cpu.normal[here * 4 + byte] !== normal[there * 4 + byte]) normalDiffers += 1
                }
                if ((cpu.id[here] ?? 0) !== ids[there * 4]) idDiffers += 1
                const theirs = (depth[there * 4] ?? 0) * 256 + (depth[there * 4 + 1] ?? 0)
                worstDepth = Math.max(worstDepth, Math.abs((cpu.depth[here] ?? 0) - theirs))
                worstAo = Math.max(worstAo, Math.abs((cpu.ao[here] ?? 0) - (ao[there * 4] ?? 0)))
                for (let byte = 0; byte < 3; byte += 1) {
                    if (cpu.emission[here * 4 + byte] !== emission[there * 4 + byte]) {
                        emissionDiffers += 1
                    }
                }
                if ((cpu.emission[here * 4] ?? 0) > 0) litPixels += 1
            }
        }

        // A camera that renders nothing would pass every comparison below.
        expect(opaque).toBeGreaterThan(W * H * 0.1)
        expect(
            colourDiffers,
            `colour differences on ${await page.evaluate(() => window.gofer.gpuInfo())}`
        ).toBe(0)
        expect(normalDiffers).toBe(0)
        expect(idDiffers).toBe(0)
        // Depth is the one map with a rounding step in it: 1/65535 is 0.003 of a voxel.
        expect(worstDepth).toBeLessThanOrEqual(1)
        expect(emissionDiffers).toBe(0)
        // A model where nothing glows would pass the emission comparison by being blank.
        expect(litPixels).toBeGreaterThan(100)
        /*
         * Occlusion is the second map with a rounding step, and a coarser one: it interpolates
         * between four corner levels using where inside the cell the ray struck, which is a float
         * the two backends compute at different widths. One level is 85, so a tolerance of 2 is
         * 2.4 % of a step — it cannot hide a corner counted differently, which is what would
         * actually be wrong.
         */
        /*
         * Occlusion is the one comparison that is legitimately driver-dependent: it interpolates
         * between four integer corner levels using where inside the cell the ray struck, and that
         * position is a float the two backends compute at different widths.
         *
         * Measured worst difference on the hardware device: 1, on every camera, over nine runs.
         * The bound is 8 because the failure it has to catch is a corner *counted* differently,
         * and one level is 85 — so it sits ten times below a real fault and eight times above the
         * measured noise. The renderer goes in the message because Chromium here drops to
         * SwiftShader intermittently without saying so, and a bare number would not tell anyone.
         */
        const renderer = await page.evaluate(() => window.gofer.gpuInfo())
        expect(worstAo, `worst occlusion difference on ${renderer}`).toBeLessThanOrEqual(8)
    })
}

/*
 * The one thing the shader draws that the CPU raycaster does not.
 *
 * The lattice is viewport decoration and exports nothing, so it lives behind `uEdges` and every
 * call above leaves it off — that default is what the parity tests are silently relying on, and
 * this test is what makes the reliance visible. It also checks the shape of the effect: lines on a
 * minority of the model, with the silhouette untouched, rather than a wash over everything.
 */
test('the voxel lattice draws lines on the faces and leaves the silhouette alone', async ({
    page
}) => {
    await page.goto('/browser/harness.html')
    // Ten pixels to the voxel. The effect deliberately fades out below six, where a line per cell
    // stops being a lattice, so a camera at the parity zoom of four would show nothing at all.
    const camera: Camera = {yaw: 0.7, pitch: 0.5, zoom: 12, panX: 0, panY: 0}
    // One after the other, not `Promise.all`. These two draws differ only by the flag, so they go
    // to the same context and read back the same buffer — overlapped, the second frame lands
    // before the first one's `readPixels`, both sides come back identical, and the test fails
    // saying the lattice drew nothing. Seen once in a full-suite run and never in isolation.
    const plain = await gpu(page, camera, MODE_COLOR)
    const lined = await gpu(page, camera, MODE_COLOR, true)

    let opaque = 0
    let silhouetteDiffers = 0
    let inked = 0
    for (let i = 0; i < W * H; i += 1) {
        const alpha = plain[i * 4 + 3] ?? 0
        if (alpha !== (lined[i * 4 + 3] ?? 0)) silhouetteDiffers += 1
        if (alpha === 0) continue
        opaque += 1
        for (let byte = 0; byte < 3; byte += 1) {
            if (plain[i * 4 + byte] !== lined[i * 4 + byte]) {
                inked += 1
                break
            }
        }
    }

    expect(opaque).toBeGreaterThan(W * H * 0.1)
    // Turning it on must not move a single edge of the model — it shades, it does not reshape.
    expect(silhouetteDiffers).toBe(0)
    expect(inked).toBeGreaterThan(opaque * 0.05)
    expect(inked).toBeLessThan(opaque * 0.5)
})

test('the GPU is the GPU — a 512x512 frame through 32³ costs a fraction of a millisecond', async ({
    page
}) => {
    await page.goto('/browser/harness.html')
    const {camera} = CAMERAS[0] ?? {camera: {yaw: 0, pitch: 0, zoom: N, panX: 0, panY: 0}}
    const basis = basisFor(camera, volume, 512)
    await page.evaluate(
        ([v, b]) =>
            window.gofer.gpuRender(
                v as Parameters<typeof window.gofer.gpuRender>[0],
                b as Parameters<typeof window.gofer.gpuRender>[1],
                0,
                512,
                512
            ),
        [wire, basis] as unknown[]
    )
    const perFrame = await page.evaluate(
        ([b]) => window.gofer.gpuFrameMs(b as Parameters<typeof window.gofer.gpuFrameMs>[0], 0, 60),
        [basis] as unknown[]
    )

    /*
     * Which renderer is really running, decided by timing a draw rather than by reading the
     * renderer string — WebKit lies about that on this machine and reports "Apple GPU" on an
     * NVIDIA box. The string goes in the failure message only.
     *
     * The bound separates two measured populations, not one number from a guess. On the hardware
     * device: 0.17 ms idle, up to 2.4 ms while the GPU is also serving something else, which owns
     * ~95 % of its memory and most of its time. On SwiftShader: 58–63 ms. Ten milliseconds sits
     * four times above the worst hardware sample and six times below the best software one, so it
     * cannot pass by accident on software and cannot fail by accident under load.
     */
    const renderer = await page.evaluate(() => window.gofer.gpuInfo())
    expect(perFrame, `${perFrame.toFixed(3)} ms per frame on ${renderer}`).toBeLessThan(10)
})

/**
 * The other half of "the outer layer does not render, and you can see inside the voxels."
 *
 * `raycast.test.ts` sweeps the orbit and proves the algorithm never walks through a solid voxel.
 * That is a claim about a function; the artist's claim is about the window. Everything between the
 * two is what this covers — the volume the app actually uploaded, at the camera the app actually
 * holds, into the canvas at the size the layout actually gave it.
 *
 * The block is painted so that seeing inside it is a colour rather than an inference: the shell is
 * light, the core is darker than the darkest lit shell face, so one dark pixel is one layer that
 * did not draw. The comparison against the CPU raycast is the stronger statement and comes first;
 * the buried count is what names the fault when it fails.
 *
 * The lattice goes off for the duration. It is the one thing the shader draws that the exporter
 * does not, so with it on the two pictures are *supposed* to differ.
 */
test('the running viewport shows no voxel that is buried inside a solid block', async ({page}) => {
    const N2 = 16
    const block = createVolume(N2, N2, N2, new Uint8Array(256 * 4))
    block.palette.set([200, 200, 200, 255], 1 * 4)
    block.palette.set([40, 40, 40, 255], 2 * 4)
    const lo = 3
    const hi = 12
    for (let z = lo; z <= hi; z += 1) {
        for (let y = lo; y <= hi; y += 1) {
            for (let x = lo; x <= hi; x += 1) {
                const shell = [x, y, z].some(v => v === lo || v === hi)
                setVoxel(block, x, y, z, shell ? 1 : 2)
            }
        }
    }

    await page.addInitScript(() => {
        try {
            localStorage.clear()
        } catch {
            // No store in this context, which is the state the clear was after anyway.
        }
    })
    await page.goto('/')
    await page.evaluate(() => window.goferPixel.firstFrame)

    await page.evaluate(
        ([size, data, palette]) => {
            const grid = new Uint8Array(data as number[])
            window.goferPixel.dispatch({
                type: 'open',
                document: {
                    name: 'block',
                    volume: {
                        sx: size as number,
                        sy: size as number,
                        sz: size as number,
                        data: grid,
                        palette: new Uint8Array(palette as number[]),
                        emissive: new Uint8Array(256),
                        owner: new Uint8Array(grid.length)
                    },
                    objects: {list: [], active: 0},
                    cameras: [],
                    references: [],
                    symmetry: undefined,
                    output: undefined,
                    origin: undefined
                }
            })
        },
        [N2, Array.from(block.data), Array.from(block.palette)] as unknown[]
    )

    const view = await page.evaluate(() => {
        const canvas = document.querySelector('.viewport canvas')
        if (!(canvas instanceof HTMLCanvasElement)) throw new Error('no viewport canvas')
        const {state} = window.goferPixel as unknown as {state: {orbit: {camera: Camera}}}
        return {camera: state.orbit.camera, width: canvas.width, height: canvas.height}
    })
    // The same call `Viewport.tsx` makes, at the size the layout gave the canvas.
    const basis = basisFor(view.camera, block, view.height)
    const shown = await page.evaluate(
        async ([b]) => {
            const h = window.goferPixel as unknown as {
                raycaster: {
                    renderNow: (b: unknown, m?: number, e?: boolean) => Promise<number>
                    readPixels: () => Uint8Array
                }
            }
            await h.raycaster.renderNow(b, 0, false)
            return Array.from(h.raycaster.readPixels())
        },
        [basis] as unknown[]
    )

    const cpu = render(block, basis, view.width, view.height)
    let opaque = 0
    let differs = 0
    let buried = 0
    for (let row = 0; row < view.height; row += 1) {
        for (let px = 0; px < view.width; px += 1) {
            const here = row * view.width + px
            // The framebuffer's row 0 is the bottom; a RenderTarget's row 0 is the top.
            const there = (view.height - 1 - row) * view.width + px
            if ((shown[there * 4 + 3] ?? 0) === 0) continue
            opaque += 1
            for (let byte = 0; byte < 4; byte += 1) {
                if (cpu.color[here * 4 + byte] !== shown[there * 4 + byte]) {
                    differs += 1
                    break
                }
            }
            // 40 is the core's own colour, and the darkest a lit shell face can be is 75.
            if ((shown[there * 4] ?? 255) <= 40) buried += 1
        }
    }

    expect(opaque).toBeGreaterThan(view.width * view.height * 0.05)
    expect(buried).toBe(0)
    expect(differs).toBe(0)
})

/**
 * A sun agrees on both backends, byte for byte — see `src/render/light.ts`.
 *
 * The sun is viewport-only, so **the GPU is the only backend that ever draws one for real**. This
 * test is what stops that being a place the shader can quietly go wrong: the light stopped being
 * baked into this shader's source and became a uniform, and a uniform is a new way for the two to
 * disagree. The CPU multiplies by a `Uint16Array` and the GPU by a `float[7]` it was handed, which
 * is exact only because the table is whole numbers over 256 — and this is where that claim meets a
 * real driver.
 *
 * Deliberately not overhead and deliberately not a round strength, so every one of the six faces
 * takes a different multiplier and none of them lands on 0 or 256.
 */
test('the shader matches the CPU raycast with a sun on', async ({page}) => {
    await page.goto('/browser/harness.html')
    const camera: Camera = {yaw: 0.7, pitch: 0.5, zoom: N, panX: 0, panY: 0}
    const light = lightFor({on: true, azimuth: 35, elevation: 55, sun: 0.7, ambient: 0.3})

    // Whichever face it is, the sun changed it. A table that arrived as zeroes would render black
    // on both sides and pass the comparison below.
    expect(Array.from(light).slice(1)).not.toEqual(Array.from(FACE_LIGHT).slice(1))

    const cpu = render(volume, basisFor(camera, volume, H), W, H, undefined, light)
    const colour = await page.evaluate(
        ([v, b, m, w, h, e, l]) =>
            window.gofer.gpuRender(
                v as Parameters<typeof window.gofer.gpuRender>[0],
                b as Parameters<typeof window.gofer.gpuRender>[1],
                m as number,
                w as number,
                h as number,
                e as boolean,
                l as number[]
            ),
        [wire, basisFor(camera, volume, H), MODE_COLOR, W, H, false, Array.from(light)] as unknown[]
    )

    let opaque = 0
    let differs = 0
    for (let row = 0; row < H; row += 1) {
        for (let px = 0; px < W; px += 1) {
            const here = row * W + px
            const there = (H - 1 - row) * W + px
            if ((cpu.id[here] ?? 0) !== 0) opaque += 1
            for (let byte = 0; byte < 4; byte += 1) {
                if (cpu.color[here * 4 + byte] !== colour[there * 4 + byte]) differs += 1
            }
        }
    }

    expect(opaque).toBeGreaterThan(W * H * 0.1)
    const renderer = await page.evaluate(() => window.gofer.gpuInfo())
    expect(differs, `lit colour differences on ${renderer}`).toBe(0)
})
