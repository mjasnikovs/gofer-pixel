import {expect, test} from 'bun:test'
import {act} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {readVox} from '../vox/vox-file'
import {createVolume} from '../render/volume'
import {App} from './App'
import {DEFAULT_OUTPUT, loadDocument, saveDocument} from '../doc/save'
import {latestSnapshot, memoryStore, snapshots, type Store} from '../doc/store'
import {memoryFiles, type Files} from '../doc/files'
import {initialObjects} from '../doc/objects'
import {NO_SYMMETRY} from '../doc/symmetry'
import {handle} from './handle'
import {fakeGl, withFakeGl} from '../../test/fake-gl'

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

/**
 * Real React, real DOM nodes, real clicks — and nothing waits, because `act` flushes synchronously
 * and a click is `element.click()`. The window has no GPU here, which is the point: the viewport
 * fails to get a context and every other panel still works, because none of them are downstream of
 * one.
 */
const mount = async (
    store: Store = memoryStore(),
    files: Files = memoryFiles()
): Promise<{root: Root; host: HTMLElement}> => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
        root.render(
            <App
                volume={volume}
                name='car.vox'
                store={store}
                files={files}
            />
        )
    })
    return {root, host}
}

/** The document as `saveDocument` wants it, with nothing interesting in the version-2 half. */
const asSaved = (grid = volume) => ({
    volume: grid,
    objects: initialObjects(grid),
    cameras: [],
    references: [],
    symmetry: NO_SYMMETRY,
    output: DEFAULT_OUTPUT,
    origin: undefined
})

const unmount = async ({root, host}: {root: Root; host: HTMLElement}): Promise<void> => {
    await act(async () => {
        root.unmount()
    })
    host.remove()
}

/** A control by its accessible name, or by the text on its face when it has no label of its own. */
const control = (host: HTMLElement, label: string): HTMLElement => {
    const found = [...host.querySelectorAll<HTMLElement>('button, input')].find(
        node => node.getAttribute('aria-label') === label || node.textContent.trim() === label
    )
    if (!found) throw new Error(`nothing labelled "${label}"`)
    return found
}

/**
 * A menu item by its label. Menus render into a portal on `document.body`, not inside the mount, so
 * they are the one thing `control(mounted.host, …)` cannot reach.
 */
const menuItem = (label: string): HTMLElement => {
    const found = [...global.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        node => node.textContent.trim() === label
    )
    if (!found) throw new Error(`no menu item "${label}"`)
    return found
}

/** A radio by its value. Its label is a sibling `<label>`, not a name on the input. */
const radio = (value: string): HTMLElement => {
    const found = global.document.querySelector<HTMLElement>(
        `dialog[open] input[type="radio"][value="${value}"]`
    )
    if (!found) throw new Error(`no radio for "${value}"`)
    return found
}

/** The title of whichever dialog is open. Both of the file dialogs are portalled too. */
const openDialogTitle = (): string =>
    global.document.querySelector('dialog[open] h1, dialog[open] h2')?.textContent.trim() ?? ''

const within = (host: HTMLElement, selector: string, label: string): HTMLElement => {
    const region = host.querySelector<HTMLElement>(selector)
    if (!region) throw new Error(`no ${selector}`)
    return control(region, label)
}

test('the window opens on eight cameras, each with a thumbnail rendered on the CPU', async () => {
    const mounted = await mount()

    const thumbnails = mounted.host.querySelectorAll('.views-strip canvas.thumbnail')
    expect(thumbnails).toHaveLength(8)
    expect(thumbnails[0]?.getAttribute('data-pixels')).toBe('96x96')
    expect(mounted.host.textContent).toContain('Back Right')

    await unmount(mounted)
})

test('clicking a camera selects it and moves the viewport onto it', async () => {
    const mounted = await mount()
    const before = handle.state?.selected

    await act(async () => {
        within(mounted.host, '.views-strip', 'Right').click()
    })

    expect(handle.state?.selected).not.toBe(before)
    expect(handle.state?.selected).toBe('dir-2')
    expect(handle.state?.orbit.camera.yaw).toBeCloseTo(Math.PI / 2, 10)

    expect(within(mounted.host, '.views-strip', 'Right').getAttribute('aria-checked')).toBe('true')

    await unmount(mounted)
})

/*
 * Composition, which is what this file is for: the header's one coloured button reaches the dialog,
 * and the dialog bakes on the way in. What the dialog then *does* is `ExportDialog.test.tsx`, over
 * one component rather than a whole window.
 *
 * There is no longer a stale-sheet case in the window, and that is the change. The sheet used to
 * live in `AppState` and outlive the click that baked it, so capturing a ninth camera had to be
 * observed throwing it away. It is a `useMemo` inside the dialog now, and it cannot be observed
 * being wrong because it cannot be wrong.
 */
test('the header’s Export button opens the dialog, baked and showing the sheet’s own cells', async () => {
    const mounted = await mount()
    expect(document.querySelector('canvas.export-sprite')).toBeNull()

    await act(async () => {
        control(mounted.host, 'Export').click()
    })

    // A portal on `document.body`, so not under the window's host node.
    const sprites = [...document.querySelectorAll('canvas.export-sprite')]
    expect(sprites).toHaveLength(8)
    expect(sprites[0]?.getAttribute('data-pixels')).toBe('64x64')
    expect(document.body.textContent).toContain('256 × 128')

    await unmount(mounted)
})

