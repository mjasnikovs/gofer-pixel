import type {Page} from '@playwright/test'

/**
 * The seam the browser suite drives the running app through — `src/app/handle.ts`.
 *
 * One shape, declared once, so two specs cannot drift into two different ideas of what the app
 * exposes. The app only ever writes to this handle; nothing here reaches into the DOM to find out
 * what the state machine did, because a panel that renders the wrong thing is a different bug from
 * a reducer that computes the wrong thing and the two must not be able to hide each other.
 */
export interface Handle {
    raycaster: {frames: number; renderNow: (basis: unknown, mode?: number) => Promise<number>}
    state: {
        cameras: unknown[]
        selected: string | undefined
        output: {cell: number; padding: number; preset: string}
        volume: {data: Uint8Array; sx: number; sy: number; sz: number}
        history: {past: unknown[]}
        orbit: {camera: {zoom: number; yaw: number; pitch: number}; gesture: unknown}
        selection: {size: number}
        tool: string
        color: number
        recent: number[]
        brush: {size: number; shape: string; figure: string}
        drag: {kind: string} | undefined
        band: unknown
        stroke: unknown
        slice: number | undefined
        clipboard: unknown
        losing: number
    }
    dispatch: (action: unknown) => void
    firstFrame: Promise<void>
}

declare global {
    interface Window {
        goferPixel: Handle
    }
}

/**
 * Await the first frame, not the first paint.
 *
 * Waiting for a thumbnail to appear is waiting for the wrong thing: React commits the camera list
 * on its first render, but the viewport cannot draw until a `ResizeObserver` has told it how big it
 * is, which lands a beat later. Reading the canvas at that point returned an empty buffer about one
 * run in five. `firstFrame` is the event that was missing, and adding it was part of the fix.
 */
export const ready = async (page: Page): Promise<void> => {
    /*
     * A reload is only a reset if the autosave goes with it. `main.tsx` opens the latest snapshot
     * from `localStorage` when there is one — crash recovery, `FEATURESET.md` §32 — so a second
     * `ready()` inside one test used to hand back the document the first half of the test had just
     * edited. An init script runs before the page's own, which is the only point at which the store
     * can still be emptied.
     */
    await page.addInitScript(() => {
        try {
            localStorage.clear()
        } catch {
            // No store in this context, which is the state the clear was after anyway.
        }
    })
    await page.goto('/')
    await page.evaluate(() => window.goferPixel.firstFrame)
}

export const frames = (page: Page): Promise<number> =>
    page.evaluate(() => window.goferPixel.raycaster.frames)

/** The viewport's box on the page, which is what a real mouse position is measured against. */
export const viewport = async (
    page: Page
): Promise<{x: number; y: number; width: number; height: number}> => {
    const box = await page.locator('[data-testid="viewport"]').boundingBox()
    if (!box) throw new Error('the viewport has no box')
    return box
}

export const arm = async (page: Page, tool: string): Promise<void> => {
    await page.evaluate(name => {
        window.goferPixel.dispatch({type: 'tool', tool: name})
    }, tool)
}

/** Everything a gesture test wants to know, in one round trip. */
export interface Reading {
    tool: string
    color: number
    filled: number
    hash: number
    selection: number
    undo: number
    drag: string | undefined
    band: boolean
    stroke: boolean
    yaw: number
    zoom: number
    cameras: number
    slice: number | undefined
    clipboard: boolean
    losing: number
}

export const read = (page: Page): Promise<Reading> =>
    page.evaluate(() => {
        const {state} = window.goferPixel
        let filled = 0
        let hash = 0
        const {data} = state.volume
        for (let i = 0; i < data.length; i += 1) {
            const value = data[i] ?? 0
            if (value !== 0) filled += 1
            hash = (hash * 31 + value * (i + 1)) | 0
        }
        return {
            tool: state.tool,
            color: state.color,
            filled,
            hash,
            selection: state.selection.size,
            undo: state.history.past.length,
            drag: state.drag?.kind,
            band: state.band !== undefined,
            stroke: state.stroke !== undefined,
            yaw: state.orbit.camera.yaw,
            zoom: state.orbit.camera.zoom,
            cameras: state.cameras.length,
            slice: state.slice,
            clipboard: state.clipboard !== undefined,
            losing: state.losing
        }
    })
