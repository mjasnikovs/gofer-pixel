import {expect, test} from 'bun:test'
import {mountPanel, type Panel} from '../../test/panel'
import {memoryFiles, type Files} from '../doc/files'
import {shownVolume} from '../doc/objects'
import {readVox} from '../vox/vox-file'
import {ExportDialog} from './ExportDialog'
import {slicedFor} from './state'

/**
 * The export dialog over the real reducer — see `test/panel.tsx`.
 *
 * It is a dialog rather than a panel, but it takes the same `state` and `dispatch` and nothing else
 * that is not a port or a derivation, which is what that harness is for. The two derivations
 * `App.tsx` memoises are computed here from the same two functions the app uses.
 *
 * Astryx puts a `Dialog` and a `MoreMenu` in portals on `document.body`, so most of what is under
 * test is not inside `panel.host`. Every query below says which one it means.
 */

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

/**
 * A disk of this test's own, plus a promise for the writes to have landed.
 *
 * A click hands its work to a `void`ed promise, and the work is real: a PNG encode is a
 * `CompressionStream`, so the bytes reach the port one task after `act` has flushed React. This
 * waits for *the write*, not for a number of milliseconds — the testing law forbids the second and
 * has nothing against the first. See `docs/techstack.md` §3.
 */
const disk = () => {
    const backing = new Map<string, string | Uint8Array>()
    const real = memoryFiles(backing)
    let landed: (() => void) | undefined
    let count = 0
    let wanted = Infinity
    return {
        files: {
            ...real,
            write: async (name: string, data: string | Uint8Array, type: string) => {
                await real.write(name, data, type)
                count += 1
                if (count >= wanted) landed?.()
            }
        } satisfies Files,
        names: (): string[] => [...backing.keys()],
        /** Resolves once `n` more files have reached the port. */
        after: (n: number): Promise<void> => {
            wanted = count + n
            return new Promise<void>(resolve => {
                landed = resolve
            })
        }
    }
}

const open = (files: Files = memoryFiles()): Promise<Panel> =>
    mountPanel(
        volume,
        ({state, dispatch}) => (
            <ExportDialog
                state={state}
                dispatch={dispatch}
                files={files}
                volume={slicedFor(state, shownVolume(state.volume, state.objects))}
                onClose={() => undefined}
            />
        ),
        // The smallest sprite on offer. What is under test is which files land and what is in them;
        // eight PNG encodes of a 256 px sheet cost a second and prove none of it.
        state => ({...state, output: {...state.output, cell: 32, cellH: 32}})
    )

/**
 * The *last* node matching, not the first.
 *
 * A test that fails before its `unmount` leaves its portal on `document.body`, and a first-match
 * query would then hand every later test the dead dialog's controls — one failure reported as five.
 * Portals append, so the newest is last.
 */
const last = <T extends HTMLElement>(
    selector: string,
    is: (node: T) => boolean = () => true
): T => {
    const found = [...global.document.querySelectorAll<T>(selector)].filter(is).at(-1)
    if (!found) throw new Error(`nothing matching "${selector}"`)
    return found
}

/** Anything in the dialog, which is a portal and therefore not under `panel.host`. */
const inside = (selector: string): HTMLElement => last<HTMLElement>(selector)

const press = (label: string): HTMLElement =>
    last<HTMLElement>(
        'button, input',
        node => node.getAttribute('aria-label') === label || node.textContent.trim() === label
    )

/**
 * One option of one segmented control, named by its group.
 *
 * Sprite width and sprite height offer the same three labels, so `press('128 px')` is ambiguous
 * between them — and a plain last-match would always land on the width, which is the control that
 * does *not* set the scale.
 */
const sizeOption = (group: string, label: string): HTMLElement =>
    last<HTMLElement>(
        `[role="radiogroup"][aria-label="${group}"] [role="radio"]`,
        node => node.textContent.trim() === label
    )

const menuItem = (label: string): HTMLElement =>
    last<HTMLElement>('[role="menuitem"]', node => node.textContent.trim() === label)

/** The tick beside one map row. Astryx labels it with a `<label>`, so it is reached by its row. */
const tick = (map: string): HTMLInputElement =>
    last<HTMLInputElement>(`.export-map[data-map="${map}"] input[type="checkbox"]`)