test('the undo button undoes, and greys itself out when there is nothing left', async () => {
    const mounted = await mount()
    // Nothing has happened yet, so both are off — and Astryx keeps a tooltipped control focusable
    // and marks it `aria-disabled` rather than dropping it out of the tab order.
    expect(control(mounted.host, 'Undo').getAttribute('aria-disabled')).toBe('true')
    expect(control(mounted.host, 'Redo').getAttribute('aria-disabled')).toBe('true')

    await act(async () => {
        handle.dispatch?.({type: 'select-color'})
        handle.dispatch?.({type: 'transform', op: {kind: 'delete'}})
    })
    const cut = handle.state?.volume.data.filter(value => value !== 0).length ?? 0
    expect(handle.state?.history.past).toHaveLength(1)
    expect(control(mounted.host, 'Undo').getAttribute('aria-disabled')).toBeNull()

    await act(async () => {
        control(mounted.host, 'Undo').click()
    })
    expect(handle.state?.history.past).toHaveLength(0)
    expect(handle.state?.volume.data.filter(value => value !== 0).length).toBeGreaterThan(cut)

    // And back the other way, which is the half the header never had at all.
    expect(control(mounted.host, 'Redo').getAttribute('aria-disabled')).toBeNull()
    await act(async () => {
        control(mounted.host, 'Redo').click()
    })
    expect(handle.state?.volume.data.filter(value => value !== 0).length).toBe(cut)

    await unmount(mounted)
})

test('the viewport says why it has no picture instead of showing an empty box', async () => {
    const mounted = await mount()
    const failure = mounted.host.querySelector('[data-testid="viewport-failure"]')

    // happy-dom has no WebGL at all, which is the same shape of failure as hardware acceleration
    // being switched off. The message has to name a cause the reader can act on — "WebGL2 is not
    // available" sends them to their driver, which is almost never where the problem is.
    expect(failure?.textContent).toContain('Hardware acceleration is switched off')
    expect(failure?.textContent).toContain('privacy shield')
    expect(failure?.hasAttribute('hidden')).toBe(false)

    await unmount(mounted)
})

test('an edit is autosaved, and the save reopens as the document that made it', async () => {
    /*
     * `writes` counts what reaches the disk, because "once per committed edit" is the claim the
     * autosave effect makes and it is a claim about *how often*. While `store` was a default
     * parameter it changed identity every render, so the effect's `[commits, store]` re-ran on
     * every one and a whole RLE-and-base64 of the grid went through here at pointer rate.
     */
    const writes: string[] = []
    const backing = new Map<string, string>()
    const store: Store = {
        ...memoryStore(backing),
        set: (key, value) => {
            writes.push(key)
            backing.set(key, value)
        }
    }
    const mounted = await mount(store)
    expect(snapshots(store)).toHaveLength(0)

    // Nothing waits for a clock: the autosave hangs off the history growing, which happens inside
    // this `act` because the reducer is synchronous.
    await act(async () => {
        handle.dispatch?.({type: 'object', op: {kind: 'add'}})
        handle.dispatch?.({type: 'transform', op: {kind: 'delete'}})
        handle.dispatch?.({type: 'select-color'})
    })
    await act(async () => {
        handle.dispatch?.({type: 'transform', op: {kind: 'paint', color: 200}})
    })

    const kept = snapshots(store)
    expect(kept).toHaveLength(1)
    expect(kept[0]?.name).toBe('car.vox')
    // One write per entry in the history, and not one per render of the tree above it.
    expect(writes).toHaveLength(handle.state?.history.past.length ?? -1)

    const text = latestSnapshot(store)
    if (!text) throw new Error('the autosave is there to be read')
    const back = loadDocument(text)
    expect(back?.volume.data).toEqual(handle.state?.volume.data as never)
    // The objects come back with it, or a recovered document would forget what its pieces were.
    expect(back?.objects.list).toHaveLength(2)
    expect(back?.cameras).toHaveLength(8)

    await unmount(mounted)
})

/*
 * The file menu. It drives a `memoryFiles` disk rather than the browser's, for the same reason the
 * snapshot tests drive a `memoryStore`: the picker is a native dialog with no automation surface,
 * and what can lose an artist's work is the logic around it. See `doc/files.ts`.
 */
test('Save writes the open document to disk and the header stops saying unsaved', async () => {
    const disk = new Map<string, string>()
    const mounted = await mount(memoryStore(), memoryFiles(disk))

    // Draw something, so there is a document worth writing and a dirty flag worth clearing.
    await act(async () => {
        handle.dispatch?.({type: 'object', op: {kind: 'add'}})
    })
    expect(handle.state?.doc.dirty).toBe(true)
    expect(mounted.host.querySelector('.app-header')?.textContent).toContain('Unsaved changes')

    await act(async () => {
        control(mounted.host, 'Main menu').click()
    })
    await act(async () => {
        menuItem('Save').click()
    })

    // `car.vox` is somebody else's format, so it saves as `car.gpix` rather than over their model.
    expect([...disk.keys()]).toEqual(['car.gpix'])
    expect(handle.state?.doc).toMatchObject({name: 'car.gpix', dirty: false})
    expect(mounted.host.querySelector('.app-header')?.textContent).not.toContain('Unsaved')

    // And what landed on the disk opens as the document that was on screen.
    const back = loadDocument(disk.get('car.gpix') ?? '')
    expect(back?.volume.data).toEqual(handle.state?.volume.data ?? new Uint8Array())
    expect(back?.objects.list).toHaveLength(2)

    await unmount(mounted)
})

