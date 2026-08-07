import {expect, test, type Page} from '@playwright/test'
import {arm, read, ready, viewport, type Reading} from './driver'

/**
 * Every tool under a real mouse.
 *
 * This file exists because of a bug the 197 reducer tests could not see. `pressSelection` reads
 * `event.clicks` to tell a double-click from a single one, and the viewport was filling that in
 * from `PointerEvent.detail` — which is 0 on `pointerdown` by specification. Double-click had never
 * worked in the app, and could not fail in `bun test`, because those tests build a `ViewportPointer`
 * by hand and hand the count in. The reducer was right and the input layer was lying to it.
 *
 * So the rule for this file: **nothing may be synthesised.** Every gesture is `page.mouse`, the way
 * a hand does it. `dispatch` is allowed only to arm a tool, which is a click on the rail and not
 * the thing under test. Everything asserted is read back out of `src/app/handle.ts`.
 *
 * The claims come from the code, one per tool:
 *
 * | Tool    | A press does                                        | A drag does                    |
 * | ------- | --------------------------------------------------- | ------------------------------ |
 * | Draw    | writes the brush into the cell in front of the face | keeps writing along the plane  |
 * | Erase   | clears the voxel itself                             | keeps clearing                 |
 * | Fill    | recolours the connected region, no stroke           | nothing more                   |
 * | Pick    | loads that voxel's colour, writes nothing           | nothing                        |
 * | Move    | selects — one voxel, or the colour, or the object   | carries the selection          |
 * | Rotate  | the same select                                     | turns it 90°, once per drag    |
 * | Scale   | grabs the face patch under the cursor               | extrudes along the normal      |
 * | Clone   | the same select                                     | leaves a copy behind           |
 * | Measure | nothing — it is not built, so the camera keeps it   | orbits                         |
 *
 * Nothing here waits for a duration. Playwright's mouse calls resolve when the event has been
 * dispatched, and the app is synchronous from there.
 */

/** The middle of the viewport, which is over the model, and a corner, which is over air. */
const spots = async (page: Page): Promise<{on: Point; air: Point}> => {
    const box = await viewport(page)
    return {
        on: {x: box.x + box.width / 2, y: box.y + box.height / 2},
        air: {x: box.x + 8, y: box.y + 8}
    }
}

interface Point {
    x: number
    y: number
}

const press = async (page: Page, from: Point, to?: Point): Promise<void> => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    if (to) await page.mouse.move(to.x, to.y, {steps: 8})
    await page.mouse.up()
}

const shifted = (point: Point, dx: number, dy = 0): Point => ({x: point.x + dx, y: point.y + dy})

const start = async (page: Page, tool: string): Promise<{on: Point; air: Point; was: Reading}> => {
    await ready(page)
    await arm(page, tool)
    const {on, air} = await spots(page)
    return {on, air, was: await read(page)}
}

test('draw writes voxels in front of the surface, and one gesture is one undo step', async ({
    page
}) => {
    const {on, was} = await start(page, 'draw')
    await press(page, on, shifted(on, 30, 12))

    const now = await read(page)
    expect(now.filled).toBeGreaterThan(was.filled)
    expect(now.undo).toBe(1)
    expect(now.stroke).toBe(false)

    await page.keyboard.press('Control+z')
    expect((await read(page)).filled).toBe(was.filled)
})

test('erase takes voxels away rather than adding them', async ({page}) => {
    const {on, was} = await start(page, 'erase')
    await press(page, on, shifted(on, 24, 10))

    const now = await read(page)
    expect(now.filled).toBeLessThan(was.filled)
    expect(now.undo).toBe(1)

    await page.keyboard.press('Control+z')
    expect((await read(page)).filled).toBe(was.filled)
})

