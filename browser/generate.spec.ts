import {expect, test, type Page} from '@playwright/test'
import {ready} from './driver'

/**
 * The generate dialog under a real mouse — `src/gen/`.
 *
 * `bun test` already covers the ports, the scores and the reducer, against canned servers. Three
 * things here only exist in a browser:
 *
 * 1. **The menu is a portal and the dialog is a `<dialog>`.** Neither is in the app's subtree, so
 *    "does the item open it, and does the pick close it" is not provable from a reducer.
 * 2. **The candidate thumbnails are real canvases.** Under happy-dom `getContext` returns null and
 *    every card renders an empty element that still passes. A card showing nothing is an artist
 *    picking blind, and this is the only place that can be seen.
 * 3. **The two services are `fetch` calls the page makes on its own.** Whether the endpoints the
 *    build ships are the ones it asks for is a fact about the running app.
 *
 * Both services are routed rather than live. Driven against the real llama-server on 2026-08-08 it
 * takes 13 s for two candidates, which is a duration this suite is not allowed to contain — and the
 * model is not deterministic, so what it returned could not be asserted anyway. What was measured
 * that way is written down in `docs/TASKS.md`.
 */
/*
 * The reply is JavaScript, not JSON — see `src/gen/llama.ts`. The op language is y-up and the
 * rasteriser swaps to the z-up `Volume`, so the middle pair is the height.
 *
 * Neither carries a name: the code format has none, so `specFromCode` names the model after the
 * prompt and both candidates come back called "a stone tower". They are told apart by how solid
 * they are, which is what the built-in score sorts on anyway.
 */
const TOWER = `box(2,0,2, 9,19,9, '#8a8f98')
erase(4,6,4, 7,19,7)
box(1,18,1, 10,19,10, '#4a4f57')`

const BRICK = "box(0,0,0, 11,19,11, '#808080')"

/** llama-server and clipserve, as far as the page can tell. */
const stub = async (page: Page, {clip = true}: {clip?: boolean} = {}): Promise<string[]> => {
    const asked: string[] = []
    let next = 0
    await page.route('http://localhost:8080/**', async route => {
        asked.push(route.request().url())
        if (route.request().url().endsWith('/v1/models')) {
            await route.fulfill({json: {data: [{id: 'stub-27b'}]}})
            return
        }
        /*
         * The example pick is a chat call too — once per batch, before any candidate — and it must
         * not eat a canned reply, or every candidate comes back as the one after it. It is told
         * apart by its token budget: a short list of ids against 4096.
         */
        const sent = route.request().postDataJSON() as {max_tokens?: number}
        if (sent.max_tokens === 32) {
            await route.fulfill({json: {choices: [{message: {content: 'tower'}}]}})
            return
        }
        const reply = next % 2 === 0 ? TOWER : BRICK
        next += 1
        await route.fulfill({
            json: {model: 'stub-27b', choices: [{message: {content: reply}}]}
        })
    })
    await page.route('http://127.0.0.1:8765/**', async route => {
        asked.push(route.request().url())
        if (!clip) {
            await route.abort('connectionrefused')
            return
        }
        if (route.request().url().endsWith('/health')) {
            await route.fulfill({json: {ok: true}})
            return
        }
        // The brick is second in the batch, and CLIP is told it is the better of the two.
        const body = route.request().postDataJSON() as {candidates: string[][]}
        await route.fulfill({json: {scores: body.candidates.map((_, i) => (i === 1 ? 0.4 : 0.3))}})
    })
    return asked
}

const openDialog = async (page: Page): Promise<void> => {
    await page.getByRole('button', {name: 'Main menu'}).click()
    await page.getByRole('menuitem', {name: 'Generate a model…'}).click()
}

const dialogOf = (page: Page) => page.locator('[data-testid="generate-dialog"]')

test('the menu opens the dialog, and it asks the local server what it is running', async ({
    page
}) => {
    await ready(page)
    const asked = await stub(page)

    await openDialog(page)
    const dialog = dialogOf(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-testid="generate-status"]')).toContainText('stub-27b')

    // Only the probe: opening the dialog must not spend a minute of somebody's GPU by itself.
    // React's dev build mounts effects twice, so the count is not the assertion — the URL is.
    expect(new Set(asked)).toEqual(new Set(['http://localhost:8080/v1/models']))
})