test('a .gpix on the disk opens over what is on screen', async () => {
    const other = createVolume(8, 8, 8, volume.palette)
    other.data[0] = 1
    const saved = saveDocument(
        {...asSaved(other), symmetry: {x: true, y: false, z: false, radial: false}},
        'knight.gpix'
    )
    const disk = new Map([['knight.gpix', JSON.stringify(saved)]])
    const mounted = await mount(memoryStore(), memoryFiles(disk))

    await act(async () => {
        control(mounted.host, 'Main menu').click()
    })
    await act(async () => {
        menuItem('Open…').click()
    })

    expect(handle.state?.doc.name).toBe('knight.gpix')
    expect([handle.state?.volume.sx, handle.state?.volume.sy]).toEqual([8, 8])
    expect(handle.state?.symmetry.x).toBe(true)
    expect(handle.state?.doc.dirty).toBe(false)

    await unmount(mounted)
})

/*
 * Generation is gone — `src/gen/` was removed and the menu item that opened it is disabled. What
 * is left is `GenerateDialog.tsx`, a shell nothing in the running app can reach, so the two tests
 * that lived here (the menu reaching the pipeline, a candidate landing in the document) went with
 * the code they were about. The one claim worth keeping is that the row is still there and greyed.
 */
test('the generate menu item is present and disabled', async () => {
    const mounted = await mount()

    await act(async () => {
        control(mounted.host, 'Main menu').click()
    })
    const item = menuItem('Generate a model…')

    expect(item.getAttribute('aria-disabled') ?? item.getAttribute('disabled')).not.toBeNull()

    await unmount(mounted)
})

test('New with unsaved work asks first, and cancelling leaves the model alone', async () => {
    const mounted = await mount(memoryStore(), memoryFiles())

    await act(async () => {
        handle.dispatch?.({type: 'object', op: {kind: 'add'}})
    })
    const before = handle.state?.volume

    await act(async () => {
        control(mounted.host, 'Main menu').click()
    })
    await act(async () => {
        menuItem('New project…').click()
    })

    // The guard, not the new-project dialog.
    expect(openDialogTitle()).toContain('unsaved')
    await act(async () => {
        control(global.document.body, 'Cancel').click()
    })
    expect(handle.state?.volume).toBe(before)

    await unmount(mounted)
})

test('New on a clean document goes straight to the templates and builds the box they name', async () => {
    const mounted = await mount(memoryStore(), memoryFiles())

    await act(async () => {
        control(mounted.host, 'Main menu').click()
    })
    await act(async () => {
        menuItem('New project…').click()
    })
    expect(openDialogTitle()).toBe('New project')

    await act(async () => {
        radio('Isometric tile').click()
    })
    await act(async () => {
        control(global.document.body, 'Create').click()
    })

    expect([handle.state?.volume.sx, handle.state?.volume.sy, handle.state?.volume.sz]).toEqual([
        32, 32, 16
    ])
    expect(handle.state?.doc).toMatchObject({name: 'untitled.gpix', dirty: false})
    expect(handle.state?.volume.data.some(value => value !== 0)).toBe(false)

    await unmount(mounted)
})

/*
 * The guard's own three buttons. Discard and Save-first both end with the artist somewhere new, and
 * the third case — Save first, then back out of the picker — is the one that would lose the work
 * the dialog was protecting.
 */
const guard = async (host: HTMLElement): Promise<void> => {
    await act(async () => {
        handle.dispatch?.({type: 'object', op: {kind: 'add'}})
    })
    await act(async () => {
        control(host, 'Main menu').click()
    })
    await act(async () => {
        menuItem('New project…').click()
    })
    expect(openDialogTitle()).toContain('unsaved')
}

test('Discard goes on to the thing that was asked for', async () => {
    const mounted = await mount(memoryStore(), memoryFiles())
    await guard(mounted.host)

    await act(async () => {
        control(global.document.body, 'Discard').click()
    })

    // Straight through to the templates, with nothing written.
    expect(openDialogTitle()).toBe('New project')
    await unmount(mounted)
})

test('Save first writes the file and then goes on', async () => {
    const disk = new Map<string, string>()
    const mounted = await mount(memoryStore(), memoryFiles(disk))
    await guard(mounted.host)

    await act(async () => {
        control(global.document.body, 'Save first').click()
    })

    expect([...disk.keys()]).toEqual(['car.gpix'])
    expect(handle.state?.doc).toMatchObject({name: 'car.gpix', dirty: false})
    expect(openDialogTitle()).toBe('New project')
    await unmount(mounted)
})

test('Save first, then backing out of the picker, is not a silent Discard', async () => {
    const disk = new Map<string, string>()
    const mounted = await mount(
        memoryStore(),
        memoryFiles(disk, () => undefined)
    )
    await guard(mounted.host)
    const before = handle.state?.objects.list.length

    await act(async () => {
        control(global.document.body, 'Save first').click()
    })

    // Nothing written, and nothing thrown away: no new-project dialog, no new document.
    expect(disk.size).toBe(0)
    expect(openDialogTitle()).toBe('')
    expect(handle.state?.objects.list.length).toBe(before)
    expect(handle.state?.doc.dirty).toBe(true)
    await unmount(mounted)
})

