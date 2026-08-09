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
import type {Axis} from '../doc/brush'
import {NO_SYMMETRY} from '../doc/symmetry'
import {memoryScorer} from '../gen/clip'
import {memoryLlama, type Llama} from '../gen/llama'
import {handle} from './handle'
import {currentSheet} from './state'
import type {Sheet} from '../sheet/sheet'
import {fakeGl, withFakeGl} from '../../test/fake-gl'

/**
 * The baked sheet as the app would show it — derived, not stored, so it goes stale on its own.
 * See `sheet/baked.ts`.
 */
const sheet = (): Sheet | undefined =>
    handle.state === undefined ? undefined : currentSheet(handle.state)

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
    store?: Store,
    files?: Files,
    llama?: Llama
): Promise<{root: Root; host: HTMLElement}> => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
        root.render(
            <App
                volume={volume}
                name='car.vox'
                {...(store ? {store} : {})}
                {...(files ? {files} : {})}
                {...(llama ? {llama, scorer: memoryScorer([], false)} : {})}
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

test('one click bakes the sheet the export writes, at the size the panel says', async () => {
    const mounted = await mount()
    expect(sheet()).toBeUndefined()

    await act(async () => {
        control(mounted.host, 'Export sprite sheet').click()
    })

    expect(sheet()?.width).toBe(256)
    expect(sheet()?.height).toBe(128)
    expect(sheet()?.maps.color?.length).toBe(256 * 128 * 4)
    expect(mounted.host.textContent).toContain('Written: 256 × 128')

    // The grid above the button is the sheet's own cells, so it has to hold one per camera at the
    // size the sheet was cut to, and follow that size when it changes.
    const sprites = [...mounted.host.querySelectorAll('canvas.export-sprite')]
    expect(sprites).toHaveLength(8)
    expect(sprites[0]?.getAttribute('data-pixels')).toBe('64x64')

    await act(async () => {
        control(mounted.host, '32 px').click()
    })
    expect(mounted.host.querySelector('canvas.export-sprite')?.getAttribute('data-pixels')).toBe(
        '32x32'
    )

    await unmount(mounted)
})

test('capturing adds a ninth camera and throws the stale sheet away', async () => {
    const mounted = await mount()
    await act(async () => {
        control(mounted.host, 'Export sprite sheet').click()
    })
    expect(sheet()).toBeDefined()

    await act(async () => {
        control(mounted.host, 'Capture view as a camera').click()
    })

    expect(mounted.host.querySelectorAll('.views-strip canvas.thumbnail')).toHaveLength(9)
    expect(sheet()).toBeUndefined()

    await unmount(mounted)
})

test('the C shortcut in the hint bar is the shortcut, not a caption', async () => {
    const mounted = await mount()

    await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', {key: 'c'}))
    })
    expect(handle.state?.cameras).toHaveLength(9)

    // A shortcut that fires while the user is typing is a bug, not a shortcut.
    const field = document.createElement('input')
    document.body.appendChild(field)
    await act(async () => {
        field.dispatchEvent(new KeyboardEvent('keydown', {key: 'c', bubbles: true}))
    })
    expect(handle.state?.cameras).toHaveLength(9)
    field.remove()

    await unmount(mounted)
})

test('arming a tool and loading a colour reach the document, not just the panel', async () => {
    const mounted = await mount()
    expect(handle.state?.tool).toBe('draw')

    await act(async () => {
        control(mounted.host, 'Erase').click()
    })
    expect(handle.state?.tool).toBe('erase')
    expect(control(mounted.host, 'Erase').getAttribute('aria-checked')).toBe('true')
    expect(control(mounted.host, 'Draw').getAttribute('aria-checked')).toBe('false')

    // The palette is the model's own first, then DB32 — the car's three colours and 31 more, with
    // none of MagicaVoxel's ramp padding the grid out to its full 56.
    const swatches = [...mounted.host.querySelectorAll<HTMLElement>('.swatch')]
    expect(swatches.length).toBe(34)
    expect(swatches[0]?.getAttribute('aria-label')).toContain('used by this model')
    await act(async () => {
        swatches[3]?.click()
    })
    expect(String(handle.state?.color)).toBe(
        swatches[3]?.getAttribute('aria-label')?.replace(/\D/g, '') ?? ''
    )

    // The stepper stops at the document's bound rather than running past it, and says so where a
    // keyboard user can hear it — Astryx keeps a tooltipped control focusable and marks it
    // `aria-disabled` instead of dropping it out of the tab order.
    for (let i = 0; i < 10; i += 1) {
        await act(async () => {
            control(mounted.host, 'Larger brush').click()
        })
    }
    expect(handle.state?.brush.size).toBe(8)
    expect(control(mounted.host, 'Larger brush').getAttribute('aria-disabled')).toBe('true')

    await unmount(mounted)
})

