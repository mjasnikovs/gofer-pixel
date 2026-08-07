import {expect, test} from 'bun:test'
import {act} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {readVox} from '../vox/vox-file'
import {App} from './App'
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
const mount = async (): Promise<{root: Root; host: HTMLElement}> => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
        root.render(
            <App
                volume={volume}
                name='car.vox'
            />
        )
    })
    return {root, host}
}

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

const within = (host: HTMLElement, selector: string, label: string): HTMLElement => {
    const region = host.querySelector<HTMLElement>(selector)
    if (!region) throw new Error(`no ${selector}`)
    return control(region, label)
}

test('the window opens on eight cameras, each with a thumbnail rendered on the CPU', async () => {
    const mounted = await mount()

    const thumbnails = mounted.host.querySelectorAll('.camera-grid canvas.thumbnail')
    expect(thumbnails).toHaveLength(8)
    expect(thumbnails[0]?.getAttribute('data-pixels')).toBe('72x72')
    // The same eight again along the bottom, at the size a sprite is judged at.
    expect(mounted.host.querySelectorAll('.views-strip canvas.thumbnail')).toHaveLength(8)
    expect(mounted.host.textContent).toContain('Back Right')

    await unmount(mounted)
})

test('clicking a camera selects it and moves the viewport onto it', async () => {
    const mounted = await mount()
    const before = handle.state?.selected

    await act(async () => {
        within(mounted.host, '.camera-grid', 'Right').click()
    })

    expect(handle.state?.selected).not.toBe(before)
    expect(handle.state?.selected).toBe('dir-2')
    expect(handle.state?.orbit.camera.yaw).toBeCloseTo(Math.PI / 2, 10)

    // The views strip is the same list, so it has to agree about which one is current.
    const tile = within(mounted.host, '.views-strip', 'Right')
    expect(tile.getAttribute('aria-checked')).toBe('true')

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
    expect(handle.state?.sheet?.color.length).toBe(256 * 128 * 4)
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

    expect(mounted.host.querySelectorAll('.camera-grid canvas.thumbnail')).toHaveLength(9)
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

test('arming a tool and loading a colour are real, even though neither writes a voxel', async () => {
    const mounted = await mount()
    expect(handle.state?.tool).toBe('draw')

    await act(async () => {
        control(mounted.host, 'Erase').click()
    })
    expect(handle.state?.tool).toBe('erase')
    expect(control(mounted.host, 'Erase').getAttribute('aria-checked')).toBe('true')
    expect(control(mounted.host, 'Draw').getAttribute('aria-checked')).toBe('false')

    // The palette is the model's own, so the first swatch is a colour the model is made of.
    const swatches = [...mounted.host.querySelectorAll<HTMLElement>('.swatch')]
    expect(swatches.length).toBe(56)
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