/**
 * Escape, where astryx listens for it: on the `<dialog>` element itself, not on the window.
 *
 * It bubbles, so the app's own keyboard table sees it too — which is the point. Escape already
 * means "drop the selection", and a dialog on screen has to win.
 */
const escape = async (): Promise<void> => {
    const open = [...global.document.querySelectorAll<HTMLElement>('dialog[open]')].at(-1)
    if (!open) throw new Error('no dialog is open')
    await act(async () => {
        open.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))
    })
}

/** The × in the corner of whichever dialog is open. */
const closeCorner = (): HTMLElement => {
    const open = [...global.document.querySelectorAll<HTMLElement>('dialog[open]')].at(-1)
    const found = [...(open?.querySelectorAll<HTMLElement>('button') ?? [])].find(node =>
        (node.getAttribute('aria-label') ?? '').toLowerCase().includes('close')
    )
    if (!found) throw new Error('the open dialog has no close button')
    return found
}

/*
 * The fourth answer to the guard, and the one nothing was asserting: leaving without answering. It
 * is Cancel's answer, and it has to stay Cancel's answer through both of the routes a dialog can be
 * dismissed by — otherwise Escape over the guard is a silent Discard, which is the one outcome the
 * guard exists to prevent.
 */
test('Escape and the × back out of the guard without answering it', async () => {
    const disk = new Map<string, string>()
    const mounted = await mount(memoryStore(), memoryFiles(disk))

    await guard(mounted.host)
    await escape()
    expect(openDialogTitle()).toBe('')
    expect(disk.size).toBe(0)
    expect(handle.state?.doc.dirty).toBe(true)

    await guard(mounted.host)
    await act(async () => {
        closeCorner().click()
    })
    expect(openDialogTitle()).toBe('')
    expect(disk.size).toBe(0)
    expect(handle.state?.doc.dirty).toBe(true)

    await unmount(mounted)
})

test('Escape and the × back out of New project without building one', async () => {
    const mounted = await mount(memoryStore(), memoryFiles())
    const before = handle.state?.volume

    const openNew = async (): Promise<void> => {
        await act(async () => {
            control(mounted.host, 'Main menu').click()
        })
        await act(async () => {
            menuItem('New project…').click()
        })
        expect(openDialogTitle()).toBe('New project')
    }

    await openNew()
    await escape()
    expect(openDialogTitle()).toBe('')
    expect(handle.state?.volume).toBe(before)

    await openNew()
    await act(async () => {
        closeCorner().click()
    })
    expect(openDialogTitle()).toBe('')
    expect(handle.state?.volume).toBe(before)

    await unmount(mounted)
})

test('Escape and the × close the export dialog, which writes nothing on the way out', async () => {
    const disk = new Map<string, string | Uint8Array>()
    const mounted = await mount(memoryStore(), memoryFiles(disk))

    await act(async () => {
        control(mounted.host, 'Export').click()
    })
    expect(openDialogTitle()).toBe('Export')
    await escape()
    expect(openDialogTitle()).toBe('')

    await act(async () => {
        control(mounted.host, 'Export').click()
    })
    await act(async () => {
        closeCorner().click()
    })
    expect(openDialogTitle()).toBe('')
    expect(disk.size).toBe(0)

    await unmount(mounted)
})

test('a typed custom size is the box that gets built', async () => {
    const mounted = await mount(memoryStore(), memoryFiles())
    await act(async () => {
        control(mounted.host, 'Main menu').click()
    })
    await act(async () => {
        menuItem('New project…').click()
    })

    /*
     * Typing, as React sees it. React keeps its own copy of an input's value and ignores an event
     * whose value it thinks it already has, so assigning `.value` and firing `input` is a no-op —
     * the assignment has to go through the prototype's setter, which is what a real keystroke does.
     */
    const type = (field: HTMLInputElement, text: string): void => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(field, text)
        field.dispatchEvent(new Event('input', {bubbles: true}))
    }

    const [x, , z] = [
        ...global.document.querySelectorAll<HTMLInputElement>('dialog[open] input[type="number"]')
    ]
    if (!x || !z) throw new Error('the dialog has an X, a Y and a Z')

    // A number field picks Custom on its own, so nothing changes what is selected out from under
    // the artist while they are still typing into it.
    await act(async () => {
        type(x, '48')
    })
    await act(async () => {
        type(z, '8')
    })

    await act(async () => {
        control(global.document.body, 'Create').click()
    })

    // What was typed is what gets built, on the two axes touched and the one left alone.
    // `clampAxis` guards the out-of-range end of this and is tested in `doc/templates.test.ts`.
    expect([handle.state?.volume.sx, handle.state?.volume.sy, handle.state?.volume.sz]).toEqual([
        48, 32, 8
    ])
    await unmount(mounted)
})

/*
 * Reference art — `FEATURESET.md` §33.
 *
 * The picture arrives by drag-and-drop, which needs `createImageBitmap` and a real decoder, so the
 * drop itself belongs to the browser suite. Everything after it — the row of controls, the lock,
 * and the layer under the viewport — is state, and this is where it gets held down.
 */
const PICTURE = 'data:image/png;base64,iVBORw0KGgo='