test('a batch draws real pixels on every card, and picking one replaces the document', async ({
    page
}) => {
    await ready(page)
    await stub(page, {clip: false})
    await openDialog(page)

    const dialog = dialogOf(page)
    await dialog.getByLabel('Candidates').fill('2')
    await dialog.getByRole('button', {name: 'Generate', exact: true}).click()
    await expect(dialog.locator('[data-testid="generate-status"]')).toContainText('2 candidates')

    const cards = dialog.locator('.generate-card')
    await expect(cards).toHaveCount(2)

    /*
     * Every thumbnail, not the first: a cache keyed on the wrong thing would draw one candidate
     * twice, and one card checked would not see it.
     */
    const drawn = await cards.evaluateAll((nodes: Element[]) =>
        nodes.map(node => {
            const canvas = node.querySelector('canvas')
            const context = canvas?.getContext('2d')
            if (!canvas || !context) return {opaque: 0, hash: 0}
            const {data} = context.getImageData(0, 0, canvas.width, canvas.height)
            let opaque = 0
            let hash = 0
            for (let i = 0; i < data.length; i += 4) {
                if ((data[i + 3] ?? 0) > 0) opaque += 1
                hash = (hash * 31 + (data[i] ?? 0)) | 0
            }
            return {opaque, hash}
        })
    )
    expect(drawn.every(({opaque}) => opaque > 100)).toBe(true)
    expect(drawn[0]?.hash).not.toBe(drawn[1]?.hash)

    // The built-in order sinks the solid brick, so the primary button is the carved one.
    await expect(cards.nth(0)).not.toContainText('solid 100%')
    await cards.nth(0).getByRole('button', {name: 'Use this one'}).click()
    await expect(dialog).toBeHidden()

    const after = await page.evaluate(() => {
        const {state} = window.goferPixel as unknown as {
            state: {
                doc: {name: string; dirty: boolean}
                origin: {prompt: string; model: string; sampler: {seed: number}} | undefined
                volume: {data: Uint8Array; sx: number; sy: number; sz: number}
            }
        }
        let filled = 0
        for (const value of state.volume.data) if (value !== 0) filled += 1
        return {
            doc: state.doc,
            origin: state.origin,
            size: [state.volume.sx, state.volume.sz],
            filled
        }
    })

    // The default canvas is 32³ and the document *is* the canvas — `src/gen/ask.ts`. The tower's
    // ops span x 1-10 and y 0-19, so it is 10 wide and 20 tall inside a box with room around it.
    expect(after.size).toEqual([32, 32])
    expect(after.filled).toBeGreaterThan(0)
    expect(after.doc).toMatchObject({name: 'a stone tower', dirty: true})
    expect(after.origin?.model).toBe('stub-27b')
    expect(after.origin?.sampler.seed).toBeGreaterThan(0)
})

test('CLIP reorders the grid when the service answers, and says so', async ({page}) => {
    await ready(page)
    await stub(page, {clip: true})
    await openDialog(page)

    const dialog = dialogOf(page)
    await dialog.getByLabel('Candidates').fill('2')
    await dialog.getByRole('button', {name: 'Generate', exact: true}).click()
    await expect(dialog.locator('[data-testid="clip-status"]')).toContainText('2 ranked')

    // The built-in order put the solid brick last. CLIP disagrees, and CLIP is what is on screen.
    await expect(dialog.locator('.generate-card').nth(0)).toContainText('solid 100%')
    await dialog.getByRole('radio', {name: 'Built-in'}).click()
    await expect(dialog.locator('.generate-card').nth(0)).not.toContainText('solid 100%')
})

test('Enter starts a batch, and empty slots stand in for the candidates still coming', async ({
    page
}) => {
    await ready(page)

    /*
     * The first candidate is held open until this test lets it go. Not a wait — nothing here sleeps
     * — it is a request that has not been answered yet, which is the only state in which the
     * placeholders exist at all.
     */
    let release: (() => void) | undefined
    const held = new Promise<void>(resolve => {
        release = resolve
    })
    let asked = 0
    await page.route('http://localhost:8080/**', async route => {
        if (route.request().url().endsWith('/v1/models')) {
            await route.fulfill({json: {data: [{id: 'stub-27b'}]}})
            return
        }
        const sent = route.request().postDataJSON() as {max_tokens?: number}
        if (sent.max_tokens === 32) {
            await route.fulfill({json: {choices: [{message: {content: 'tower'}}]}})
            return
        }
        asked += 1
        if (asked === 1) await held
        await route.fulfill({json: {model: 'stub-27b', choices: [{message: {content: TOWER}}]}})
    })
    await page.route('http://127.0.0.1:8765/**', route => route.abort('connectionrefused'))

    await openDialog(page)
    const dialog = dialogOf(page)
    await dialog.getByLabel('Candidates').fill('2')

    // A real key in a real field. The button is never touched.
    await dialog.getByLabel('Prompt').click()
    await page.keyboard.press('Enter')

    // Nothing has come back, so the grid is two empty slots rather than an empty box.
    await expect(dialog.locator('[data-testid="generate-pending"]')).toHaveCount(2)
    await expect(dialog.locator('.generate-card:not(.generate-pending)')).toHaveCount(0)

    release?.()

    await expect(dialog.locator('.generate-card:not(.generate-pending)')).toHaveCount(2)
    await expect(dialog.locator('[data-testid="generate-pending"]')).toHaveCount(0)
})

