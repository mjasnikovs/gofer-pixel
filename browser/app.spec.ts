import {expect, test, type Page} from '@playwright/test'

/**
 * The four things about the running app that genuinely cannot be checked outside a browser: a real
 * GPU frame, a real pointer with capture, real layout boxes (happy-dom returns zeros from
 * `getBoundingClientRect`), and a clean console.
 *
 * Nothing here waits for a duration. `renderNow` resolves when the frame has landed and every
 * assertion is against a value read straight out of the app, never against a screenshot.
 */

interface Handle {
    raycaster: {frames: number; renderNow: (basis: unknown, mode?: number) => Promise<number>}
    state: {cameras: unknown[]; selected: string | undefined; sheet: unknown}
    dispatch: (action: unknown) => void
}

declare global {
    interface Window {
        goferPixel: Handle
    }
}

const ready = async (page: Page): Promise<void> => {
    await page.goto('/')
    // Not a poll: the locator resolves as soon as React has committed the first render.
    await page.locator('canvas.thumbnail').first().waitFor()
}

const frames = (page: Page): Promise<number> =>
    page.evaluate(() => window.goferPixel.raycaster.frames)

test('the app boots, the viewport draws, and the console stays clean', async ({page}) => {
    const noise: string[] = []
    page.on('console', message => {
        const text = message.text()
        // The driver logs a performance note about the `readPixels` *this test* does to prove the
        // canvas is not empty. It is the harness talking about itself, not the app.
        if (text.includes('GL Driver Message')) return
        if (message.type() === 'error' || message.type() === 'warning') noise.push(text)
    })
    page.on('pageerror', error => noise.push(error.message))

    await ready(page)

    // The canvas has real pixels in it, not a cleared buffer.
    const opaque = await page.evaluate(() => {
        const canvas = document.querySelector('canvas.viewport-canvas')
        if (!(canvas instanceof HTMLCanvasElement)) return -1
        const gl = canvas.getContext('webgl2')
        if (!gl) return -1
        const pixels = new Uint8Array(canvas.width * canvas.height * 4)
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        let count = 0
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] === 255) count += 1
        return count
    })

    expect(opaque).toBeGreaterThan(1000)
    expect(await frames(page)).toBeGreaterThan(0)
    expect(noise).toEqual([])
})

test('a real pointer drag with capture reaches the state machine and lands a frame', async ({
    page
}) => {
    await ready(page)
    const before = await frames(page)
    const box = await page.locator('[data-testid="viewport"]').boundingBox()
    if (!box) throw new Error('the viewport has no box')

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40)
    await page.mouse.up()

    // Dragging away from a stored camera is what clears the selection, so this proves the whole
    // path: browser pointer → orbit gesture → reducer → a new frame on the GPU.
    expect(await page.evaluate(() => window.goferPixel.state.selected)).toBeUndefined()
    expect(await frames(page)).toBeGreaterThan(before)
})

/**
 * The two display-only shader modes. They have no CPU counterpart to compare against — they exist
 * because the exporter's depth and id maps are data rather than pictures — so this is the only
 * place they are checked at all: depth has to be a grey ramp with a spread of values, and the voxel
 * view has to be flat unlit palette colour rather than a red index ramp.
 */
/** Counted in the page: a 930 × 962 frame is 3.6 M numbers, and serialising it costs ten seconds. */
const viewportSummary = (page: Page): Promise<{colours: number; greys: number; notGrey: number}> =>
    page.evaluate(() => {
        const canvas = document.querySelector('canvas.viewport-canvas')
        if (!(canvas instanceof HTMLCanvasElement)) throw new Error('no canvas')
        const gl = canvas.getContext('webgl2')
        if (!gl) throw new Error('no context')
        const pixels = new Uint8Array(canvas.width * canvas.height * 4)
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        const colours = new Set<number>()
        const greys = new Set<number>()
        let notGrey = 0
        for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i + 3] !== 255) continue
            const [r, g, b] = [pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0]
            if (r !== g || g !== b) notGrey += 1
            greys.add(r)
            colours.add((r << 16) | (g << 8) | b)
        }
        return {colours: colours.size, greys: greys.size, notGrey}
    })

test('the depth view is a grey ramp and the voxel view is flat palette colour', async ({page}) => {
    await ready(page)

    await page.getByRole('radio', {name: 'Depth'}).click()
    const depth = await viewportSummary(page)
    expect(depth.notGrey).toBe(0)
    // A flat silhouette would be one value; the striped 16-bit encoding would be hundreds.
    expect(depth.greys).toBeGreaterThan(20)
    expect(depth.greys).toBeLessThan(200)

    await page.getByRole('radio', {name: 'Voxel'}).click()
    const ids = await viewportSummary(page)
    // car.vox has a handful of materials, and no face lighting means one colour per material.
    expect(ids.colours).toBeGreaterThan(1)
    expect(ids.colours).toBeLessThan(12)
})

test('nothing overlaps, nothing is clipped, and nothing overflows the window', async ({page}) => {
    await ready(page)
    const boxes = await page.evaluate(() => {
        const read = (selector: string) => {
            const node = document.querySelector(selector)
            const box = node?.getBoundingClientRect()
            return box ? {x: box.x, y: box.y, width: box.width, height: box.height} : undefined
        }
        return {
            window: {width: window.innerWidth, height: window.innerHeight},
            scrollWidth: document.documentElement.scrollWidth,
            header: read('.app-header'),
            viewport: read('[data-testid="viewport"]'),
            rail: read('.app-rail')
        }
    })

    const {header, viewport, rail, window: frame} = boxes
    if (!header || !viewport || !rail) throw new Error('a region is missing')

    expect(boxes.scrollWidth).toBeLessThanOrEqual(frame.width)
    expect(header.y + header.height).toBeLessThanOrEqual(viewport.y)
    expect(viewport.x + viewport.width).toBeLessThanOrEqual(rail.x)
    expect(rail.x + rail.width).toBeLessThanOrEqual(frame.width)
    expect(viewport.width).toBeGreaterThan(300)
    expect(viewport.height).toBeGreaterThan(200)
})

test('one click produces both sheets, and the canvases carry the exported pixels', async ({
    page
}) => {
    await ready(page)
    await page.getByRole('button', {name: 'Render sprite sheet'}).click()

    const sizes = await page
        .locator('canvas.sheet-canvas')
        .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pixels')))
    expect(sizes).toEqual(['256x128', '256x128'])

    // The preview really holds the sheet, rather than an empty canvas of the right size.
    const drawn = await page.evaluate(() => {
        const canvas = document.querySelector('canvas.sheet-canvas')
        if (!(canvas instanceof HTMLCanvasElement)) return -1
        const context = canvas.getContext('2d')
        if (!context) return -1
        const {data} = context.getImageData(0, 0, canvas.width, canvas.height)
        let count = 0
        for (let i = 3; i < data.length; i += 4) if (data[i] === 255) count += 1
        return count
    })
    expect(drawn).toBeGreaterThan(2000)
})

test('the sheet PNG actually downloads', async ({page}) => {
    await ready(page)
    await page.getByRole('button', {name: 'Render sprite sheet'}).click()

    const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', {name: 'Download sprites.png'}).click()
    ])
    expect(download.suggestedFilename()).toBe('sprites.png')
})