test('reference art survives a save and reopen', async () => {
    const disk = new Map<string, string>()
    const mounted = await mount(memoryStore(), memoryFiles(disk))

    await act(async () => {
        handle.dispatch?.({type: 'reference', op: {kind: 'place', plane: 0, url: PICTURE}})
    })
    await act(async () => {
        handle.dispatch?.({type: 'reference', op: {kind: 'lock', plane: 0, on: true}})
    })
    await act(async () => {
        control(mounted.host, 'Main menu').click()
    })
    await act(async () => {
        menuItem('Save').click()
    })

    const back = loadDocument(disk.get('car.gpix') ?? '')
    expect(back?.references).toEqual([{plane: 0, url: PICTURE, opacity: 0.5, locked: true}])

    await unmount(mounted)
})

/*
 * The keyboard. Every one of these is also a button or a menu item somewhere, which is exactly why
 * they are worth holding down: a shortcut that has quietly stopped dispatching looks identical to
 * one that was never pressed.
 */
const press = async (key: string, modifiers: Partial<KeyboardEventInit> = {}): Promise<void> => {
    await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', {key, ...modifiers}))
    })
}

/*
 * The listener itself. Which key means what is `keys.ts`, and it is a table with no DOM in it — so
 * all this has to prove is that the table is actually plugged into the document and the reducer.
 */
test('the keyboard listener is wired to the table and to the reducer', async () => {
    const mounted = await mount()

    await act(async () => {
        handle.dispatch?.({type: 'select-color', color: 1})
    })
    const picked = handle.state?.selection.size ?? 0
    expect(picked).toBeGreaterThan(0)

    await press(']')
    expect(handle.state?.selection.size).toBeGreaterThan(picked)

    // Bound, unbound and modified, so a listener that fired on everything would fail here.
    await press('Escape')
    expect(handle.state?.selection.size).toBe(0)
    const zoomed = handle.state?.orbit.camera.zoom
    await press('f', {altKey: true})
    expect(handle.state?.orbit.camera.zoom).toBe(zoomed)
    await press('f')
    expect(handle.state?.orbit.camera.zoom).not.toBe(zoomed)

    // An unmodified letter is a shortcut, and C captures the view as a ninth camera.
    await press('c')
    expect(handle.state?.cameras).toHaveLength(9)

    // A shortcut that fires while the user is typing is a bug, not a shortcut. This is the whole
    // reason the listener is on `document` rather than on the control that owns each binding.
    const field = document.createElement('input')
    document.body.appendChild(field)
    await act(async () => {
        field.dispatchEvent(new KeyboardEvent('keydown', {key: 'c', bubbles: true}))
    })
    expect(handle.state?.cameras).toHaveLength(9)
    field.remove()

    await unmount(mounted)
})

/*
 * A picture dropped on the viewport — `FEATURESET.md` §33 and §34, told apart by Shift.
 *
 * The browser's own decoder is the one part of this that cannot exist here: happy-dom's
 * `createImageBitmap` will not take a `Blob`, and its canvas has no 2D context. Both are stubbed,
 * and everything the app actually decides — which of the two things a drop becomes, what the
 * reference's URL is, how deep the extrusion goes — is real.
 */
