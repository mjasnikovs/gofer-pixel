import {expect, test, type Page} from '@playwright/test'
import {frames, ready} from './driver'

/**
 * The things about the running app that genuinely cannot be checked outside a browser: a real GPU
 * frame, a real pointer with capture, real layout boxes (happy-dom returns zeros from
 * `getBoundingClientRect`), and a clean console. The nine tools under a real mouse live next door
 * in `gestures.spec.ts`.
 *
 * Nothing here waits for a duration. `renderNow` resolves when the frame has landed and every
 * assertion is against a value read straight out of the app, never against a screenshot.
 */

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

    // The right button orbits, because the left one belongs to whichever tool is armed.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down({button: 'right'})
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40)
    await page.mouse.up({button: 'right'})

    // Dragging away from a stored camera is what clears the selection, so this proves the whole
    // path: browser pointer → orbit gesture → reducer → a new frame on the GPU.
    expect(await page.evaluate(() => window.goferPixel.state.selected)).toBeUndefined()
    expect(await frames(page)).toBeGreaterThan(before)
})

test('a left drag with Draw armed writes voxels and lands them on the GPU', async ({page}) => {
    await ready(page)
    const box = await page.locator('[data-testid="viewport"]').boundingBox()
    if (!box) throw new Error('the viewport has no box')
    const before = await page.evaluate(() => window.goferPixel.state.volume.data.length)
    const filled = (): Promise<number> =>
        page.evaluate(() =>
            window.goferPixel.state.volume.data.reduce(
                (count: number, value: number) => (value === 0 ? count : count + 1),
                0
            )
        )
    const was = await filled()
    const frame = await frames(page)

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 10)
    await page.mouse.up()

    // The grid keeps its shape — a stroke writes cells, it does not resize the document.
    expect(await page.evaluate(() => window.goferPixel.state.volume.data.length)).toBe(before)
    expect(await filled()).toBeGreaterThan(was)
    expect(await page.evaluate(() => window.goferPixel.state.history.past.length)).toBe(1)
    // Real proof it reached the GPU: the texture went up again and a frame landed after it.
    expect(await frames(page)).toBeGreaterThan(frame)

    await page.keyboard.press('Control+z')
    expect(await filled()).toBe(was)
})

/**
 * A real double-click, which is a thing only a browser has.
 *
 * `PointerEvent.detail` is 0 on `pointerdown` by specification, so reading the click count off the
 * event made every double-click a single one — and nothing outside a browser could see it, because
 * the reducer's tests hand the count in and happy-dom never dispatches a pointer press at all. The
 * count is kept in the viewport now, and this is the test that would have caught it.
 */