test('Escape closes the dialog, because a modal that only shuts one way is a trap', async ({
    page
}) => {
    await ready(page)
    await stub(page)
    await openDialog(page)

    const dialog = dialogOf(page)
    await expect(dialog).toBeVisible()
    // A real key on a real `<dialog>`. Dispatching one at a portalled node under happy-dom is the
    // synthesised input `docs/VALIDATE.md` exists to refuse — and doing it there also left enough
    // behind to break the next test file.
    await page.keyboard.press('Escape')

    await expect(dialog).toBeHidden()
})

/**
 * The bank directory is really bundled, and a `.vox` in it really becomes an example.
 *
 * This cannot be proved outside a browser, and it is not a hypothetical: on 2026-08-09 the loader
 * guarded its `import.meta.glob` with `typeof import.meta.glob === 'function'`, which is `false` in
 * the browser too — Vite *replaces the call expression* rather than defining a function — so the
 * bank silently loaded nothing and every entry fell back to its built-in reply. `bun test` saw
 * green, because `bun test` reaches the same fallback by design.
 *
 * `car.vox` is in `src/assets/examples/` as this test's fixture and is deliberately not in
 * `examples.json`: a car is 6 tall and would fail the height check every shipped example passes.
 */
test('a model in the bank directory is bundled, and decomposes into an example', async ({page}) => {
    await ready(page)

    const built = await page.evaluate(async () => {
        // The specifier is a variable so that `tsc` does not try to resolve a dev-server URL
        // against the filesystem. Vite serves these paths as modules; nothing else can.
        const bring = async (path: string): Promise<Record<string, unknown>> =>
            (await import(path)) as Record<string, unknown>
        const module = (await bring('/src/gen/library.ts')) as unknown as {
            bundledSource: (
                decode: (name: string, bytes: Uint8Array) => unknown
            ) => (file: string) => Promise<unknown>
        }
        const decompose = (await bring('/src/gen/decompose.ts')) as unknown as {
            decompose: (volume: unknown, name: string) => {ops: unknown[]}
            opsToCode: (spec: unknown, headline: string) => string
        }
        const models = (await bring('/src/doc/models.ts')) as unknown as {
            volumeFromFile: (name: string, bytes: Uint8Array) => unknown
        }
        const volume = await module.bundledSource(models.volumeFromFile)('car.vox')
        if (!volume) return {found: false, ops: 0, code: ''}
        const spec = decompose.decompose(volume, 'a car')
        return {found: true, ops: spec.ops.length, code: decompose.opsToCode(spec, 'car')}
    })

    // Found through the glob, decoded, and taken apart into boxes rather than one per voxel.
    expect(built.found).toBe(true)
    expect(built.ops).toBeGreaterThan(0)
    expect(built.ops).toBeLessThan(50)
    expect(built.code).toContain('box(')
    expect(built.code).toContain("c1 = '#")
})

/** Every shipped entry resolves to a reply in the running app, not just under `bun test`. */
test('the shipped bank loads in the browser, and every entry teaches something', async ({page}) => {
    await ready(page)

    const bank = await page.evaluate(async () => {
        const bring = async (path: string): Promise<Record<string, unknown>> =>
            (await import(path)) as Record<string, unknown>
        const module = (await bring('/src/gen/library.ts')) as unknown as {
            defaultLibrary: () => Promise<{
                manifest: {entries: {id: string}[]}
                example: (id: string) => {reply: string} | undefined
            }>
        }
        const library = await module.defaultLibrary()
        return library.manifest.entries.map(entry => ({
            id: entry.id,
            lines: library.example(entry.id)?.reply.split('\n').length ?? 0
        }))
    })

    expect(bank.length).toBeGreaterThan(0)
    for (const entry of bank) {
        expect(entry.lines).toBeGreaterThan(1)
        expect(entry.lines).toBeLessThanOrEqual(80)
    }
})

/*
 * The canvas and the palette, in the running app — `gen/ask.ts`.
 *
 * `bun test` proves the placement and the snap against canned ports, which is where those belong.
 * What only a browser can answer is whether the two controls the artist actually presses reach
 * them: a segmented control and a switch inside a `<dialog>` portal, over the real reducer.
 */
