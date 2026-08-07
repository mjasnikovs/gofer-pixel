import {expect, test} from 'bun:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {App} from './App'

/**
 * The harness itself: a real DOM from the preload, a real React root, and `act` flushing
 * synchronously. If this passes, a UI test never needs to wait for anything.
 */
test('the playground mounts into a real DOM', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
        root.render(<App />)
    })

    expect(host.querySelector('h1')?.textContent).toBe('gofer-pixel')

    // unmount is a React update too — outside `act` it warns, and a noisy suite is an ignored one
    await act(async () => {
        root.unmount()
    })
    host.remove()
})