const withDecoder = async (
    run: () => Promise<void>,
    pixels = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 0, 0])
): Promise<void> => {
    const realBitmap = globalThis.createImageBitmap
    const realContext = HTMLCanvasElement.prototype.getContext
    // A stand-in for the browser's decoder, and for the three context calls `dropImage` makes
    // alongside the one `PixelCanvas` makes. Neither is an `ImageBitmap` or a real context.
    globalThis.createImageBitmap = async () =>
        Promise.resolve({
            width: 2,
            height: 2,
            close: () => undefined
        })
    HTMLCanvasElement.prototype.getContext = (() => ({
        drawImage: () => undefined,
        putImageData: () => undefined,
        getImageData: () => ({data: pixels, width: 2, height: 2, colorSpace: 'srgb'})
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext
    try {
        await run()
    } finally {
        globalThis.createImageBitmap = realBitmap
        HTMLCanvasElement.prototype.getContext = realContext
    }
}

const dropOn = async (host: HTMLElement, file: File | undefined, shift: boolean): Promise<void> => {
    const stage = host.querySelector('.stage')
    if (!stage) throw new Error('no stage')
    const event = new Event('drop', {bubbles: true})
    Object.defineProperty(event, 'dataTransfer', {value: {files: file ? [file] : []}})
    Object.defineProperty(event, 'shiftKey', {value: shift})
    await act(async () => {
        stage.dispatchEvent(event)
    })
    await settled()
}

/**
 * Wait for the app's own decode to land, without waiting for a *duration*.
 *
 * `dropImage` reads the file, decodes it and — for a reference — hands the blob to a `FileReader`,
 * which resolves on the task queue rather than the microtask queue. So this drains the microtasks
 * that get the handler as far as its reader, and then waits on a reader of its own: queued after
 * the app's, so it cannot land before it. No timer, and nothing to tune.
 */
const settled = async (): Promise<void> => {
    await act(async () => {
        for (let flush = 0; flush < 8; flush += 1) await Promise.resolve()
    })
    await act(async () => {
        await new Promise<void>(resolve => {
            const reader = new FileReader()
            reader.addEventListener('load', () => {
                resolve()
            })
            reader.readAsText(new Blob(['']))
        })
    })
}

const asPng = (): File =>
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'front.png', {type: 'image/png'})

test('a picture dropped on the viewport becomes reference art', async () => {
    await withDecoder(async () => {
        const mounted = await mount()

        await dropOn(mounted.host, asPng(), false)

        // Onto Front, because nothing has locked a drawing plane.
        expect(handle.state?.references).toHaveLength(1)
        expect(handle.state?.references[0]?.plane).toBe(1)
        expect(handle.state?.references[0]?.url).toStartWith('data:image/png;base64,')

        // With a plane locked, it lands on that one instead — the artist who locked it is working
        // on it.
        await act(async () => {
            handle.dispatch?.({type: 'plane', axis: 0})
        })
        await dropOn(mounted.host, asPng(), false)
        expect(handle.state?.references.map(entry => entry.plane).toSorted()).toEqual([0, 1])

        await unmount(mounted)
    })
})

/*
 * `FEATURESET.md` §7's import half, through the `Files` port — the same one Open and Save go
 * through. It used to build its own `<input type=file>`, so this test used to have to replace
 * `HTMLInputElement.prototype.click` and put it back in a `finally`.
 */
test('a .hex file loaded from the picker becomes the palette', async () => {
    const disk = new Map([['mine.hex', '112233\n445566\n']])
    const mounted = await mount(undefined, memoryFiles(disk))

    await act(async () => {
        control(mounted.host, 'Load a palette').click()
    })
    await settled()

    expect([...(handle.state?.volume.palette ?? []).slice(4, 10)]).toEqual([
        0x11, 0x22, 0x33, 255, 0x44, 0x55
    ])

    await unmount(mounted)
})

/*
 * The composition claim, not the palette one: the window's own `Files` reaches the panel that
 * writes. What lands in the file is `BrushPanel.test.tsx`'s, at a fifth of the cost.
 *
 * This used to replace `URL.createObjectURL` and `HTMLAnchorElement.prototype.click`, because the
 * panel built its own anchor and there was no port between it and the browser to stand at.
 */
test('the palette writes back out through the window’s own port', async () => {
    const disk = new Map<string, string | Uint8Array>()
    const mounted = await mount(memoryStore(), memoryFiles(disk))

    await act(async () => {
        control(mounted.host, 'Save the palette').click()
    })
    await settled()

    expect([...disk.keys()]).toEqual(['palette.hex'])

    await unmount(mounted)
})

/*
 * The objects panel's three gestures that are not a switch — `FEATURESET.md` §18.
 *
 * Rename is a double-click, delete asks first, and reorder is a drag on the name and nowhere else.
 * All three are state the panel keeps for itself, so none of them show up in a reducer test.
 */
/*
 * The window with a working viewport in it.
 *
 * Every other test here runs with no GL context at all — deliberately, because that is what proves
 * no panel is downstream of one. This is the other half: with a recording context behind the canvas
 * (see `test/fake-gl.ts`) the five callbacks between the viewport and the reducer come alive, and a
 * whole gesture can be driven from the pointer to the voxel.
 */
const onCanvas = async (
    run: (mounted: {root: Root; host: HTMLElement}, gl: ReturnType<typeof fakeGl>) => Promise<void>
): Promise<void> => {
    const gl = fakeGl()
    const realObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
        constructor(
            private readonly fire: (
                entries: {contentRect: {width: number; height: number}}[]
            ) => void
        ) {}
        observe(): void {
            this.fire([{contentRect: {width: 512, height: 512}}])
        }
        unobserve(): void {
            /* nothing to stop */
        }
        disconnect(): void {
            /* nothing to stop */
        }
    } as unknown as typeof ResizeObserver

    await withFakeGl({webgl2: gl.context}, async () => {
        const mounted = await mount()
        try {
            await run(mounted, gl)
        } finally {
            await unmount(mounted)
            globalThis.ResizeObserver = realObserver
        }
    })
}

/**
 * The viewport element, given a size.
 *
 * Nothing lays anything out under happy-dom, so `clientHeight` is 0 and the basis a press is
 * measured against would be built at zero pixels — every ray would miss and every assertion below
 * would pass for the wrong reason. The element is told how big it is instead.
 */
const SIDE = 512

const viewportOf = (host: HTMLElement): HTMLElement => {
    const found = host.querySelector<HTMLElement>('[data-testid="viewport"]')
    if (!found) throw new Error('no viewport')
    for (const name of ['clientWidth', 'clientHeight'])
        Object.defineProperty(found, name, {configurable: true, value: SIDE})
    Object.defineProperty(found, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: SIDE,
            bottom: SIDE,
            width: SIDE,
            height: SIDE
        })
    })
    return found
}

const at = (
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    x: number,
    y: number,
    extra: Partial<PointerEventInit> = {}
): PointerEvent =>
    new PointerEvent(type, {bubbles: true, pointerId: 1, clientX: x, clientY: y, ...extra})

/*
 * One window for the whole gesture, because the mount is the bill.
 *
 * A window with a live canvas in it costs ~350 ms to raise under happy-dom, and none of what
 * follows needs a *fresh* one: orbit, zoom, a press and a leave are independent of each other and
 * each states what it changed. Splitting them into five tests bought five mounts and nothing else.
 */
