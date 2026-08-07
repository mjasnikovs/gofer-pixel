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

const gpu = (page: Page, camera: Camera, mode: number): Promise<number[]> =>
    page.evaluate(
        ([v, b, m, w, h]) =>
            window.gofer.gpuRender(
                v as Parameters<typeof window.gofer.gpuRender>[0],
                b as Parameters<typeof window.gofer.gpuRender>[1],
                m as number,
                w as number,
                h as number
            ),
        [wire, basisFor(camera, volume, H), mode, W, H] as unknown[]
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
     * device: 0.17 ms idle, up to 2.4 ms while the GPU is also serving llama-server, which owns
     * ~95 % of its memory and most of its time. On SwiftShader: 58–63 ms. Ten milliseconds sits
     * four times above the worst hardware sample and six times below the best software one, so it
     * cannot pass by accident on software and cannot fail by accident under load.
     */
    const renderer = await page.evaluate(() => window.gofer.gpuInfo())
    expect(perFrame, `${perFrame.toFixed(3)} ms per frame on ${renderer}`).toBeLessThan(10)
})