test('fill recolours a whole region on one press, and never opens a stroke', async ({page}) => {
    const {on, was} = await start(page, 'fill')
    await press(page, on)

    const now = await read(page)
    // A recolour moves voxels between palette entries. It must not create or destroy any.
    expect(now.filled).toBe(was.filled)
    expect(now.hash).not.toBe(was.hash)
    expect(now.undo).toBe(1)
    expect(now.stroke).toBe(false)
})

test('pick loads the colour under the cursor and writes nothing', async ({page}) => {
    const {on, was} = await start(page, 'pick')
    await press(page, on)

    const now = await read(page)
    expect(now.color).not.toBe(was.color)
    expect(now.hash).toBe(was.hash)
    // Sampling is not an edit, so there is nothing to undo.
    expect(now.undo).toBe(0)
})

test('move selects one voxel on a click and the connected colour on a double-click', async ({
    page
}) => {
    const {on} = await start(page, 'move')

    await page.mouse.click(on.x, on.y)
    expect((await read(page)).selection).toBe(1)

    await page.mouse.dblclick(on.x, on.y)
    expect((await read(page)).selection).toBeGreaterThan(1)

    // Alt takes the whole object, which is more again — or at least as much.
    await page.keyboard.down('Alt')
    await page.mouse.click(on.x, on.y)
    await page.keyboard.up('Alt')
    expect((await read(page)).selection).toBeGreaterThan(1)
})

/**
 * Control adds. A modifier is exactly the kind of claim only a browser settles: the reducer's tests
 * set the flag themselves, so they prove the rule and not the wiring, which is the split that let
 * `PointerEvent.detail` lie for as long as it did.
 */
test('control-click adds to the selection, a plain click replaces it', async ({page}) => {
    const {on} = await start(page, 'move')
    const apart = {x: on.x + 30, y: on.y + 18}

    await page.mouse.click(on.x, on.y)
    expect((await read(page)).selection).toBe(1)

    await page.mouse.click(apart.x, apart.y)
    expect((await read(page)).selection).toBe(1)

    await page.keyboard.down('Control')
    await page.mouse.click(on.x, on.y)
    await page.keyboard.up('Control')
    expect((await read(page)).selection).toBe(2)

    // And it stacks: Control with a double-click adds a whole colour to what is already held.
    await page.keyboard.down('Control')
    await page.mouse.dblclick(on.x, on.y)
    await page.keyboard.up('Control')
    expect((await read(page)).selection).toBeGreaterThan(2)
})

test('a rubber band from empty space takes the surface under it', async ({page}) => {
    const {on, air} = await start(page, 'move')

    await page.mouse.move(air.x, air.y)
    await page.mouse.down()
    await page.mouse.move(on.x, on.y, {steps: 6})
    // The band is live while the button is down, and it is a band rather than a drag of voxels.
    const during = await read(page)
    expect(during.band).toBe(true)
    expect(during.drag).toBeUndefined()

    await page.mouse.move(on.x + 120, on.y + 120, {steps: 6})
    await page.mouse.up()

    const now = await read(page)
    expect(now.band).toBe(false)
    expect(now.selection).toBeGreaterThan(1)
    // Choosing voxels is not editing them.
    expect(now.undo).toBe(0)
})

test('move carries the selection and leaves one undo step behind', async ({page}) => {
    const {on, was} = await start(page, 'move')

    await page.mouse.move(on.x, on.y)
    await page.mouse.down()
    await page.mouse.move(on.x + 24, on.y + 10, {steps: 6})
    expect((await read(page)).drag).toBe('move')
    await page.mouse.up()

    const now = await read(page)
    expect(now.hash).not.toBe(was.hash)
    expect(now.undo).toBe(1)

    await page.keyboard.press('Control+z')
    expect((await read(page)).hash).toBe(was.hash)
})

/**
 * The turn, and the reason it is a ratchet.
 *
 * Counting a quarter per 48 px looked right in the reducer and flickered on the screen: four
 * quarters is the identity and two is the identity for anything symmetric, so a long drag walked
 * the model between two pictures. One drag is one quarter, so every distance past the threshold has
 * to land on the same answer.
 */