test('a live viewport carries a pointer all the way to a voxel', async () => {
    await onCanvas(async (mounted, gl) => {
        const stage = viewportOf(mounted.host)

        // The renderer reaches the browser-test seam, and a frame has really landed.
        expect(handle.raycaster).toBeDefined()
        expect(mounted.host.querySelector('.viewport-failure')?.textContent).toBe('')
        expect(gl.of('drawArrays').length).toBeGreaterThan(0)
        await handle.firstFrame

        // The right button orbits, and the gesture ends with the press.
        const turned = handle.state?.orbit.camera.yaw
        await act(async () => {
            stage.dispatchEvent(at('pointerdown', 200, 200, {button: 2}))
        })
        await act(async () => {
            stage.dispatchEvent(at('pointermove', 260, 210, {button: 2, buttons: 2}))
        })
        await act(async () => {
            stage.dispatchEvent(at('pointerup', 260, 210))
        })
        expect(handle.state?.orbit.camera.yaw).not.toBe(turned)
        expect(handle.state?.orbit.gesture).toBeUndefined()

        // The wheel zooms.
        const zoom = handle.state?.orbit.camera.zoom ?? 0
        await act(async () => {
            stage.dispatchEvent(
                new WheelEvent('wheel', {bubbles: true, cancelable: true, deltaY: -240})
            )
        })
        expect(handle.state?.orbit.camera.zoom).toBeLessThan(zoom)

        // A hover puts the brush ghost somewhere, and leaving takes it away again.
        await act(async () => {
            stage.dispatchEvent(at('pointermove', 256, 256))
        })
        expect(handle.state?.hover).toBeDefined()
        await act(async () => {
            stage.dispatchEvent(new PointerEvent('pointerout', {bubbles: true}))
        })
        expect(handle.state?.hover).toBeUndefined()

        /*
         * And the whole path a stroke takes: a pointer position, a ray through it, a voxel, an
         * edit, a new volume object, a texture. Nothing between the mouse and the model is stubbed
         * except the driver.
         */
        const filled = () => handle.state?.volume.data.filter(Boolean).length ?? 0
        const before = filled()
        const uploads = gl.of('texImage3D').length
        await act(async () => {
            stage.dispatchEvent(at('pointerdown', 256, 256))
        })
        await act(async () => {
            stage.dispatchEvent(at('pointerup', 256, 256))
        })
        expect(filled()).toBeGreaterThan(before)
        expect(gl.of('texImage3D').length).toBeGreaterThan(uploads)
    })
})

/*
 * The rest of the keyboard: the six shortcuts that shadow a menu item, plus the arrow keys.
 *
 * `Ctrl+S` has to be swallowed or the browser opens its own Save Page dialog over the top of ours,
 * so "the event was prevented" is part of what is being checked, not an implementation detail.
 */
const pressKey = async (
    key: string,
    modifiers: Partial<KeyboardEventInit> = {}
): Promise<Event> => {
    const event = new KeyboardEvent('keydown', {key, cancelable: true, ...modifiers})
    await act(async () => {
        document.dispatchEvent(event)
    })
    return event
}

test('Ctrl-S saves, Ctrl-Shift-S asks, and both are taken off the browser', async () => {
    const disk = new Map<string, string>()
    const mounted = await mount(memoryStore(), memoryFiles(disk))

    await act(async () => {
        handle.dispatch?.({type: 'object', op: {kind: 'add'}})
    })

    const saved = await pressKey('s', {ctrlKey: true})
    expect(saved.defaultPrevented).toBe(true)
    await act(async () => {
        await Promise.resolve()
    })
    expect([...disk.keys()]).toEqual(['car.gpix'])

    // Save As, which always asks — and the memory picker takes the name it is offered.
    await act(async () => {
        handle.dispatch?.({type: 'object', op: {kind: 'add'}})
    })
    await pressKey('s', {ctrlKey: true, shiftKey: true})
    await act(async () => {
        await Promise.resolve()
    })
    expect(handle.state?.doc.dirty).toBe(false)

    await unmount(mounted)
})

/*
 * The port outlives the render, which is the whole reason `store` and `files` are required props.
 *
 * They used to be default parameters — `files = browserFiles()` — and a default parameter runs on
 * every call to the component function. A `Files` remembers the handle Save writes back to, so the
 * re-render that `dispatch({type: 'saved'})` caused threw that memory away and the *next* Ctrl-S
 * opened the picker again. Every test injected a port, so nothing here ever ran the broken path;
 * the compiler now refuses to let one be built in a render at all, and this pins the behaviour
 * that made it worth refusing.
 */
test('a second save writes back to the same file without asking again', async () => {
    const disk = new Map<string, string>()
    const asked: string[] = []
    const mounted = await mount(
        memoryStore(),
        memoryFiles(disk, suggested => {
            asked.push(suggested)
            return suggested
        })
    )

    for (const _ of [0, 1]) {
        await act(async () => {
            handle.dispatch?.({type: 'object', op: {kind: 'add'}})
        })
        await pressKey('s', {ctrlKey: true})
        await act(async () => {
            await Promise.resolve()
        })
    }

    expect(handle.state?.doc.dirty).toBe(false)
    expect([...disk.keys()]).toEqual(['car.gpix'])
    // Once. The second Save reused what the first one held, across the re-render between them.
    expect(asked).toEqual(['car.gpix'])

    await unmount(mounted)
})

test('Ctrl-O and Ctrl-N go through the same guard the menu does', async () => {
    const mounted = await mount(memoryStore(), memoryFiles())

    await act(async () => {
        handle.dispatch?.({type: 'object', op: {kind: 'add'}})
    })
    expect(handle.state?.doc.dirty).toBe(true)

    // Dirty, so both ask before throwing the work away.
    const opened = await pressKey('o', {ctrlKey: true})
    expect(opened.defaultPrevented).toBe(true)
    expect(openDialogTitle()).toContain('unsaved')
    await act(async () => {
        control(global.document.body, 'Cancel').click()
    })

    await pressKey('n', {ctrlKey: true})
    expect(openDialogTitle()).toContain('unsaved')
    await act(async () => {
        control(global.document.body, 'Cancel').click()
    })

    // A modifier the app does not claim falls through to the browser untouched.
    const ignored = await pressKey('q', {ctrlKey: true})
    expect(ignored.defaultPrevented).toBe(false)

    await unmount(mounted)
})

