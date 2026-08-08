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
const TOWER = {
    name: 'tower',
    size: [12, 12, 20],
    mirror_x: false,
    ops: [
        {op: 'box', from: [2, 2, 0], to: [9, 9, 19], color: '#8a8f98'},
        {op: 'erase', from: [4, 4, 6], to: [7, 7, 19]},
        {op: 'box', from: [1, 1, 18], to: [10, 10, 19], color: '#4a4f57'}
    ]
}

const BRICK = {
    name: 'brick',
    size: [12, 12, 20],
    mirror_x: false,
    ops: [{op: 'box', from: [0, 0, 0], to: [11, 11, 19], color: '#808080'}]
}

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
        const spec = next % 2 === 0 ? TOWER : BRICK
        next += 1
        await route.fulfill({
            json: {model: 'stub-27b', choices: [{message: {content: JSON.stringify(spec)}}]}
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
    await expect(cards.nth(0)).toContainText('tower')
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

    expect(after.size).toEqual([12, 20])
    expect(after.filled).toBeGreaterThan(0)
    expect(after.doc).toMatchObject({name: 'tower', dirty: true})
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

    // The built-in order put the brick last. CLIP disagrees, and CLIP is what is on screen.
    await expect(dialog.locator('.generate-card').nth(0)).toContainText('brick')
    await dialog.getByRole('radio', {name: 'Built-in'}).click()
    await expect(dialog.locator('.generate-card').nth(0)).toContainText('tower')
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