test('rotate turns the selection 90° once per drag, however far the hand goes', async ({page}) => {
    const {on} = await start(page, 'move')
    // A single voxel is its own rotation, so there has to be a real selection to turn.
    await page.mouse.dblclick(on.x, on.y)
    await arm(page, 'rotate')
    const held = await read(page)
    expect(held.selection).toBeGreaterThan(1)

    // Under the threshold is not a turn — and must not be a nudge either, which is what the tool
    // used to do: it armed a `move` drag and slid the voxels sideways like Move.
    await press(page, on, shifted(on, 20))
    expect((await read(page)).hash).toBe(held.hash)

    const answers: number[] = []
    for (const dx of [60, 120, 240]) {
        await ready(page)
        await arm(page, 'move')
        await page.mouse.dblclick(on.x, on.y)
        await arm(page, 'rotate')
        await press(page, on, shifted(on, dx))
        answers.push((await read(page)).hash)
    }
    expect(answers[0]).not.toBe(held.hash)
    expect(new Set(answers).size).toBe(1)

    // A turn keeps every voxel it lifted, or it refuses and keeps them all where they were.
    const turned = await read(page)
    expect(turned.filled).toBe(held.filled)
    expect(turned.selection).toBe(held.selection)
})

test('scale pulls the face it grabbed along its own normal', async ({page}) => {
    const {on, was} = await start(page, 'scale')

    await page.mouse.move(on.x, on.y)
    await page.mouse.down()
    await page.mouse.move(on.x + 40, on.y - 30, {steps: 8})
    expect((await read(page)).drag).toBe('extrude')
    await page.mouse.up()

    const now = await read(page)
    // A pull is the one grab tool that changes how many voxels exist, in either direction.
    expect(now.filled).not.toBe(was.filled)
    expect(now.undo).toBe(1)

    await page.keyboard.press('Control+z')
    expect((await read(page)).filled).toBe(was.filled)
})

/**
 * Clone against Move, on the identical drag.
 *
 * "Clone adds voxels" is only true when the copy lands on air, and a drag stays in the plane of the
 * face it grabbed — so on a solid surface the copy overwrites a neighbour and the count does not
 * move at all. Measured: six drags off the middle of `car.vox`, and four of them ended on 478. The
 * difference that is always true is the one against Move: both write the same destination, and only
 * Clone leaves the source where it was.
 */
test('clone leaves the original behind, which is one more voxel than move keeps', async ({
    page
}) => {
    const drag = async (tool: string): Promise<number> => {
        const {on, was} = await start(page, tool)
        await page.mouse.move(on.x, on.y)
        await page.mouse.down()
        await page.mouse.move(on.x + 60, on.y, {steps: 6})
        expect((await read(page)).drag).toBe(tool === 'clone' ? 'clone' : 'move')
        await page.mouse.up()
        const now = await read(page)
        expect(now.undo).toBe(1)
        expect(was.filled).toBe(478)
        return now.filled
    }

    expect(await drag('clone')).toBe((await drag('move')) + 1)
})

/**
 * The bar that floats over the viewport while something is selected.
 *
 * Its buttons are what an artist is actually told to click to rotate, and until now not one of them
 * had ever been clicked by a test — the transforms behind them were covered in the reducer, which
 * is the same split that hid the double-click bug. Clicked by accessible name, so a button that
 * loses its label fails here rather than going quietly unreachable.
 */
/**
 * A blob small enough to survive every axis.
 *
 * A rotation is a bijection and the reducer refuses one that would push voxels off the grid rather
 * than half-doing it, so a big selection out of `car.vox` — 16 × 10 × 7, and flat — cannot turn
 * about x or y at all. Measured: a 126-voxel double-click selection changed nothing under six of
 * the eleven buttons, all of them legitimately. One click and two presses of `]` is ten voxels,
 * which fits whichever way it goes.
 */