test('the brush row goes dead for the tools that do not read it, and comes back for the ones that do', async () => {
    const mounted = await mount()
    const shapes = (): HTMLElement[] => [
        ...mounted.host.querySelectorAll<HTMLElement>('[aria-label="Brush shape"] .shape')
    ]
    const figures = (): HTMLElement[] => [
        ...mounted.host.querySelectorAll<HTMLElement>('[aria-label="Figure"] .shape')
    ]
    // The four shapes and the five figures of the two rows, so a silent renaming cannot pass here.
    expect(shapes()).toHaveLength(4)
    expect(figures()).toHaveLength(5)
    expect(shapes()[0]?.getAttribute('aria-disabled')).toBeNull()

    await act(async () => {
        control(mounted.host, 'Move').click()
    })
    expect(handle.state?.tool).toBe('move')
    expect(control(mounted.host, 'Smaller brush').getAttribute('aria-disabled')).toBe('true')
    expect(control(mounted.host, 'Larger brush').getAttribute('aria-disabled')).toBe('true')
    for (const button of [...shapes(), ...figures()]) {
        expect(button.getAttribute('aria-disabled')).toBe('true')
        // The label says which tool is the reason, not merely that the control is off.
        expect(button.getAttribute('aria-label')).toContain('Move does not use the brush')
    }

    // Greyed and inert, not greyed and still wired: a click on the ring changes nothing.
    const before = handle.state?.brush
    await act(async () => {
        shapes()[2]?.click()
        figures()[3]?.click()
    })
    expect(handle.state?.brush).toEqual(before as never)

    await act(async () => {
        control(mounted.host, 'Draw').click()
    })
    expect(shapes()[2]?.getAttribute('aria-disabled')).toBeNull()
    await act(async () => {
        shapes()[2]?.click()
    })
    expect(handle.state?.brush.shape).toBe('ring')

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

test('two snapshots in the same second are two distinct entries in the menu', async () => {
    // Autosave fires per committed edit, so this is the ordinary case, not a corner one: two strokes
    // inside a second used to render two menu items with one React key and log a warning.
    const backing = new Map<string, string>()
    const store = memoryStore(backing)
    const document_ = saveDocument(asSaved(), 'car.vox')
    const at = Date.parse('2026-08-07T19:11:18.000Z')
    backing.set('gofer-pixel/snapshot/' + String(at), JSON.stringify({...document_, at}))
    backing.set('gofer-pixel/snapshot/' + String(at + 400), JSON.stringify({...document_, at}))

    const mounted = await mount(store)
    await act(async () => {
        control(mounted.host, 'Main menu').click()
    })

    const labels = [...global.document.querySelectorAll('[role="menuitem"]')].map(node =>
        node.textContent.trim()
    )
    const restores = labels.filter(label => label.startsWith('Restore'))
    expect(restores).toHaveLength(2)
    expect(new Set(restores).size).toBe(2)

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
    const store = memoryStore()
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
 * Generation — `src/gen/`. Two things only the whole window can answer: that the menu reaches it at
 * all, and that a picked candidate lands in the *document* rather than in the dialog's own state.
 * Everything else about the dialog is in `GenerateDialog.test.tsx`, against the same canned ports.
 */
test('a generated candidate becomes the open document, provenance and all', async () => {
    const tower = {
        name: 'tower',
        size: [8, 8, 12] as [number, number, number],
        mirror_x: false,
        ops: [
            {
                // Ops are y-up: 6 wide, 12 tall, 6 deep. See `gen/ops.ts`.
                op: 'box' as const,
                from: [1, 0, 1] as [number, number, number],
                to: [6, 11, 6] as [number, number, number],
                color: '#808080'
            }
        ]
    }
    const mounted = await mount(memoryStore(), memoryFiles(), memoryLlama([tower], 'qwen'))

    await act(async () => {
        control(mounted.host, 'Main menu').click()
    })
    await act(async () => {
        menuItem('Generate a model…').click()
    })
    expect(openDialogTitle()).toBe('Generate a model')

    await act(async () => {
        control(global.document.body, 'Generate').click()
    })
    /*
     * A second, empty act. The click starts a batch it does not own, and the tail of that batch —
     * the failure count, the CLIP note — lands after the handler has returned. Not a wait: `act`
     * flushes what is already queued, and leaving it queued renders into a tree this test is about
     * to unmount. `GenerateDialog.test.tsx` awaits the batch itself through `onRunning`.
     */
    await act(async () => {
        // nothing to do; the flush is the point
    })
    await act(async () => {
        control(global.document.body, 'Use this one').click()
    })

    // The grid is fitted to the ops, so the tower is 12 tall on the volume's z.
    expect([handle.state?.volume.sx, handle.state?.volume.sz]).toEqual([6, 12])
    expect(handle.state?.doc).toMatchObject({name: 'tower', dirty: true, savedAt: undefined})
    expect(handle.state?.origin?.prompt).toBe('a stone tower')
    expect(handle.state?.origin?.model).toBe('qwen')
    // It is a document like any other from here — one object, cameras, an empty history.
    expect(handle.state?.objects.list).toHaveLength(1)
    expect(handle.state?.history.past).toHaveLength(0)
    // And the dialog is gone rather than sitting over the model it just handed over.
    expect(global.document.querySelector('[data-testid="generate-dialog"]')).toBeNull()

    await unmount(mounted)
})

test('Generate with unsaved work asks before it opens, like New and Open', async () => {
    const mounted = await mount(memoryStore(), memoryFiles(), memoryLlama([]))

    await act(async () => {
        handle.dispatch?.({type: 'object', op: {kind: 'add'}})
    })
    await act(async () => {
        control(mounted.host, 'Main menu').click()
    })
    await act(async () => {
        menuItem('Generate a model…').click()
    })

    // The guard, not the generate dialog: a candidate replaces the document, so the question is
    // asked before the minute is spent rather than after it.
    expect(openDialogTitle()).toContain('unsaved')
    await act(async () => {
        control(global.document.body, 'Discard').click()
    })
    expect(openDialogTitle()).toBe('Generate a model')

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

const withReference = async (plane: Axis = 1) => {
    const mounted = await mount()
    await act(async () => {
        handle.dispatch?.({type: 'reference', plane, url: PICTURE})
    })
    return mounted
}

const references = () => handle.state?.references ?? []

test('a reference appears with its row, and only once something has been dropped', async () => {
    const mounted = await mount()

    expect(mounted.host.textContent).not.toContain(' ref')
    expect(mounted.host.querySelector('.reference-layer')).toBeNull()

    await act(async () => {
        handle.dispatch?.({type: 'reference', plane: 1, url: PICTURE})
    })

    expect(references()).toEqual([{plane: 1, url: PICTURE, opacity: 0.5, locked: false}])
    expect(mounted.host.querySelector('.reference-layer image')?.getAttribute('href')).toBe(PICTURE)
    // The row names the plane it belongs to, so two references are told apart.
    expect(mounted.host.textContent).toContain('XZ ref')

    await unmount(mounted)
})

test('fainter and brighter step the reference opacity and stop at the ends', async () => {
    const mounted = await withReference()

    await act(async () => {
        control(mounted.host, 'Fainter reference').click()
    })
    expect(references()[0]?.opacity).toBeCloseTo(0.35, 6)

    await act(async () => {
        control(mounted.host, 'Brighter reference').click()
    })
    expect(references()[0]?.opacity).toBeCloseTo(0.5, 6)

    // Clamped, not wrapped: four more steps up would run past 1 without this.
    for (let step = 0; step < 5; step += 1)
        await act(async () => {
            control(mounted.host, 'Brighter reference').click()
        })
    expect(references()[0]?.opacity).toBe(1)

    for (let step = 0; step < 9; step += 1)
        await act(async () => {
            control(mounted.host, 'Fainter reference').click()
        })
    expect(references()[0]?.opacity).toBe(0)

    await unmount(mounted)
})

/*
 * The lock, and what replacing a picture means — one window, because neither depends on the other
 * having started from a clean one and each says what it changed.
 */
test('a locked reference cannot be faded or dropped by accident', async () => {
    const mounted = await withReference()

    const lock = control(mounted.host, 'Lock the reference')
    expect(lock.getAttribute('aria-checked')).toBe('false')
    // The button says which way it goes, rather than only which state it is in.
    expect(lock.getAttribute('title')).toContain('Lock it')

    await act(async () => {
        lock.click()
    })
    expect(references()[0]?.locked).toBe(true)
    expect(control(mounted.host, 'Lock the reference').getAttribute('title')).toBe(
        'Unlock the reference'
    )

    await act(async () => {
        control(mounted.host, 'Fainter reference').click()
    })
    await act(async () => {
        control(mounted.host, 'Remove the reference').click()
    })
    expect(references()).toEqual([{plane: 1, url: PICTURE, opacity: 0.5, locked: true}])

    // Unlocked again, the same two clicks land.
    await act(async () => {
        control(mounted.host, 'Lock the reference').click()
    })
    await act(async () => {
        control(mounted.host, 'Remove the reference').click()
    })
    expect(references()).toEqual([])
    expect(mounted.host.querySelector('.reference-layer')).toBeNull()

    await unmount(mounted)
})

test('a second picture on the same plane replaces the first rather than stacking', async () => {
    const mounted = await withReference()
    const other = 'data:image/png;base64,iVBORw0KGgoAAAA='

    await act(async () => {
        handle.dispatch?.({type: 'reference', plane: 1, url: other})
    })
    expect(references()).toEqual([{plane: 1, url: other, opacity: 0.5, locked: false}])
    expect(mounted.host.querySelectorAll('.reference-layer image')).toHaveLength(1)

    // A different plane is a different picture and both stay.
    await act(async () => {
        handle.dispatch?.({type: 'reference', plane: 2, url: PICTURE})
    })
    expect(references()).toHaveLength(2)
    expect(mounted.host.querySelectorAll('.reference-layer image')).toHaveLength(2)
    expect(mounted.host.textContent).toContain('XY ref')

    await unmount(mounted)
})

test('reference art survives a save and reopen', async () => {
    const disk = new Map<string, string>()
    const mounted = await mount(memoryStore(), memoryFiles(disk))

    await act(async () => {
        handle.dispatch?.({type: 'reference', plane: 0, url: PICTURE})
    })
    await act(async () => {
        handle.dispatch?.({type: 'reference-lock', plane: 0, on: true})
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
 * The Renders panel — `docs/editor.png`'s RENDERS row. Five maps off one ray, at four sizes, plus
 * §19's normal check under the one map it belongs to.
 */
test('picking a map redraws the preview, and only Normal brings the light check with it', async () => {
    const mounted = await mount()
    const preview = () => mounted.host.querySelector('canvas.render-canvas')

    expect(handle.state?.map).toBe(0)
    expect(mounted.host.querySelector('.normal-check')).toBeNull()

    await act(async () => {
        control(mounted.host, 'Normal').click()
    })
    expect(handle.state?.map).toBe(1)
    expect(mounted.host.querySelector('.normal-check')).not.toBeNull()
    expect(mounted.host.textContent).toContain('% of the sprite faces the light')
    expect(mounted.host.textContent).toContain('+X right, +Y up, +Z out of the screen')

    await act(async () => {
        control(mounted.host, 'AO').click()
    })
    expect(handle.state?.map).toBe(4)
    expect(mounted.host.querySelector('.normal-check')).toBeNull()
    expect(preview()).not.toBeNull()

    await unmount(mounted)
})

test('the preview size is the sprite size, not the size of the box it sits in', async () => {
    const mounted = await mount()
    const preview = () => mounted.host.querySelector('canvas.render-canvas')

    expect(preview()?.getAttribute('data-pixels')).toBe('64x64')

    await act(async () => {
        control(mounted.host, 'Preview at 16 pixels').click()
    })
    expect(handle.state?.preview).toBe(16)
    expect(preview()?.getAttribute('data-pixels')).toBe('16x16')

    // And the light check follows it, so both halves of the diagnostic show the same pixels.
    await act(async () => {
        control(mounted.host, 'Normal').click()
    })
    expect(mounted.host.querySelector('.normal-check canvas')?.getAttribute('data-pixels')).toBe(
        '16x16'
    )

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

    await unmount(mounted)
})

/*
 * The selection bar — `FEATURESET.md` §4 and §39. Nine transforms, a duplicate and a delete, and
 * they exist only while something is selected.
 */
test('the selection bar appears with a selection and its transforms reach the document', async () => {
    const mounted = await mount()
    const bar = () => mounted.host.querySelector('[role="toolbar"][aria-label="Selection"]')

    expect(bar()).toBeNull()

    /*
     * A lopsided little model rather than the car: a transform is only visible if the thing being
     * transformed is asymmetric, and a rotate that would push the selection off the grid is refused
     * whole — so the test builds a shape with room to turn in.
     */
    const grid = createVolume(8, 8, 8, volume.palette)
    for (let x = 0; x < 3; x += 1) grid.data[x + 8 * (3 + 8 * 3)] = 1
    grid.data[1 + 8 * (4 + 8 * 3)] = 1
    await act(async () => {
        handle.dispatch?.({
            type: 'new',
            volume: grid,
            objects: initialObjects(grid),
            name: 'shape.gpix'
        })
    })
    await act(async () => {
        handle.dispatch?.({type: 'select-color', color: 1})
    })
    expect(bar()).not.toBeNull()
    expect(bar()?.textContent).toContain('4 voxels')

    // Each of the three families moves the voxels somewhere the last two did not.
    const shapes = new Set<string>()
    for (const label of ['Rotate 90° about Z', 'Flip X', 'Mirror across Y']) {
        await act(async () => {
            control(mounted.host, label).click()
        })
        shapes.add((handle.state?.volume.data ?? new Uint8Array()).join(''))
    }
    expect(shapes.size).toBe(3)

    const before = handle.state?.volume.data.filter(Boolean).length ?? 0
    await act(async () => {
        control(mounted.host, 'Duplicate one voxel up').click()
    })
    expect(handle.state?.volume.data.filter(Boolean).length).toBeGreaterThan(before)

    await act(async () => {
        control(mounted.host, 'Delete selected voxels').click()
    })
    expect(handle.state?.selection.size).toBe(0)
    expect(bar()).toBeNull()

    // And with something chosen again, Deselect takes the bar back off the viewport.
    await act(async () => {
        handle.dispatch?.({type: 'select-color', color: 1})
    })
    await act(async () => {
        control(mounted.host, 'Deselect').click()
    })
    expect(bar()).toBeNull()

    await unmount(mounted)
})

/*
 * The views strip is the sheet's own order, so everything that rewires it invalidates the bake.
 * `FEATURESET.md` §16's "drag to reorder" is the one that has no keyboard equivalent to fall back
 * on, which is why it is driven here as three drag events rather than trusted to the reducer.
 */
test('the views strip rebuilds, aligns, duplicates, deletes and reorders the camera list', async () => {
    const mounted = await mount()
    const names = () => (handle.state?.cameras ?? []).map(entry => entry.name)

    expect(names()).toHaveLength(8)

    await act(async () => {
        control(mounted.host, 'Create 4 directions').click()
    })
    expect(names()).toHaveLength(4)

    await act(async () => {
        within(mounted.host, '.views-strip', 'Right').click()
    })
    await act(async () => {
        control(mounted.host, 'Duplicate camera').click()
    })
    expect(names()).toHaveLength(5)

    await act(async () => {
        control(mounted.host, 'Delete camera').click()
    })
    expect(names()).toHaveLength(4)

    // Align turns the live view to the nearest stop, which is what makes a captured camera square.
    await act(async () => {
        handle.dispatch?.({
            type: 'orbit',
            event: {type: 'pointerdown', x: 100, y: 100, secondary: false},
            height: 512
        })
    })
    await act(async () => {
        handle.dispatch?.({
            type: 'orbit',
            event: {type: 'pointermove', x: 137, y: 118},
            height: 512
        })
    })
    await act(async () => {
        handle.dispatch?.({type: 'orbit', event: {type: 'pointerup'}, height: 512})
    })
    const crooked = handle.state?.orbit.camera.yaw ?? 0
    await act(async () => {
        control(mounted.host, 'Align the view to the nearest stop').click()
    })
    expect(handle.state?.orbit.camera.yaw).not.toBe(crooked)

    const order = names()
    const tiles = [...mounted.host.querySelectorAll('.views-strip [role="radio"]')]
    const [first, , third] = tiles
    if (!first || !third) throw new Error('the strip should hold four cameras')
    await act(async () => {
        first.dispatchEvent(new Event('pointerdown', {bubbles: true}))
    })
    expect(handle.state?.dragging).toBeDefined()
    await act(async () => {
        third.dispatchEvent(new Event('pointerover', {bubbles: true}))
    })
    await act(async () => {
        third.dispatchEvent(new Event('pointerup', {bubbles: true}))
    })
    expect(handle.state?.dragging).toBeUndefined()
    expect(names()).not.toEqual(order)
    expect(names().toSorted()).toEqual(order.toSorted())

    await unmount(mounted)
})

/*
 * The export panel. Every knob here changes bytes in a file, so each one is checked against the
 * sheet the reducer produced rather than against the control's own state.
 */
test('padding, bounds and sprite size are the sheet’s own numbers', async () => {
    const mounted = await mount()

    await act(async () => {
        control(mounted.host, '2 pixels of padding').click()
    })
    expect(handle.state?.padding).toBe(2)

    // Astryx's Switch is a checkbox with a `<label for>` beside it, so it is reached by role.
    const box = mounted.host.querySelector<HTMLElement>('.export-body input[role="switch"]')
    if (!box) throw new Error('no collision-box switch')
    const wasBoxed = handle.state?.bounds
    await act(async () => {
        box.click()
    })
    expect(handle.state?.bounds).toBe(!wasBoxed)

    await act(async () => {
        control(mounted.host, '32 px').click()
    })
    await act(async () => {
        control(mounted.host, 'Export sprite sheet').click()
    })

    // Four across, eight cameras: two rows of 32 px cells with 2 px around and between.
    expect(sheet()?.width).toBe(4 * 34 + 2)
    expect(sheet()?.height).toBe(2 * 34 + 2)
    expect(sheet()?.padding).toBe(2)
    expect(handle.state?.bounds).toBe(!wasBoxed)

    await unmount(mounted)
})

test('the two extra downloads do nothing until there is a sheet to cut them from', async () => {
    const written: string[] = []
    const realCreate = URL.createObjectURL
    const realClick = HTMLAnchorElement.prototype.click
    URL.createObjectURL = (): string => 'blob:test'
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
        written.push(this.download)
    }

    try {
        const mounted = await mount()
        // The menu closes on every pick, so it is opened once per item.
        const pick = async (label: string): Promise<void> => {
            await act(async () => {
                control(mounted.host, 'More export options').click()
            })
            await act(async () => {
                menuItem(label).click()
            })
        }

        await pick('Download every sprite separately')
        await pick('Download metadata JSON')
        expect(written).toEqual([])

        await act(async () => {
            control(mounted.host, 'Export sprite sheet').click()
        })
        written.length = 0

        await pick('Download every sprite separately')
        await pick('Download metadata JSON')
        /*
         * One PNG per camera, plus the JSON that says where each of them landed.
         *
         * The sheet's own two files are excluded by name rather than by the clear above. Export
         * writes them from an effect, through a `CompressionStream` that settles on the macrotask
         * queue, so `sprites.png` and `sprites-normal.png` can land *after* the clear — which made
         * this count 10 on about one run in three, depending on what else the suite had queued.
         */
        const sprites = written.filter(name => name.endsWith('.png') && !name.startsWith('sprites'))
        expect(sprites).toHaveLength(8)
        expect(written).toContain('sprites.json')

        await unmount(mounted)
    } finally {
        URL.createObjectURL = realCreate
        HTMLAnchorElement.prototype.click = realClick
    }
})

test('saving a preset takes the name the artist typed, and a cancelled prompt saves nothing', async () => {
    const realPrompt = globalThis.prompt
    const answers: (string | null)[] = [null, 'Mine']
    globalThis.prompt = (): string | null => answers.shift() ?? null

    try {
        const mounted = await mount()
        const presets = () => (handle.state?.presets ?? []).length

        const before = presets()
        await act(async () => {
            control(mounted.host, 'Save these maps as a preset').click()
        })
        expect(presets()).toBe(before)

        await act(async () => {
            control(mounted.host, 'Save these maps as a preset').click()
        })
        expect(presets()).toBe(before + 1)
        expect(handle.state?.preset).toBe('Mine')

        await unmount(mounted)
    } finally {
        globalThis.prompt = realPrompt
    }
})

/*
 * The objects panel — `FEATURESET.md` §18. Show, solo, lock, duplicate, delete and the search box,
 * driven from the row rather than from the reducer, because the row is where the wiring can rot.
 */
test('the objects panel’s switches and its search reach the document', async () => {
    const mounted = await mount()
    const objects = () => handle.state?.objects.list ?? []

    await act(async () => {
        control(mounted.host, 'Add an object').click()
    })
    expect(objects()).toHaveLength(2)
    const added = objects()[1]?.name ?? ''

    await act(async () => {
        control(mounted.host, `Show ${added}`).click()
    })
    expect(objects()[1]?.hidden).toBe(true)

    await act(async () => {
        control(mounted.host, `Lock ${added}`).click()
    })
    expect(objects()[1]?.locked).toBe(true)

    // Solo is one field on the list, not `hidden` on every other row: turning it off has to put
    // back exactly what was hidden before, and a per-row flag could not.
    await act(async () => {
        control(mounted.host, `Show only ${added}`).click()
    })
    expect(handle.state?.objects.solo).toBe(objects()[1]?.id)
    await act(async () => {
        control(mounted.host, `Show only ${added}`).click()
    })
    expect(handle.state?.objects.solo).toBeUndefined()

    await act(async () => {
        control(mounted.host, `Duplicate ${added}`).click()
    })
    expect(objects()).toHaveLength(3)

    // The search box only appears past `SEARCH_FROM`, so there has to be something to search.
    for (let step = 0; step < 7; step += 1)
        await act(async () => {
            handle.dispatch?.({type: 'object', op: {kind: 'add'}})
        })
    const rows = () => mounted.host.querySelectorAll('.object-list [role="radio"]').length
    const all = rows()
    expect(all).toBeGreaterThan(8)

    const field = mounted.host.querySelector<HTMLInputElement>('.object-body input[type="text"]')
    if (!field) throw new Error('no search box')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
        setter?.call(field, 'nothing-matches-this')
        field.dispatchEvent(new Event('input', {bubbles: true}))
    })
    expect(handle.state?.search).toBe('nothing-matches-this')

    // Nothing left, and the list says so rather than showing an empty box.
    expect(rows()).toBe(0)
    expect(mounted.host.querySelector('.object-list')?.textContent).toBe('No object matches that.')

    await unmount(mounted)
})

/*
 * A `.vox` is MagicaVoxel's format and arrives as an untitled document; anything that will not
 * parse is refused without touching what is open. A half-loaded document is the one outcome
 * `doc/save.ts` exists to prevent, so the refusal is the assertion that matters here.
 *
 * `memoryFiles` carries text, and a `.vox` is a RIFF container full of arbitrary bytes — so these
 * two bring their own port rather than round-tripping the model through UTF-8.
 */
/*
 * The brush column. Every one of these is a one-line closure between a panel and the reducer, which
 * is exactly the kind of wiring that rots without anyone noticing: the control still moves, the
 * document stops hearing about it.
 */
test('the brush and palette controls reach the document', async () => {
    const mounted = await mount()
    const paletteSwitch = (label: string): HTMLElement => {
        const found = [...mounted.host.querySelectorAll<HTMLElement>('.brush-column label')].find(
            node => node.textContent.trim() === label
        )
        const input =
            found?.previousElementSibling?.querySelector<HTMLElement>('input')
            ?? mounted.host.querySelector<HTMLElement>(
                `input[id="${found?.getAttribute('for') ?? ''}"]`
            )
        if (!input) throw new Error(`no switch labelled "${label}"`)
        return input
    }

    await act(async () => {
        control(mounted.host, 'Larger brush').click()
    })
    expect(handle.state?.brush.size).toBe(3)
    await act(async () => {
        control(mounted.host, 'Smaller brush').click()
    })
    expect(handle.state?.brush.size).toBe(2)

    // Emissive is a property of the loaded colour, not of the brush — it follows the palette entry.
    await act(async () => {
        paletteSwitch('Emissive').click()
    })
    expect(handle.state?.volume.emissive[handle.state.color]).toBeGreaterThan(0)

    await act(async () => {
        paletteSwitch('Lock').click()
    })
    expect(handle.state?.paletteLocked).toBe(true)

    await act(async () => {
        control(mounted.host, 'Add a colour to the palette').click()
    })
    expect(handle.state?.color).toBeGreaterThan(0)

    await act(async () => {
        control(mounted.host, 'Pick a colour from the model').click()
    })
    expect(handle.state?.tool).toBe('pick')

    await unmount(mounted)
})

test('recoloring a palette entry repaints every voxel that was using it', async () => {
    const mounted = await mount()
    const loaded = handle.state?.color ?? 1

    const field = mounted.host.querySelector<HTMLInputElement>(
        `input[aria-label="Colour of palette entry ${String(loaded)}"]`
    )
    if (!field) throw new Error('no colour field')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
        setter?.call(field, '#123456')
        field.dispatchEvent(new Event('input', {bubbles: true}))
    })

    expect([...(handle.state?.volume.palette ?? []).slice(loaded * 4, loaded * 4 + 3)]).toEqual([
        0x12, 0x34, 0x56
    ])

    await unmount(mounted)
})

/*
 * The scene toggles under the viewport — grid, edges, snap, invert — plus symmetry and the drawing
 * plane. `FEATURESET.md` §5 and §12.
 */
test('the scene toggles, symmetry and the drawing plane all reach the document', async () => {
    const mounted = await mount()
    const toggle = (label: string): HTMLElement => {
        const row = [...mounted.host.querySelectorAll<HTMLElement>('.snap-toggle')].find(node =>
            node.textContent.includes(label)
        )
        const input = row?.querySelector<HTMLElement>('input[role="switch"]')
        if (!input) throw new Error(`no toggle labelled "${label}"`)
        return input
    }

    for (const [label, field] of [
        ['Grid', 'grid'],
        ['Edges', 'edges'],
        ['Snap', 'snap'],
        ['Invert', 'invert']
    ] as const) {
        const was = handle.state?.[field]
        await act(async () => {
            toggle(label).click()
        })
        expect(handle.state?.[field]).toBe(!was)
    }

    await act(async () => {
        control(mounted.host, 'Mirror drawing across X').click()
    })
    expect(handle.state?.symmetry.x).toBe(true)

    // The car is 16 × 10, so radial is refused and says so rather than going quietly dead.
    const radial = control(mounted.host, 'Radial symmetry needs a grid that is square in X and Y')
    await act(async () => {
        radial.click()
    })
    expect(handle.state?.symmetry.radial).toBe(false)

    await act(async () => {
        control(mounted.host, 'Lock drawing to the XY plane').click()
    })
    expect(handle.state?.plane).toBe(2)
    await act(async () => {
        control(mounted.host, 'Draw on the face under the cursor').click()
    })
    expect(handle.state?.plane).toBeUndefined()

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

test('the palette writes back out as a .hex file', async () => {
    const written: string[] = []
    const realCreate = URL.createObjectURL
    const realClick = HTMLAnchorElement.prototype.click
    URL.createObjectURL = (): string => 'blob:test'
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
        written.push(this.download)
    }

    try {
        const mounted = await mount()
        await act(async () => {
            control(mounted.host, 'Save the palette').click()
        })
        expect(written).toEqual(['palette.hex'])
        await unmount(mounted)
    } finally {
        URL.createObjectURL = realCreate
        HTMLAnchorElement.prototype.click = realClick
    }
})

/*
 * The objects panel's three gestures that are not a switch — `FEATURESET.md` §18.
 *
 * Rename is a double-click, delete asks first, and reorder is a drag on the name and nowhere else.
 * All three are state the panel keeps for itself, so none of them show up in a reducer test.
 */
const objectRows = (host: HTMLElement): HTMLElement[] => [
    ...host.querySelectorAll<HTMLElement>('.object-list .object-name')
]

test('a name renames in place, and Enter and Escape both put the row back', async () => {
    const mounted = await mount()
    await act(async () => {
        handle.dispatch?.({type: 'object', op: {kind: 'add'}})
    })

    const [, added] = objectRows(mounted.host)
    if (!added) throw new Error('no second object')
    await act(async () => {
        added.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}))
    })

    const field = mounted.host.querySelector<HTMLInputElement>('.object-list input[type="text"]')
    if (!field) throw new Error('the row should have turned into a field')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
        setter?.call(field, 'Roof')
        field.dispatchEvent(new Event('input', {bubbles: true}))
    })
    expect(handle.state?.objects.list[1]?.name).toBe('Roof')

    await act(async () => {
        field.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
    })
    expect(mounted.host.querySelector('.object-list input[type="text"]')).toBeNull()
    expect(objectRows(mounted.host)[1]?.textContent).toContain('Roof')

    // Escape leaves it too — a field that only closes on Enter is a field with no way out.
    await act(async () => {
        objectRows(mounted.host)[1]?.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}))
    })
    const again = mounted.host.querySelector<HTMLElement>('.object-list input[type="text"]')
    await act(async () => {
        again?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))
    })
    expect(mounted.host.querySelector('.object-list input[type="text"]')).toBeNull()

    await unmount(mounted)
})

