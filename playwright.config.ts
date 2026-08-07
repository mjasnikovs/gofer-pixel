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
    workers: 2,
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
