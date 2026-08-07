import {defineConfig, devices} from '@playwright/test'

const PORT = 1431
const BASE_URL = `http://127.0.0.1:${String(PORT)}`

/**
 * The browser suite exists for the handful of things that genuinely cannot happen outside a
 * browser: a real GPU, a real pointer with capture, and real layout boxes. It is separate from
 * `bun run check` on purpose and must never gate it.
 *
 * The ANGLE/Vulkan flags are mandatory, not tuning. Without them headless Chromium falls back to
 * SwiftShader silently and the same draw goes from 1.2 ms to 62 ms — measured, `docs/techstack.md`
 * §2. Do not detect this by reading the renderer string; time a draw.
 */
export default defineConfig({
    testDir: './browser',
    fullyParallel: true,
    /*
     * One browser at a time, and this is not caution — it is the only way the suite is honest here.
     *
     * Both GPUs on this machine sit at ~95 % VRAM with a model loaded (see `CLAUDE.md`), so a
     * second Chromium starting at the same time as the first intermittently fails to bring up a
     * hardware Vulkan device and silently drops to SwiftShader. Measured over eight two-worker
     * runs: five failed, either at 58–63 ms per frame on `SwiftShader driver` or with the viewport
     * reading back an empty canvas. Serially, eight of eight launches got the NVIDIA device.
     *
     * Parallelism would buy about five seconds and cost the suite its meaning: the parity tests
     * exist to prove the shader matches the exporter, and they cannot do that from a driver that
     * only turned up half the time.
     */
    workers: 1,
    reporter: process.env['CI'] === undefined ? [['list']] : [['github']],
    use: {baseURL: BASE_URL},
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                launchOptions: {
                    args: [
                        '--use-angle=vulkan',
                        '--enable-features=Vulkan',
                        '--use-gl=angle',
                        '--ignore-gpu-blocklist',
                        '--enable-gpu-rasterization'
                    ]
                }
            }
        }
    ],
    webServer: {
        command: `bun run vite --port ${String(PORT)} --strictPort --host 127.0.0.1`,
        url: BASE_URL,
        reuseExistingServer: true,
        stdout: 'ignore'
    }
})