/*
 * "You can undo it" is not a reason to let a stray click cost an hour in silence, so the dialog
 * says the name and the voxel count — the whole of what is about to be lost.
 */
test('deleting an object asks first, and says how many voxels go with it', async () => {
    const mounted = await mount()
    await act(async () => {
        handle.dispatch?.({type: 'object', op: {kind: 'add'}})
    })
    const empty = handle.state?.objects.list[1]?.name ?? ''

    await act(async () => {
        control(mounted.host, `Delete ${empty}`).click()
    })
    expect(openDialogTitle()).toBe(`Delete ${empty}?`)
    expect(global.document.querySelector('dialog[open]')?.textContent).toContain('It is empty')

    // Cancelling leaves the object where it was.
    await act(async () => {
        control(global.document.body, 'Cancel').click()
    })
    expect(handle.state?.objects.list).toHaveLength(2)

    // The one with the voxels in it counts them instead.
    const model = handle.state?.objects.list[0]?.name ?? ''
    await act(async () => {
        control(mounted.host, `Delete ${model}`).click()
    })
    expect(global.document.querySelector('dialog[open]')?.textContent).toContain('478 voxels')

    await act(async () => {
        control(global.document.body, 'Delete').click()
    })
    expect(handle.state?.objects.list).toHaveLength(1)
    expect(handle.state?.objects.list[0]?.name).toBe(empty)

    await unmount(mounted)
})