test('a double-click takes the connected colour, not one voxel', async ({page}) => {
    await ready(page)
    const box = await page.locator('[data-testid="viewport"]').boundingBox()
    if (!box) throw new Error('the viewport has no box')
    const selected = (): Promise<number> =>
        page.evaluate(() => window.goferPixel.state.selection.size)

    await page.evaluate(() => {
        window.goferPixel.dispatch({type: 'tool', tool: 'move'})
    })
    const centre = {x: box.x + box.width / 2, y: box.y + box.height / 2}

    await page.mouse.click(centre.x, centre.y)
    expect(await selected()).toBe(1)

    await page.mouse.dblclick(centre.x, centre.y)
    expect(await selected()).toBeGreaterThan(1)

    /*
     * A press somewhere else is a fresh count, not the third of a run.
     *
     * The offset is a fraction of the viewport rather than pixels, because the viewport grows and
     * shrinks with the panels beside it — a fixed 40 × 24 stopped landing outside the doubled
     * region the moment the objects panel lost a row, and the test failed for a reason that had
     * nothing to do with click counting. Swept: 0.12–0.24 across and 0.08–0.16 down all give a
     * single voxel, so this sits in the middle of that plateau.
     */
    await page.mouse.click(centre.x + box.width * 0.18, centre.y + box.height * 0.12)
    expect(await selected()).toBe(1)
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
        window.goferPixel.dispatch({type: 'chrome', chrome: {map: 7}})
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

/*
 * The export preview is real pixels in a real canvas, which is the one thing happy-dom cannot say
 * anything about: `getContext` returns null there, so every unit test asserts against the buffer
 * rather than against what was painted. This is the test that the buffer reached the screen.
 */
test('the export dialog draws the sheet’s own cells into real canvases', async ({page}) => {
    await ready(page)
    await page.getByRole('button', {name: 'Export', exact: true}).click()

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

    // Switching map switches the pixels, and does not switch the sheet: same size, same count.
    await page.getByRole('button', {name: 'Preview the normal map'}).click()
    expect(
        await page
            .locator('canvas.export-sprite')
            .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pixels')))
    ).toEqual(Array.from({length: 8}, () => '64x64'))
})

/*
 * The pack is the button the artist actually presses, and a `Blob` download is the one part of
 * `Files.write` that has no adapter under it — `memoryFiles` proves the bytes, and only a browser
 * proves they leave.
 */
test('the export pack leaves the browser as one zip', async ({page}) => {
    await ready(page)
    await page.getByRole('button', {name: 'Export', exact: true}).click()

    const landed = page.waitForEvent('download')
    await page.getByRole('button', {name: 'Export pack'}).click()
    expect((await landed).suggestedFilename()).toMatch(/\.zip$/)
})

/**
 * The overlays are SVG in *voxels* and the render behind them is WebGL in pixels, so whether they
 * line up is a layout fact and happy-dom has no layout. It was 35% out at 704 × 520 — the viewBox
 * spanned the width while the renderer fits `camera.zoom` to the height — which put the brush
 * outline a voxel and a half from the face it claimed to be on.
 */
test('the brush outline is drawn at the same scale as the render under it', async ({page}) => {
    await ready(page)
    const box = await page.locator('[data-testid="viewport"]').boundingBox()
    if (!box) throw new Error('the viewport has no box')

    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.42)
    const seen = await page.evaluate(() => {
        const svg = document.querySelector('.brush-ghost')
        const outline = svg?.querySelector('.brush-ghost-outline')
        if (!(svg instanceof SVGSVGElement) || !(outline instanceof SVGPathElement))
            return undefined
        const stage = svg.parentElement?.getBoundingClientRect()
        const matrix = outline.getScreenCTM()
        return {
            drawn: matrix?.a ?? 0,
            expected: (stage?.height ?? 0) / window.goferPixel.state.orbit.camera.zoom,
            outline: outline.getBoundingClientRect()
        }
    })
    if (!seen) throw new Error('the pointer is over the model and the outline is drawn')

    // One voxel on screen is one voxel on screen, to the pixel.
    expect(seen.drawn).toBeCloseTo(seen.expected, 6)
    // And it is under the cursor rather than merely near it: the default brush is 2 × 2, so the
    // outline is at most two voxels across and the pointer is inside it.
    const centre = {x: box.x + box.width / 2, y: box.y + box.height * 0.42}
    expect(seen.outline.left).toBeLessThanOrEqual(centre.x)
    expect(seen.outline.right).toBeGreaterThanOrEqual(centre.x)
    expect(seen.outline.top).toBeLessThanOrEqual(centre.y)
    expect(seen.outline.bottom).toBeGreaterThanOrEqual(centre.y)
})

/**
 * The dev build's Performance track is off, and one query parameter turns it back on.
 *
 * Not a timing test, because the cost it guards against is not a frame: React 19's development
 * build deep-diffs every changed prop, and `Volume` hands down two fresh `Uint8Array`s per edit to
 * about thirty components. One voxel cost 1.2 s on a 32³ document. `src/react-timing.ts` says the
 * rest. What is asserted here is the gate itself, because the gate is read once at import time and
 * a reordered import in `main.tsx` is exactly how this comes back.
 */
test('React 19 dev render logging is off by default and opt-in by flag', async ({page}) => {
    await ready(page)
    expect(await page.evaluate(() => typeof console.timeStamp)).toBe('undefined')

    await page.goto('/?react-track')
    expect(await page.evaluate(() => typeof console.timeStamp)).toBe('function')
})