/*
 * The arrow keys nudge a selection. Shift swaps the horizontal pair for the vertical one, which is
 * the third axis a two-dimensional keyboard cannot otherwise reach.
 */
test('closing the tab with unsaved work is refused until it is saved', async () => {
    const disk = new Map<string, string>()
    const mounted = await mount(memoryStore(), memoryFiles(disk))
    const closing = (): boolean => {
        const event = new Event('beforeunload', {cancelable: true})
        globalThis.dispatchEvent(event)
        return event.defaultPrevented
    }

    expect(closing()).toBe(false)

    await act(async () => {
        handle.dispatch?.({type: 'object', op: {kind: 'add'}})
    })
    expect(closing()).toBe(true)

    await act(async () => {
        control(mounted.host, 'Main menu').click()
    })
    await act(async () => {
        menuItem('Save').click()
    })
    expect(closing()).toBe(false)

    await unmount(mounted)
})

test('Save As from the menu writes under a new name and keeps the old file', async () => {
    const disk = new Map<string, string>([['car.gpix', 'old']])
    const mounted = await mount(
        memoryStore(),
        memoryFiles(disk, () => 'knight.gpix')
    )

    await act(async () => {
        control(mounted.host, 'Main menu').click()
    })
    await act(async () => {
        menuItem('Save As…').click()
    })

    expect([...disk.keys()].toSorted()).toEqual(['car.gpix', 'knight.gpix'])
    expect(disk.get('car.gpix')).toBe('old')
    expect(handle.state?.doc.name).toBe('knight.gpix')

    await unmount(mounted)
})

test('restoring a snapshot brings the work back, and still counts as unsaved', async () => {
    const backing = new Map<string, string>()
    const store = memoryStore(backing)
    const mounted = await mount(store, memoryFiles())

    // Autosave hangs off the history growing, which is a committed *edit* — adding an object is
    // not one on its own.
    await act(async () => {
        handle.dispatch?.({type: 'object', op: {kind: 'add'}})
        handle.dispatch?.({type: 'select-color', color: 1})
    })
    await act(async () => {
        handle.dispatch?.({type: 'transform', op: {kind: 'delete'}})
    })
    expect(snapshots(store)).toHaveLength(1)
    const kept = handle.state?.volume.data.filter(Boolean).length ?? 0

    // Something else on screen, so the restore has something to replace.
    await act(async () => {
        handle.dispatch?.({type: 'object', op: {kind: 'add'}})
    })
    expect(handle.state?.objects.list).toHaveLength(3)

    await act(async () => {
        control(mounted.host, 'Main menu').click()
    })
    await act(async () => {
        restoreItem().click()
    })

    expect(handle.state?.volume.data.filter(Boolean).length).toBe(kept)
    expect(handle.state?.objects.list).toHaveLength(2)
    // A snapshot is an edit that was autosaved and never written to disk. Calling it saved would
    // let the artist close the tab without a word.
    expect(handle.state?.doc.dirty).toBe(true)

    await unmount(mounted)
})

test('forgetting the snapshots empties the list', async () => {
    const backing = new Map<string, string>()
    const store = memoryStore(backing)
    const mounted = await mount(store, memoryFiles())

    await act(async () => {
        handle.dispatch?.({type: 'object', op: {kind: 'add'}})
        handle.dispatch?.({type: 'select-color', color: 1})
    })
    await act(async () => {
        handle.dispatch?.({type: 'transform', op: {kind: 'delete'}})
    })
    expect(snapshots(store)).not.toHaveLength(0)

    // The autosave is written from an effect and does not itself re-render, so the menu only learns
    // there is something to forget on the next pass. Anything at all will do.
    await act(async () => {
        handle.dispatch?.({type: 'chrome', chrome: {grid: false}})
    })

    await act(async () => {
        control(mounted.host, 'Main menu').click()
    })
    await act(async () => {
        menuItem('Forget every snapshot').click()
    })

    expect(snapshots(store)).toHaveLength(0)
    expect(latestSnapshot(store)).toBeUndefined()

    await unmount(mounted)
})

/*
 * The palette grid's two modified clicks — `FEATURESET.md` §7. Both are said out loud in the
 * swatch's own label, because a gesture that exists only in a tooltip does not exist.
 */
/** The newest Restore entry in the main menu. */
const restoreItem = (): HTMLElement => {
    const found = [...global.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        node => node.textContent.trim().startsWith('Restore')
    )
    if (!found) throw new Error('no restore point in the menu')
    return found
}

test('dragging a file over the viewport is accepted, so the browser does not open it', async () => {
    const mounted = await mount()
    const stage = mounted.host.querySelector('.stage')
    if (!stage) throw new Error('no stage')

    const over = new Event('dragover', {bubbles: true, cancelable: true})
    await act(async () => {
        stage.dispatchEvent(over)
    })

    // Without this the browser navigates away to the dropped PNG and the document is gone.
    expect(over.defaultPrevented).toBe(true)

    await unmount(mounted)
})
