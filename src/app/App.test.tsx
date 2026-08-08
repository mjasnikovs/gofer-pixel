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

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

/**
 * Real React, real DOM nodes, real clicks — and nothing waits, because `act` flushes synchronously
 * and a click is `element.click()`. The window has no GPU here, which is the point: the viewport
 * fails to get a context and every other panel still works, because none of them are downstream of
 * one.
 */
const mount = async (store?: Store, files?: Files): Promise<{root: Root; host: HTMLElement}> => {
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
    output: DEFAULT_OUTPUT
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
    expect(handle.state?.sheet).toBeUndefined()

    await act(async () => {
        control(mounted.host, 'Export sprite sheet').click()
    })

    expect(handle.state?.sheet?.width).toBe(256)
    expect(handle.state?.sheet?.height).toBe(128)
    expect(handle.state?.sheet?.maps.color?.length).toBe(256 * 128 * 4)
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
    expect(handle.state?.sheet).toBeDefined()

    await act(async () => {
        control(mounted.host, 'Capture view as a camera').click()
    })

    expect(mounted.host.querySelectorAll('.views-strip canvas.thumbnail')).toHaveLength(9)
    expect(handle.state?.sheet).toBeUndefined()

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

test('a cancelled save leaves the document unsaved rather than claiming it was written', async () => {
    const disk = new Map<string, string>()
    const mounted = await mount(
        memoryStore(),
        memoryFiles(disk, () => undefined)
    )

    await act(async () => {
        handle.dispatch?.({type: 'object', op: {kind: 'add'}})
    })
    await act(async () => {
        control(mounted.host, 'Main menu').click()
    })
    await act(async () => {
        menuItem('Save').click()
    })

    expect(disk.size).toBe(0)
    expect(handle.state?.doc.dirty).toBe(true)
    expect(handle.state?.doc.savedAt).toBeUndefined()

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
