import {expect, test} from 'bun:test'
import {readVox} from '../vox/vox-file'
import {mountPanel, type Panel} from '../../test/panel'
import {memoryFiles, type Files} from '../doc/files'
import {fromHexPalette} from '../doc/palette'
import {BrushPanel} from './BrushPanel'
import {ToolRail} from './ToolRail'
import {TOOLS} from './state'

/**
 * The tool rail and the brush-and-palette column, over the real reducer — see `test/panel.tsx`.
 *
 * Every one of these is a one-line closure between a control and the reducer, which is exactly the
 * kind of wiring that rots without anyone noticing: the control still moves, the document stops
 * hearing about it. That is worth a real React tree and worth nothing else, so this is the tree and
 * nothing else. Seven whole-window mounts before.
 */

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)

const open = (files: Files = memoryFiles()): Promise<Panel> =>
    mountPanel(volume, ({state, dispatch}) => (
        <>
            <ToolRail
                tools={TOOLS}
                state={state}
                dispatch={dispatch}
            />
            <BrushPanel
                state={state}
                dispatch={dispatch}
                files={files}
                onLoad={() => undefined}
            />
        </>
    ))

const swatch = (panel: Panel, index: number): HTMLElement => {
    const found = [...panel.host.querySelectorAll<HTMLElement>('.swatches .swatch')].find(node =>
        node.getAttribute('aria-label')?.startsWith(`Colour ${String(index)}`)
    )
    if (!found) throw new Error(`no swatch for colour ${String(index)}`)
    return found
}

test('arming a tool and loading a colour reach the document, not just the panel', async () => {
    const panel = await open()
    expect(panel.state().tool).toBe('draw')

    await panel.click('Erase')
    expect(panel.state().tool).toBe('erase')
    expect(panel.control('Erase').getAttribute('aria-checked')).toBe('true')
    expect(panel.control('Draw').getAttribute('aria-checked')).toBe('false')

    // The palette is the model's own first, then DB32 — the car's three colours and 31 more, with
    // none of MagicaVoxel's ramp padding the grid out to its full 56.
    const swatches = [...panel.host.querySelectorAll<HTMLElement>('.swatch')]
    expect(swatches.length).toBe(34)
    expect(swatches[0]?.getAttribute('aria-label')).toContain('used by this model')
    await panel.act(() => {
        swatches[3]?.click()
    })
    expect(String(panel.state().color)).toBe(
        swatches[3]?.getAttribute('aria-label')?.replace(/\D/g, '') ?? ''
    )

    // The stepper stops at the document's bound rather than running past it, and says so where a
    // keyboard user can hear it — Astryx keeps a tooltipped control focusable and marks it
    // `aria-disabled` instead of dropping it out of the tab order.
    for (let i = 0; i < 10; i += 1) await panel.click('Larger brush')
    expect(panel.state().brush.size).toBe(8)
    expect(panel.control('Larger brush').getAttribute('aria-disabled')).toBe('true')

    await panel.unmount()
})

test('the brush row goes dead for the tools that do not read it, and comes back for the ones that do', async () => {
    const panel = await open()
    const shapes = (): HTMLElement[] => [
        ...panel.host.querySelectorAll<HTMLElement>('[aria-label="Brush shape"] .shape')
    ]
    const figures = (): HTMLElement[] => [
        ...panel.host.querySelectorAll<HTMLElement>('[aria-label="Figure"] .shape')
    ]
    // The four shapes and the five figures of the two rows, so a silent renaming cannot pass here.
    expect(shapes()).toHaveLength(4)
    expect(figures()).toHaveLength(5)
    expect(shapes()[0]?.getAttribute('aria-disabled')).toBeNull()

    await panel.click('Move')
    expect(panel.state().tool).toBe('move')
    expect(panel.control('Smaller brush').getAttribute('aria-disabled')).toBe('true')
    expect(panel.control('Larger brush').getAttribute('aria-disabled')).toBe('true')
    for (const button of [...shapes(), ...figures()]) {
        expect(button.getAttribute('aria-disabled')).toBe('true')
        // The label says which tool is the reason, not merely that the control is off.
        expect(button.getAttribute('aria-label')).toContain('Move does not use the brush')
    }

    // Greyed and inert, not greyed and still wired: a click on the ring changes nothing.
    const before = panel.state().brush
    await panel.act(() => {
        shapes()[2]?.click()
        figures()[3]?.click()
    })
    expect(panel.state().brush).toEqual(before)

    await panel.click('Draw')
    expect(shapes()[2]?.getAttribute('aria-disabled')).toBeNull()
    await panel.act(() => {
        shapes()[2]?.click()
    })
    expect(panel.state().brush.shape).toBe('ring')

    await panel.unmount()
})

