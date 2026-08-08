import {expect, test, type Page} from '@playwright/test'
import {arm, ready, viewport} from './driver'

/**
 * The Objects panel under a real mouse.
 *
 * It is here rather than in `bun test` for the reason `docs/VALIDATE.md` gives: the reducer tests
 * build their input by hand, so they cannot see a panel that never dispatches what it claims to.
 * Every one of these gestures was measured before the panel was reworked, and four of them failed:
 *
 * | Gesture                        | What it used to do                                          |
 * | ------------------------------ | ----------------------------------------------------------- |
 * | Delete, then Ctrl-Z            | brought the voxels back owned by an id no row named          |
 * | Add, after that undo           | reused the id and silently adopted the orphaned voxels       |
 * | Delete                         | no confirmation, no cost stated                              |
 * | Delete while a filter hid it   | deleted a row nobody could see                               |
 *
 * Everything asserted comes back through `src/app/handle.ts`, never off the DOM, so a panel that
 * renders wrongly and a reducer that computes wrongly cannot hide behind each other.
 */
interface ObjectsRead {
    ids: number[]
    names: string[]
    active: number
    /** Owner id → cells owned. An id here that is not in `ids` is an orphan. */
    owners: Record<string, number>
    undo: number
}

const objects = (page: Page): Promise<ObjectsRead> =>
    page.evaluate(() => {
        const {state} = window.goferPixel as unknown as {
            state: {
                objects: {list: {id: number; name: string}[]; active: number}
                volume: {data: Uint8Array; owner: Uint8Array}
                history: {past: unknown[]}
            }
        }
        const owners: Record<string, number> = {}
        for (let i = 0; i < state.volume.data.length; i += 1) {
            if ((state.volume.data[i] ?? 0) === 0) continue
            const id = String(state.volume.owner[i] ?? 0)
            owners[id] = (owners[id] ?? 0) + 1
        }
        return {
            ids: state.objects.list.map(entry => entry.id),
            names: state.objects.list.map(entry => entry.name),
            active: state.objects.active,
            owners,
            undo: state.history.past.length
        }
    })

/** Ids owning voxels that no row can name. The panel's job is to make this list stay empty. */
const orphans = ({ids, owners}: ObjectsRead): string[] =>
    Object.keys(owners).filter(id => id !== '0' && !ids.includes(Number(id)))

const add = (page: Page): Promise<void> => page.getByRole('button', {name: 'Add an object'}).click()

/** Every switch is a button on the row, so a gesture is one click on a label. */
const press = (page: Page, label: string): Promise<void> =>
    page.getByRole('button', {name: label, exact: true}).click()

/** One voxel into the active object, drawn with the mouse over the middle of the model. */
const draw = async (page: Page): Promise<void> => {
    await arm(page, 'draw')
    const box = await viewport(page)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.up()
}

test('a deleted object comes back whole, list and voxels together', async ({page}) => {
    await ready(page)
    await add(page)
    await draw(page)

    const drawn = await objects(page)
    expect(drawn.ids).toEqual([1, 2])
    expect(drawn.owners['2']).toBe(4)

    // Delete asks first, and says what it is about to cost.
    await press(page, 'Delete Object 2')
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('Delete Object 2?')
    await expect(dialog).toContainText('4 voxels')

    // Cancelling is a real cancel: nothing moves.
    await dialog.getByRole('button', {name: 'Cancel'}).click()
    expect((await objects(page)).ids).toEqual([1, 2])

    await press(page, 'Delete Object 2')
    await page.getByRole('alertdialog').getByRole('button', {name: 'Delete'}).click()
    const gone = await objects(page)
    expect(gone.ids).toEqual([1])
    expect(gone.owners['2']).toBeUndefined()

    // The list comes back with the cells, so nothing is left owned by a name that is not there.
    await page.keyboard.press('Control+z')
    const back = await objects(page)
    expect(back.ids).toEqual([1, 2])
    expect(back.owners['2']).toBe(4)
    expect(orphans(back)).toEqual([])

    // And the next object added is a new one, not a second claim on those four cells.
    await add(page)
    const next = await objects(page)
    expect(next.ids).toEqual([1, 2, 3])
    expect(next.owners[String(next.active)]).toBeUndefined()
})