test('padding and sprite size are the document’s own numbers', async () => {
    const panel = await open()

    await panel.act(() => {
        press('2 pixels of padding').click()
    })
    expect(panel.state().output.padding).toBe(2)

    await panel.act(() => {
        press('64 px').click()
    })
    expect(panel.state().output.cell).toBe(64)

    await panel.unmount()
})

/*
 * The preview is the export: every cell on screen is `cutCell` out of the sheet the buttons write,
 * so the canvas is the sprite's own size and there is one per camera. It used to be a `Thumbnail`,
 * which renders a *second* time through `sprite-cache.ts` — five of eight maps, and a depth mode
 * that is deliberately not the exported one.
 */
test('there is one cell per camera, at the sprite’s own size', async () => {
    const panel = await open()
    const cells = global.document.querySelectorAll('.export-sprite')
    expect(cells).toHaveLength(panel.state().cameras.length)
    expect(cells[0]?.getAttribute('data-pixels')).toBe('32x32')

    // Two controls now, and they offer the same three labels — the height is the one that sets
    // the scale, so a query that cannot tell them apart is testing the wrong half.
    await panel.act(() => {
        sizeOption('Sprite height', '128 px').click()
    })
    expect(inside('.export-sprite').getAttribute('data-pixels')).toBe('32x128')

    await panel.act(() => {
        sizeOption('Sprite width', '128 px').click()
    })
    expect(inside('.export-sprite').getAttribute('data-pixels')).toBe('128x128')

    await panel.unmount()
})

test('the ticks follow the preset, and a map the preset does not name is unticked', async () => {
    const panel = await open()
    expect(tick('normal').checked).toBe(true)
    expect(tick('ao').checked).toBe(false)

    // Astryx's Selector keeps its listbox in the tree, so the option is reachable without the
    // popover having been opened first.
    const option = [...global.document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        node => node.textContent.trim() === 'Every map'
    )
    if (!option) throw new Error('no "Every map" option')
    await panel.act(() => {
        option.click()
    })
    expect(panel.state().output.preset).toBe('Every map')
    expect(tick('ao').checked).toBe(true)

    await panel.unmount()
})

/*
 * `car.vox` has nothing glowing in it and is one object, so two of the eight maps would be written
 * blank — see `sheet/empty.ts`. The dialog greys them, unticks them, and drops them from the write
 * even when the preset names them.
 */
test('a map that would be blank is greyed, unticked and left out of the pack', async () => {
    const out = disk()
    const panel = await open(out.files)

    const option = [...global.document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        node => node.textContent.trim() === 'Every map'
    )
    if (!option) throw new Error('no "Every map" option')
    await panel.act(() => {
        option.click()
    })

    expect(tick('emission').checked).toBe(false)
    expect(tick('object').checked).toBe(false)
    expect(tick('depth').checked).toBe(true)

    await panel.act(() => {
        press('More export options').click()
    })
    const loose = out.after(6)
    await panel.act(() => {
        menuItem('Download the maps as loose PNGs').click()
    })
    await loose
    expect(out.names().toSorted()).toEqual([
        'sprites-ao.png',
        'sprites-depth.png',
        'sprites-height.png',
        'sprites-index.png',
        'sprites-normal.png',
        'sprites.png'
    ])

    await panel.unmount()
})

/*
 * Colour is not optional. `renderSheet` puts it back whatever it is asked for, so a tick that could
 * be cleared would be a box that says one thing and a file that says another.
 */
test('colour cannot be unticked', async () => {
    const panel = await open()
    await panel.act(() => {
        tick('color').click()
    })
    expect(tick('color').checked).toBe(true)

    await panel.act(() => {
        tick('normal').click()
    })
    expect(tick('normal').checked).toBe(false)

    await panel.unmount()
})

test('the primary button writes one zip, named after the document', async () => {
    const out = disk()
    const panel = await open(out.files)

    const packed = out.after(1)
    await panel.act(() => {
        press('Export pack').click()
    })
    await packed
    expect(out.names()).toEqual(['car-vox.zip'])

    await panel.unmount()
})

/*
 * The menu items that write, watched at the port they write through. None of them can be reached
 * before there is a sheet, because the dialog bakes on the way in.
 */
test('the menu writes through the port it was handed, not through an anchor', async () => {
    const out = disk()
    const panel = await open(out.files)

    await panel.act(() => {
        press('More export options').click()
    })

    const json = out.after(1)
    await panel.act(() => {
        menuItem('Download metadata JSON').click()
    })
    await json
    expect(out.names()).toEqual(['sprites.json'])

    const sprites = out.after(panel.state().cameras.length)
    await panel.act(() => {
        menuItem('Download every sprite separately').click()
    })
    await sprites
    expect(out.names().filter(name => name.endsWith('.png'))).toHaveLength(
        panel.state().cameras.length
    )

    await panel.unmount()
})