test('the brush and palette controls reach the document', async () => {
    const panel = await open()
    const paletteSwitch = (label: string): HTMLElement => {
        const found = [...panel.host.querySelectorAll<HTMLElement>('label')].find(
            node => node.textContent.trim() === label
        )
        // Astryx puts the switch's `<input>` beside its label, and links them by `id` when it does
        // not — the id lookup goes through the document, because more than one tree is mounted.
        const input =
            found?.previousElementSibling?.querySelector<HTMLElement>('input')
            ?? global.document.querySelector<HTMLElement>(
                `input[id="${found?.getAttribute('for') ?? ''}"]`
            )
        if (!input) throw new Error(`no switch labelled "${label}"`)
        return input
    }

    await panel.click('Larger brush')
    expect(panel.state().brush.size).toBe(3)
    await panel.click('Smaller brush')
    expect(panel.state().brush.size).toBe(2)

    // Emissive is a property of the loaded colour, not of the brush — it follows the palette entry.
    await panel.act(() => {
        paletteSwitch('Emissive').click()
    })
    expect(panel.state().volume.emissive[panel.state().color]).toBeGreaterThan(0)

    await panel.act(() => {
        paletteSwitch('Lock').click()
    })
    expect(panel.state().paletteLocked).toBe(true)

    await panel.click('Add a colour to the palette')
    expect(panel.state().color).toBeGreaterThan(0)

    await panel.click('Pick a colour from the model')
    expect(panel.state().tool).toBe('pick')

    await panel.unmount()
})

test('recoloring a palette entry repaints every voxel that was using it', async () => {
    const panel = await open()
    const loaded = panel.state().color

    const field = panel.host.querySelector<HTMLInputElement>(
        `input[aria-label="Colour of palette entry ${String(loaded)}"]`
    )
    if (!field) throw new Error('no colour field')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await panel.act(() => {
        setter?.call(field, '#123456')
        field.dispatchEvent(new Event('input', {bubbles: true}))
    })

    expect([...panel.state().volume.palette.slice(loaded * 4, loaded * 4 + 3)]).toEqual([
        0x12, 0x34, 0x56
    ])

    await panel.unmount()
})

test('shift-clicking a swatch selects every voxel of that colour', async () => {
    const panel = await open()
    expect(panel.state().selection.size).toBe(0)

    await panel.act(() => {
        swatch(panel, 1).dispatchEvent(new MouseEvent('click', {bubbles: true, shiftKey: true}))
    })

    expect(panel.state().selection.size).toBeGreaterThan(0)

    await panel.unmount()
})

test('alt-clicking a swatch repaints the loaded colour’s voxels with it', async () => {
    const panel = await open()
    const loaded = panel.state().color
    const of = (index: number): number =>
        panel.state().volume.data.filter(value => value === index).length
    const before = of(loaded)
    expect(before).toBeGreaterThan(0)

    const other = [...panel.state().volume.data].find(value => value !== 0 && value !== loaded)
    if (other === undefined) throw new Error('the model should use more than one colour')

    await panel.act(() => {
        swatch(panel, other).dispatchEvent(new MouseEvent('click', {bubbles: true, altKey: true}))
    })

    expect(of(loaded)).toBe(0)
    expect(of(other)).toBeGreaterThan(before)

    await panel.unmount()
})

test('a recent colour loads it back without going hunting in the grid', async () => {
    const panel = await open()

    // Two colours used, so the recent row appears at all.
    await panel.dispatch({type: 'color', color: 2})
    await panel.dispatch({type: 'color', color: 5})

    const recent = panel.host.querySelector<HTMLElement>(
        '.recent-swatches [aria-label="Recent colour 2"]'
    )
    if (!recent) throw new Error('no recent swatch for colour 2')
    await panel.act(() => {
        recent.click()
    })

    expect(panel.state().color).toBe(2)

    await panel.unmount()
})

/*
 * The palette export, at the port it goes through.
 *
 * It used to build its own anchor, which meant this button could only be watched by a whole-window
 * mount that replaced `HTMLAnchorElement.prototype.click` — and even then the assertion was that a
 * file called `palette.hex` had been offered, never that the artist's colours were in it.
 */
test('saving the palette writes a .hex of this model’s colours through the port', async () => {
    const backing = new Map<string, string | Uint8Array>()
    const panel = await open(memoryFiles(backing))

    await panel.click('Save the palette')

    const written = backing.get('palette.hex')
    if (typeof written !== 'string') throw new Error('no palette.hex was written')
    // Entries 1 to 255, one `rrggbb` per line — `toHexPalette`'s own shape.
    const lines = written.split('\n').filter(line => line !== '')
    expect(lines).toHaveLength(255)
    expect(lines.every(line => /^[0-9a-f]{6}$/.test(line))).toBe(true)
    // And they are *this* model's colours: what came off the disk reads back as what is loaded.
    expect(fromHexPalette(written, new Uint8Array(256 * 4))).toEqual(panel.state().volume.palette)

    await panel.unmount()
})
