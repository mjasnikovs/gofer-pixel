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
    state: {
        cameras: unknown[]
        selected: string | undefined
        sheet: {width: number; height: number} | undefined
    }
    dispatch: (action: unknown) => void
    firstFrame: Promise<void>
}

declare global {
    interface Window {
        goferPixel: Handle
    }
}

/**
 * Await the first frame, not the first paint.
 *
 * Waiting for a thumbnail to appear is waiting for the wrong thing: React commits the camera list
 * on its first render, but the viewport cannot draw until a `ResizeObserver` has told it how big it
 * is, which lands a beat later. Reading the canvas at that point returned an empty buffer about one
 * run in five. `firstFrame` is the event that was missing, and adding it was part of the fix.
 */
const ready = async (page: Page): Promise<void> => {
    await page.goto('/')
    await page.evaluate(() => window.goferPixel.firstFrame)
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

    /*
     * The voxel-id view has no control in the window. `docs/editor.png`'s render row is Color /
     * Normal / Depth / AO / Emission, and an extra tab for a mode that is a debugging aid rather
     * than an output map would be chrome the spec does not have — so it is driven through the
     * handle, which is what the handle is for.
     */
    await page.evaluate(() => {
        window.goferPixel.dispatch({type: 'map', map: 5})
    })
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

test('one click bakes the sheet and the export grid carries its pixels', async ({page}) => {
    await ready(page)
    await page.getByRole('button', {name: 'Export sprite sheet'}).click()

    const sheet = await page.evaluate(() => window.goferPixel.state.sheet)
    expect(sheet?.width).toBe(256)
    expect(sheet?.height).toBe(128)

    const sizes = await page
        .locator('canvas.export-sprite')
        .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pixels')))
    expect(sizes).toEqual(Array.from({length: 8}, () => '64x64'))

    // The grid really holds sprites, rather than eight empty canvases of the right size.
    const drawn = await page.evaluate(() => {
        const canvas = document.querySelector('canvas.export-sprite')
        if (!(canvas instanceof HTMLCanvasElement)) return -1
        const context = canvas.getContext('2d')
        if (!context) return -1
        const {data} = context.getImageData(0, 0, canvas.width, canvas.height)
        let count = 0
        for (let i = 3; i < data.length; i += 4) if (data[i] === 255) count += 1
        return count
    })
    expect(drawn).toBeGreaterThan(200)
})

test('exporting writes both PNGs, not just the colour one', async ({page}) => {
    await ready(page)

    /*
     * One listener counting to two, not two `waitForEvent`s — both of those resolve on the *same*
     * first event, so the pair reports the colour sheet twice and the test passes without the
     * normal map ever being written. Subscribed before the click, so nothing can be missed.
     */
    const both = new Promise<string[]>(resolve => {
        const names: string[] = []
        page.on('download', download => {
            names.push(download.suggestedFilename())
            if (names.length === 2) resolve(names)
        })
    })

    await page.getByRole('button', {name: 'Export sprite sheet'}).click()
    expect((await both).sort()).toEqual(['sprites-normal.png', 'sprites.png'])
})