test('the canvas control decides the document, and Off gives the fitted model back', async ({
    page
}) => {
    await ready(page)
    await stub(page, {clip: false})
    await openDialog(page)

    const dialog = dialogOf(page)
    await dialog.getByLabel('Candidates').fill('1')
    await dialog.getByRole('radio', {name: 'Off'}).click()
    await dialog.getByRole('button', {name: 'Generate', exact: true}).click()
    await expect(dialog.locator('[data-testid="generate-status"]')).toContainText('1 candidates')
    await dialog.locator('.generate-card').first().getByRole('button').click()

    const fitted = await page.evaluate(() => {
        const {state} = window.goferPixel as unknown as {
            state: {volume: {sx: number; sz: number}; origin: {canvas?: number} | undefined}
        }
        return {size: [state.volume.sx, state.volume.sz], canvas: state.origin?.canvas}
    })

    // The tower's ops span x 1-10 and y 0-19, so with the canvas off the grid is fitted to them.
    expect(fitted.size).toEqual([10, 20])
    expect(fitted.canvas).toBeUndefined()
})

test('the palette switch decides whether a candidate may invent colours', async ({page}) => {
    await ready(page)
    await stub(page, {clip: false})
    await openDialog(page)

    const dialog = dialogOf(page)
    await dialog.getByLabel('Candidates').fill('1')
    await dialog.getByRole('button', {name: 'Generate', exact: true}).click()
    await expect(dialog.locator('[data-testid="generate-status"]')).toContainText('1 candidates')
    await dialog.locator('.generate-card').first().getByRole('button').click()

    /*
     * The stub tower paints `#8a8f98` and `#4a4f57`, neither of which is in DB32. On, every voxel
     * carries a palette entry the document opened with — the whole palette is adopted, so the
     * comparison is against the document that was open before the pick.
     */
    const held = await page.evaluate(() => {
        const {state} = window.goferPixel as unknown as {
            state: {volume: {data: Uint8Array; palette: Uint8Array}}
        }
        const hex = (index: number): string =>
            [0, 1, 2]
                .map(at =>
                    (state.volume.palette[index * 4 + at] ?? 0).toString(16).padStart(2, '0')
                )
                .join('')
        return [...new Set(state.volume.data)].filter(value => value !== 0).map(hex)
    })

    expect(held.length).toBeGreaterThan(0)
    expect(held).not.toContain('8a8f98')
    expect(held).not.toContain('4a4f57')
})

/*
 * The dialog scrolls; the grid inside it does not.
 *
 * The candidate grid used to be `max-height: 52vh; overflow-y: auto`, so on any window the pictures
 * moved inside a dialog that stayed still — a scrollbar around the one thing the artist is looking
 * at, with the prompt and the switches pinned around it. Astryx's wrapper is `overflow: hidden`
 * under a 75vh cap, which is why the workaround was there at all; the scroll belongs on the wrapper.
 *
 * A short window and twelve candidates, because a tall screen fits the lot and hides both defects.
 */
test('a twelve-candidate batch scrolls the dialog, not the grid', async ({page}) => {
    await page.setViewportSize({width: 1280, height: 720})
    await ready(page)
    await stub(page, {clip: false})
    await openDialog(page)

    const dialog = dialogOf(page)
    await dialog.getByLabel('Candidates').fill('12')
    await dialog.getByRole('button', {name: 'Generate', exact: true}).click()
    await expect(dialog.locator('[data-testid="generate-status"]')).toContainText('12 candidates')

    const boxes = await page.evaluate(() => {
        const grid = document.querySelector('.generate-grid')
        // Reached from the grid, not by selector: astryx leaves collapsed `.astryx-dialog` nodes on
        // the page, and a query would measure one of those instead of the box on screen.
        const wrapper = grid?.closest('.astryx-dialog')?.firstElementChild
        if (!grid || !wrapper) return undefined
        return {
            gridOverflows: grid.scrollHeight > grid.clientHeight,
            wrapperScrolls: wrapper.scrollHeight > wrapper.clientHeight,
            wrapperOverflow: getComputedStyle(wrapper).overflowY
        }
    })
    expect(boxes).toEqual({
        gridOverflows: false,
        wrapperScrolls: true,
        wrapperOverflow: 'auto'
    })

    // And the twelfth card is reachable, which is the whole reason the old cap existed.
    const cards = dialog.locator('.generate-card')
    await expect(cards).toHaveCount(12)
    await cards.nth(11).scrollIntoViewIfNeeded()
    await expect(cards.nth(11)).toBeInViewport()
})