/*
 * Naming a preset is `globalThis.prompt`, which is why this stubs a browser primitive rather than
 * clicking a field. What it adds over `sheet/choice.test.ts` is that the *ticks* are what gets
 * saved — the gear used to save whatever the selected preset already said, which made it a button
 * that could only ever duplicate a name.
 */
test('saving a preset saves the ticks, and a cancelled prompt saves nothing', async () => {
    const realPrompt = globalThis.prompt
    const answers: (string | null)[] = [null, 'Mine']
    globalThis.prompt = (): string | null => answers.shift() ?? null

    try {
        const panel = await open()
        const presets = (): number => panel.state().output.presets.length
        const before = presets()

        await panel.act(() => {
            press('Save these maps as a preset').click()
        })
        expect(presets()).toBe(before)

        await panel.act(() => {
            tick('ao').click()
        })
        await panel.act(() => {
            press('Save these maps as a preset').click()
        })
        expect(presets()).toBe(before + 1)
        expect(panel.state().output.preset).toBe('Mine')
        expect(panel.state().output.presets.at(-1)?.maps).toEqual(['color', 'normal', 'ao'])

        await panel.unmount()
    } finally {
        globalThis.prompt = realPrompt
    }
})

/*
 * The pixel-grid note — `render/perfect.ts`.
 *
 * Everything else in this dialog was happy to write an uneven staircase without saying so. A cell
 * that does not divide by a camera's zoom exports voxels of two different widths, and the one
 * panel whose job is to show what lands on disk showed it correctly and silently.
 */

const withCameras = (
    cameras: readonly {yaw: number; pitch: number; zoom: number}[],
    cell: number
): Promise<Panel> =>
    mountPanel(
        volume,
        ({state, dispatch}) => (
            <ExportDialog
                state={state}
                dispatch={dispatch}
                files={memoryFiles()}
                volume={slicedFor(state, shownVolume(state.volume, state.objects))}
                onClose={() => undefined}
            />
        ),
        state => ({
            ...state,
            output: {...state.output, cell, cellH: cell},
            cameras: cameras.map((camera, index) => ({
                id: `dir-${String(index)}`,
                name: `View ${String(index)}`,
                camera: {...camera, panX: 0, panY: 0}
            }))
        })
    )

const note = (): string => {
    const found = [...global.document.querySelectorAll<HTMLElement>('.export-uneven')].at(-1)
    return found?.textContent.trim() ?? ''
}

const flat = (zoom: number) => ({yaw: 0, pitch: 0, zoom})
const iso = (zoom: number) => ({yaw: Math.PI / 4, pitch: Math.atan(Math.SQRT1_2), zoom})

test('a sheet that lands on whole pixels says nothing at all', async () => {
    const panel = await withCameras([flat(16), flat(16)], 32)
    expect(note()).toBe('')
    await panel.unmount()
})

test('a sheet that does not land on whole pixels says so before the download', async () => {
    const panel = await withCameras([flat(31), flat(31)], 64)
    expect(note()).toContain('64 px')
    expect(note()).toContain('staircase')
    await panel.unmount()
})

test('one bad camera out of several is counted rather than generalised', async () => {
    const panel = await withCameras([flat(16), flat(16), iso(16)], 32)
    expect(note()).toContain('1 of 3')
    await panel.unmount()
})

/*
 * The repair that leaves the composed view alone. Only offered when it fixes the *whole* sheet: an
 * artist told "use 128 px" has been promised every cell, not five of eight.
 */
test('a sprite size that would fix the whole sheet is offered as a button', async () => {
    const panel = await withCameras([flat(128 / 3), flat(128 / 3)], 64)
    expect(press('Use 128 px tall')).toBeDefined()

    await panel.act(() => {
        press('Use 128 px tall').click()
    })
    expect(panel.state().output.cellH).toBe(128)
    expect(note()).toBe('')
    await panel.unmount()
})

test('no sprite size fixes an isometric ring, so none is offered', async () => {
    const panel = await withCameras([iso(16), iso(16)], 32)
    expect(note()).not.toContain('Use')
    await panel.unmount()
})