test('a row drags along the list to reorder it, and the drag dies with the pointer', async () => {
    const mounted = await mount()
    for (let step = 0; step < 2; step += 1)
        await act(async () => {
            handle.dispatch?.({type: 'object', op: {kind: 'add'}})
        })
    const order = () => (handle.state?.objects.list ?? []).map(entry => entry.name)
    const before = order()
    expect(before).toHaveLength(3)

    const rows = objectRows(mounted.host)
    const [first, , third] = rows
    if (!first || !third) throw new Error('three rows expected')

    // The drag starts on the name and nowhere else — starting it on the row would arm a reorder
    // every time one of the switches beside it was pressed.
    await act(async () => {
        first.dispatchEvent(new Event('pointerdown', {bubbles: true}))
    })
    await act(async () => {
        third.dispatchEvent(new Event('pointerover', {bubbles: true}))
    })
    await act(async () => {
        third.dispatchEvent(new Event('pointerup', {bubbles: true}))
    })

    expect(order()).not.toEqual(before)
    expect(order().toSorted()).toEqual(before.toSorted())

    // A pointer that leaves the list has dropped the row: the next hover must not keep reordering.
    const dropped = order()
    await act(async () => {
        objectRows(mounted.host)[0]?.dispatchEvent(new Event('pointerdown', {bubbles: true}))
    })
    await act(async () => {
        mounted.host
            .querySelector('.object-list')
            ?.dispatchEvent(new Event('pointerout', {bubbles: true}))
    })
    await act(async () => {
        objectRows(mounted.host)[2]?.dispatchEvent(new Event('pointerover', {bubbles: true}))
    })
    expect(order()).toEqual(dropped)

    await unmount(mounted)
})

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