const selecting = async (page: Page): Promise<Reading> => {
    const {on} = await start(page, 'move')
    await page.mouse.click(on.x, on.y)
    await page.keyboard.press(']')
    await page.keyboard.press(']')
    const held = await read(page)
    expect(held.selection).toBeGreaterThan(1)
    return held
}

const bar = (page: Page, label: string): ReturnType<Page['getByRole']> =>
    page.getByRole('toolbar', {name: 'Selection'}).getByRole('button', {name: label, exact: true})

test('the selection bar appears with a selection and takes its space back without one', async ({
    page
}) => {
    const {on} = await start(page, 'move')
    await expect(page.getByRole('toolbar', {name: 'Selection'})).toHaveCount(0)

    await page.mouse.click(on.x, on.y)
    await expect(page.getByRole('toolbar', {name: 'Selection'})).toHaveCount(1)

    await bar(page, 'Deselect').click()
    await expect(page.getByRole('toolbar', {name: 'Selection'})).toHaveCount(0)
    expect((await read(page)).selection).toBe(0)
})

test('every transform button on the selection bar moves the model and undoes as one step', async ({
    page
}) => {
    const buttons = [
        'Rotate 90° about X',
        'Rotate 90° about Y',
        'Rotate 90° about Z',
        'Flip X',
        'Flip Y',
        'Flip Z',
        'Duplicate one voxel up',
        'Delete selected voxels'
    ]

    for (const label of buttons) {
        const held = await selecting(page)
        await bar(page, label).click()

        const now = await read(page)
        expect(now.hash, `${label} must change the model`).not.toBe(held.hash)
        expect(now.undo, `${label} must be one undo step`).toBe(1)

        await page.keyboard.press('Control+z')
        expect((await read(page)).hash, `${label} must undo cleanly`).toBe(held.hash)
    }
})

/**
 * The three mirrors, which need a model that is not already symmetric.
 *
 * A mirror reflects across the middle of the *grid* and keeps the original, so on `car.vox` — which
 * is a car, and symmetric — the copy lands on voxels that already hold that colour, writes nothing,
 * and the reducer keeps the old state because there is no edit to record. That is correct and it is
 * indistinguishable from a dead button, which is the whole reason this is its own test: one drawn
 * voxel first, and then there is something to reflect.
 */
test('every mirror button reflects across the grid and keeps the original', async ({page}) => {
    for (const label of ['Mirror across X', 'Mirror across Y', 'Mirror across Z']) {
        const {on} = await start(page, 'draw')
        await page.mouse.click(on.x, on.y)
        await arm(page, 'move')
        await page.mouse.click(on.x, on.y)
        const held = await read(page)

        await bar(page, label).click()
        const now = await read(page)
        // Mirror is additive: the original stays selected and the reflection joins it.
        expect(now.selection, `${label} must keep the original`).toBe(held.selection * 2)
        expect(now.hash, `${label} must write the reflection`).not.toBe(held.hash)
        expect(now.undo).toBe(held.undo + 1)
    }
})

/**
 * A quarter turn lands every voxel it lifted or it lands none of them.
 *
 * Four turns are *not* the identity here and must not be asserted as one: a rotation overwrites
 * whatever it lands on, so the first turn destroys the neighbours it covers and the fourth cannot
 * bring them back. What is guaranteed is the bijection — the selection never changes size — and
 * that four steps of history unwind to exactly the model that went in.
 */
test('turning four times keeps every selected voxel, and unwinds exactly', async ({page}) => {
    const held = await selecting(page)
    for (let turn = 0; turn < 4; turn += 1) {
        await bar(page, 'Rotate 90° about Z').click()
        const turned = await read(page)
        expect(turned.selection, `turn ${String(turn + 1)} must keep every voxel`).toBe(
            held.selection
        )
        expect(turned.undo).toBe(turn + 1)
    }

    for (let turn = 0; turn < 4; turn += 1) await page.keyboard.press('Control+z')
    const back = await read(page)
    expect(back.hash).toBe(held.hash)
    expect(back.filled).toBe(held.filled)
})

