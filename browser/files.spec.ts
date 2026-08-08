import {expect, test, type Page} from '@playwright/test'
import {ready, viewport} from './driver'

/**
 * The file menu under a real mouse — `FEATURESET.md` §32 and §36.
 *
 * `bun test` already covers what a document *is* and what Save writes, against a `memoryFiles` disk.
 * What it cannot cover is the part that only exists in a browser, and there are exactly three
 * things here that qualify:
 *
 * 1. **The menu is a portal.** Its items are not in the app's subtree, so nothing about "is the item
 *    there and does it fire" is provable from a reducer.
 * 2. **The picker is native.** `showSaveFilePicker` has no automation surface, so Save is driven
 *    down the download path — which is the path Firefox and Safari always take, and therefore the
 *    one worth proving in a browser rather than the one Chromium prefers.
 * 3. **`beforeunload` is the browser's own dialog.** Whether the page registers it at all is a fact
 *    about the running app.
 *
 * Everything asserted comes back through `src/app/handle.ts`, never off the DOM, so a panel that
 * renders wrongly and a reducer that computes wrongly cannot hide behind each other.
 */
interface DocRead {
    name: string
    dirty: boolean
    savedAt: number | undefined
    size: [number, number, number]
    filled: number
}

const doc = (page: Page): Promise<DocRead> =>
    page.evaluate(() => {
        const {state} = window.goferPixel as unknown as {
            state: {
                doc: {name: string; dirty: boolean; savedAt: number | undefined}
                volume: {data: Uint8Array; sx: number; sy: number; sz: number}
            }
        }
        let filled = 0
        for (const value of state.volume.data) if (value !== 0) filled += 1
        return {
            name: state.doc.name,
            dirty: state.doc.dirty,
            savedAt: state.doc.savedAt,
            size: [state.volume.sx, state.volume.sy, state.volume.sz] as [number, number, number],
            filled
        }
    })

const openMenu = async (page: Page): Promise<void> => {
    await page.getByRole('button', {name: 'Main menu'}).click()
}

test('the file menu is there, and New builds the box its template names', async ({page}) => {
    await ready(page)
    expect(await doc(page)).toMatchObject({name: 'car.vox', dirty: false, savedAt: undefined})

    await openMenu(page)
    // `exact`, because Playwright matches an accessible name by substring otherwise and `Save`
    // would be two items.
    for (const label of ['New project…', 'Open…', 'Save', 'Save As…']) {
        await expect(page.getByRole('menuitem', {name: label, exact: true})).toBeVisible()
    }

    await page.getByRole('menuitem', {name: 'New project…'}).click()
    await expect(page.getByRole('dialog')).toContainText('New project')

    // Scoped to the dialog: the camera panel behind it has `Create 4 directions` on it, and a
    // page-wide `Create` is three buttons.
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('radio', {name: 'Isometric tile'}).click()
    await dialog.getByRole('button', {name: 'Create', exact: true}).click()

    const made = await doc(page)
    expect(made.size).toEqual([32, 32, 16])
    expect(made.filled).toBe(0)
    expect(made.name).toBe('untitled.gpix')
    expect(made.dirty).toBe(false)
    // The header is the artist's only signal, and it has to be reading the same fact.
    await expect(page.locator('.app-header')).toContainText('32 × 32 × 16')
    await expect(page.locator('.app-header')).toContainText('Not saved')
})

/*
 * The most valuable thing a browser can prove about Save, because it is the click that loses work.
 *
 * Headless Chromium *does* have `showSaveFilePicker`, and a native picker has no automation
 * surface — so the call aborts, exactly as it does when a person presses Escape on the dialog.
 * That makes this the cancel case for free, and the cancel case is the one where a Save that
 * reported success would leave an artist believing a file exists that does not.
 *
 * What the picker writes when it is *not* cancelled is `src/doc/files.test.ts`'s job, against
 * `memoryFiles`. There is nothing a browser adds to it.
 */
test('a Save the artist backs out of leaves the document unsaved and says so', async ({page}) => {
    await ready(page)

    const box = await viewport(page)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.up()
    expect((await doc(page)).dirty).toBe(true)
    await expect(page.locator('.app-header')).toContainText('Unsaved changes')

    await openMenu(page)
    await page.getByRole('menuitem', {name: 'Save', exact: true}).click()

    // The menu closes either way, so that is the event that says the click landed.
    await expect(page.getByRole('menuitem', {name: 'Save', exact: true})).toBeHidden()
    expect(await doc(page)).toMatchObject({name: 'car.vox', dirty: true, savedAt: undefined})
    await expect(page.locator('.app-header')).toContainText('Unsaved changes')
})

test('New over unsaved work asks first, and Cancel leaves the model where it was', async ({
    page
}) => {
    await ready(page)
    const box = await viewport(page)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.up()
    const before = await doc(page)
    expect(before.dirty).toBe(true)

    await openMenu(page)
    await page.getByRole('menuitem', {name: 'New project…'}).click()

    await expect(page.getByRole('dialog')).toContainText('unsaved')
    await page.getByRole('button', {name: 'Cancel'}).click()

    const after = await doc(page)
    expect(after.filled).toBe(before.filled)
    expect(after.size).toEqual(before.size)
    expect(after.dirty).toBe(true)
})