const swatch = (host: HTMLElement, index: number): HTMLElement => {
    const found = [...host.querySelectorAll<HTMLElement>('.swatches .swatch')].find(node =>
        node.getAttribute('aria-label')?.startsWith(`Colour ${String(index)}`)
    )
    if (!found) throw new Error(`no swatch for colour ${String(index)}`)
    return found
}

test('shift-clicking a swatch selects every voxel of that colour', async () => {
    const mounted = await mount()
    expect(handle.state?.selection.size).toBe(0)

    await act(async () => {
        swatch(mounted.host, 1).dispatchEvent(
            new MouseEvent('click', {bubbles: true, shiftKey: true})
        )
    })

    expect(handle.state?.selection.size).toBeGreaterThan(0)

    await unmount(mounted)
})

test('alt-clicking a swatch repaints the loaded colour’s voxels with it', async () => {
    const mounted = await mount()
    const loaded = handle.state?.color ?? 1
    const of = (index: number): number =>
        (handle.state?.volume.data ?? new Uint8Array()).filter(value => value === index).length
    const before = of(loaded)
    expect(before).toBeGreaterThan(0)

    const other = [...(handle.state?.volume.data ?? [])].find(
        value => value !== 0 && value !== loaded
    )
    if (other === undefined) throw new Error('the model should use more than one colour')

    await act(async () => {
        swatch(mounted.host, other).dispatchEvent(
            new MouseEvent('click', {bubbles: true, altKey: true})
        )
    })

    expect(of(loaded)).toBe(0)
    expect(of(other)).toBeGreaterThan(before)

    await unmount(mounted)
})