test('measure is not built, so the left button still belongs to the camera', async ({page}) => {
    const {on, was} = await start(page, 'measure')
    await press(page, on, shifted(on, 120, 40))

    const now = await read(page)
    // Nothing was written, and the view moved — which is the promise a dead tool has to keep.
    expect(now.hash).toBe(was.hash)
    expect(now.undo).toBe(0)
    expect(now.yaw).not.toBe(was.yaw)
})

test('the camera keeps the right button and Shift whatever tool is armed', async ({page}) => {
    for (const tool of ['draw', 'erase', 'fill', 'move', 'scale', 'clone']) {
        const {on, was} = await start(page, tool)

        await page.mouse.move(on.x, on.y)
        await page.mouse.down({button: 'right'})
        await page.mouse.move(on.x + 100, on.y, {steps: 4})
        await page.mouse.up({button: 'right'})

        const orbited = await read(page)
        expect(orbited.yaw, `${tool}: the right button must orbit`).not.toBe(was.yaw)
        expect(orbited.hash, `${tool}: the right button must not edit`).toBe(was.hash)

        await page.keyboard.down('Shift')
        await page.mouse.move(on.x, on.y)
        await page.mouse.down()
        await page.mouse.move(on.x + 60, on.y + 40, {steps: 4})
        await page.mouse.up()
        await page.keyboard.up('Shift')

        expect((await read(page)).hash, `${tool}: Shift must not edit`).toBe(was.hash)
    }
})

/**
 * The keyboard, pressed for real.
 *
 * Every one of these was reducer-only until now, which is the same gap that hid the double-click
 * bug: `App.tsx` binds them on `document` and decides what to dispatch, and no test outside a
 * browser had ever pressed one. A binding that never reaches its listener is invisible to a test of
 * the listener's contents.
 */
test('the selection keys reach the document', async ({page}) => {
    const held = await selecting(page)

    // Grow first. Shrink erodes everything touching air, and a blob on the surface is all surface,
    // so the pair is not a round trip and starting with `[` empties the selection outright.
    await page.keyboard.press(']')
    const grown = await read(page)
    expect(grown.selection).toBeGreaterThan(held.selection)

    await page.keyboard.press('[')
    expect((await read(page)).selection).toBeLessThan(grown.selection)

    await page.keyboard.press('Escape')
    expect((await read(page)).selection).toBe(0)
})

test('Delete takes the selection out of the model, and one press is one undo step', async ({
    page
}) => {
    const held = await selecting(page)

    await page.keyboard.press('Delete')
    const now = await read(page)
    expect(now.filled).toBe(held.filled - held.selection)
    expect(now.undo).toBe(1)

    await page.keyboard.press('Control+z')
    expect((await read(page)).filled).toBe(held.filled)
})

/**
 * Nudging is along the axes of the *model*, and Shift reaches the third one.
 *
 * A nudge that would push part of the selection off the grid is refused whole rather than dropping
 * the voxels that fell off, so the assertion is not "the model changed" but "it changed or it did
 * not, and either way nothing was lost" — plus at least one direction has to actually work, or the
 * binding is dead and the refusal is hiding it.
 */
test('the arrow keys nudge the selection, and Shift reaches the third axis', async ({page}) => {
    const held = await selecting(page)
    const moved: string[] = []

    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']) {
        await selecting(page)
        await page.keyboard.press(key)
        const now = await read(page)
        expect(now.selection, `${key} must keep every voxel`).toBe(held.selection)
        if (now.hash !== held.hash) {
            expect(now.undo, `${key} must be one undo step`).toBe(1)
            moved.push(key)
        }
    }
    expect(moved.length, 'no arrow key moved anything').toBeGreaterThan(0)

    await selecting(page)
    await page.keyboard.press('Shift+ArrowRight')
    const up = await read(page)
    expect(up.selection).toBe(held.selection)
    expect(up.hash).not.toBe(held.hash)
})