test('an empty object can be deleted and undone too', async ({page}) => {
    await ready(page)
    await add(page)

    await press(page, 'Delete Object 2')
    // Nothing in it, so the dialog offers no voxel toll — but it still asks.
    await expect(page.getByRole('alertdialog')).toContainText('empty')
    await page.getByRole('alertdialog').getByRole('button', {name: 'Delete'}).click()
    expect((await objects(page)).ids).toEqual([1])

    await page.keyboard.press('Control+z')
    expect((await objects(page)).ids).toEqual([1, 2])
})

test('the last object cannot be deleted, and the button says why', async ({page}) => {
    await ready(page)
    const button = page.getByRole('button', {name: 'Delete Model', exact: true})
    await expect(button).toBeDisabled()
    await expect(button).toHaveAttribute('title', 'A document keeps at least one object')
})

test('a copy stands beside the original, and a full grid says there is no room', async ({page}) => {
    await ready(page)

    // The car fills its grid, so there is nowhere for a copy of it to stand.
    const full = page.getByRole('button', {name: 'Duplicate Model', exact: true})
    await expect(full).toBeDisabled()
    await expect(full).toHaveAttribute('title', 'No room beside Model for a copy')

    // Four voxels in a 16-wide grid have room, so that copy goes through.
    await add(page)
    await draw(page)
    await press(page, 'Duplicate Object 2')

    const copied = await objects(page)
    expect(copied.names).toEqual(['Model', 'Object 2', 'Object 2 copy'])
    expect(copied.owners['3']).toBe(4)
    expect(copied.owners['2']).toBe(4)
    expect(orphans(copied)).toEqual([])

    // One undo takes the name and the cells back together.
    await page.keyboard.press('Control+z')
    const back = await objects(page)
    expect(back.ids).toEqual([1, 2])
    expect(orphans(back)).toEqual([])
})

test('a row renames in place and a row shows what it holds', async ({page}) => {
    await ready(page)
    await add(page)
    await draw(page)

    const rows = page.locator('.object-row')
    await expect(rows.nth(1).locator('.object-count')).toHaveText('4')
    await add(page)
    await expect(rows.nth(2).locator('.object-count')).toHaveText('empty')

    // Double-click the name, type, press Enter. There is no rename box anywhere else.
    await rows.nth(1).getByRole('radio').dblclick()
    await page.getByRole('textbox', {name: 'Rename Object 2'}).fill('Sword')
    await page.keyboard.press('Enter')
    expect((await objects(page)).names).toEqual(['Model', 'Sword', 'Object 3'])
    await expect(page.getByRole('radio', {name: 'Draw into Sword'})).toBeVisible()
})

test('the search box turns up only once the list is long enough to need it', async ({page}) => {
    await ready(page)
    const search = page.getByPlaceholder('Search')
    await expect(search).toHaveCount(0)

    // Nine objects: one from the file, eight added.
    for (let i = 0; i < 8; i += 1) await add(page)
    await expect(search).toHaveCount(1)

    await search.fill('Object 9')
    await expect(page.locator('.object-row')).toHaveCount(1)
})

test('a row drags along the list to reorder it', async ({page}) => {
    await ready(page)
    await add(page)
    await add(page)
    expect((await objects(page)).names).toEqual(['Model', 'Object 2', 'Object 3'])

    const rows = page.locator('.object-row')
    const last = await rows.nth(2).boundingBox()
    const first = await rows.nth(0).boundingBox()
    if (!last || !first) throw new Error('the rows have no boxes')

    await page.mouse.move(last.x + 30, last.y + last.height / 2)
    await page.mouse.down()
    await page.mouse.move(first.x + 30, first.y + first.height / 2, {steps: 6})
    await page.mouse.up()

    expect((await objects(page)).names).toEqual(['Object 3', 'Model', 'Object 2'])
})