test('a recent colour loads it back without going hunting in the grid', async () => {
    const mounted = await mount()

    // Two colours used, so the recent row appears at all.
    await act(async () => {
        handle.dispatch?.({type: 'color', color: 2})
    })
    await act(async () => {
        handle.dispatch?.({type: 'color', color: 5})
    })

    const recent = mounted.host.querySelector<HTMLElement>(
        '.recent-swatches [aria-label="Recent colour 2"]'
    )
    if (!recent) throw new Error('no recent swatch for colour 2')
    await act(async () => {
        recent.click()
    })

    expect(handle.state?.color).toBe(2)

    await unmount(mounted)
})

test('a preset changes which maps an export writes', async () => {
    const mounted = await mount()
    expect(handle.state?.preset).toBe('Sprite Sheet (Auto)')

    // Astryx's Selector keeps its listbox in the tree, so the option is reachable without the
    // popover having been opened first.
    const option = [...mounted.host.querySelectorAll<HTMLElement>('[role="option"]')].find(
        node => node.textContent.trim() === 'Every map'
    )
    if (!option) throw new Error('no "Every map" option')
    await act(async () => {
        option.click()
    })

    expect(handle.state?.preset).toBe('Every map')

    // The smallest sprite the panel offers: what is being checked is which maps get baked, and
    // eight PNG encodes of a 256 × 128 sheet cost a second to prove nothing about that.
    await act(async () => {
        control(mounted.host, '32 px').click()
    })
    await act(async () => {
        control(mounted.host, 'Export sprite sheet').click()
    })
    expect(Object.keys(sheet()?.maps ?? {})).toHaveLength(8)

    await unmount(mounted)
})

test('with every camera deleted the render panel says so instead of showing a blank box', async () => {
    const mounted = await mount()

    // Selected, deleted, selected again: the button acts on the chosen camera and the choice does
    // not survive the deletion.
    for (let step = 0; step < 8; step += 1) {
        const next = handle.state?.cameras[0]
        if (!next) break
        await act(async () => {
            within(mounted.host, '.views-strip', next.name).click()
        })
        await act(async () => {
            control(mounted.host, 'Delete camera').click()
        })
    }

    expect(handle.state?.cameras).toEqual([])
    expect(mounted.host.querySelector('.render-preview')?.textContent).toBe(
        'No cameras — capture one to preview its maps.'
    )
    expect(mounted.host.querySelector('canvas.render-canvas')).toBeNull()

    await unmount(mounted)
})

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