test('copy and paste put the block back one voxel up', async ({page}) => {
    const held = await selecting(page)

    await page.keyboard.press('Control+c')
    expect((await read(page)).clipboard).toBe(true)

    await page.keyboard.press('Control+v')
    const pasted = await read(page)
    expect(pasted.hash).not.toBe(held.hash)
    expect(pasted.undo).toBe(1)
    // The paste lands selected, so it can be nudged into place without picking it up again.
    expect(pasted.selection).toBeGreaterThan(0)
})

test('the keys that are not about the selection reach their own corners', async ({page}) => {
    const {was} = await start(page, 'move')

    // C captures the current view as a ninth camera.
    await page.keyboard.press('c')
    expect((await read(page)).cameras).toBe(was.cameras + 1)

    // S toggles slice mode, which opens on the middle layer.
    expect(was.slice).toBeUndefined()
    await page.keyboard.press('s')
    expect((await read(page)).slice).toBeGreaterThanOrEqual(0)
    await page.keyboard.press('s')
    expect((await read(page)).slice).toBeUndefined()

    // F fills the frame with the active object, which is a zoom and not a turn.
    await page.keyboard.press('f')
    const focused = await read(page)
    expect(focused.zoom).not.toBe(was.zoom)
    expect(focused.yaw).toBe(was.yaw)
})

/**
 * The guard that keeps a shortcut out of a text field. Without it, naming an object "sword" would
 * toggle slice mode on the S and capture a camera on nothing at all.
 */
test('typing in a field is typing, not a shortcut', async ({page}) => {
    const {was} = await start(page, 'move')
    // Focused rather than clicked: the field sits under a floating panel, and the only thing this
    // test needs is for the keypress to have a text field as its target.
    const field = page.locator('input[type="text"]').first()
    await field.focus()
    await page.keyboard.press('c')
    await page.keyboard.press('s')

    const now = await read(page)
    expect(now.cameras).toBe(was.cameras)
    expect(now.slice).toBeUndefined()
})

/**
 * The warning a drop owes the artist, on screen while the button is still down.
 *
 * Move overwrites what it lands on and drops off the grid what will not fit, and a moment later
 * both are invisible: the voxels are simply not in the picture and nothing says they ever were.
 * Undo brings them back, but only for someone who noticed. Read off the bar rather than the state,
 * because the state having the number and the artist never seeing it is the bug this closes.
 */
test('a drag that would destroy voxels says so before the button comes up', async ({page}) => {
    const {on} = await start(page, 'move')
    const warning = page.locator('.hint-losing')
    const box = page.locator('.selection-box')

    await page.mouse.move(on.x, on.y)
    await page.mouse.down()
    await expect(warning).toHaveCount(0)

    // Walk into the model until something is in the way. A drop onto air must stay silent, so the
    // sweep is what proves the warning is about the drop and not about dragging at all.
    let said = ''
    for (let step = 1; step <= 24 && said === ''; step += 1) {
        await page.mouse.move(on.x - step * 4, on.y)
        const state = await read(page)
        const shown = await warning.count()
        expect(shown, `at step ${String(step)} the bar must agree with the state`).toBe(
            state.losing > 0 ? 1 : 0
        )
        if (state.losing > 0) {
            said = (await warning.innerText()).trim()
            expect(said).toContain(String(state.losing))
            expect(said).toContain('destroyed')
            // The box the artist is looking at carries the same warning.
            await expect(box).toHaveAttribute('data-losing', 'true')
        }
    }
    expect(said, 'no drag position destroyed anything').not.toBe('')

    // The drop happens and the warning goes with it. It was about what was still avoidable.
    await page.mouse.up()
    await expect(warning).toHaveCount(0)
    expect((await read(page)).losing).toBe(0)
})
