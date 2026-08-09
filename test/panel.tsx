import {act, useReducer, type Dispatch, type ReactNode} from 'react'
import {createRoot} from 'react-dom/client'
import {initialState, reduce, type AppAction, type AppState} from '../src/app/state'
import type {Volume} from '../src/render/volume'

/**
 * One panel over a real reducer, with no window around it.
 *
 * `App.test.tsx` costs 209 ms per test and roughly 29 of its tests drive exactly one panel. The
 * cost is not React and it is not the CPU raycaster — measured, the seventeen sprites a mount
 * renders are 26 ms of the 209 — it is mounting the whole astryx panel tree. A panel already takes
 * `state` and `dispatch` and nothing else, which is a seam; nothing was using it.
 *
 * So this is the harness under that seam. What it is *not* is a mock: the reducer is the real
 * `reduce`, so an assertion here is the same assertion the window made — "this control reaches the
 * document" — minus the fourteen panels that were not under test. `App.test.tsx` keeps the tests
 * that are genuinely about *composition*: effects, the keyboard listener, the file dialogs, the
 * guard in front of them, and the one live viewport.
 *
 * Nothing waits. `act` flushes synchronously and a click is `element.click()`, exactly as in the
 * window tests — see `docs/techstack.md` §3.
 */
export interface Panel {
    /** The node the panel rendered into. */
    readonly host: HTMLElement
    /** The state as the reducer last left it. Read it after every act. */
    state: () => AppState
    /** Fire an action straight at the reducer — arming a tool, not the thing under test. */
    dispatch: (action: AppAction) => Promise<void>
    /** A control by its accessible name, or by the text on its face when it has no label. */
    control: (label: string) => HTMLElement
    /** Click one, and flush. */
    click: (label: string) => Promise<void>
    /** Run something inside `act`, for a click on a node this file cannot name. */
    act: (body: () => void | Promise<void>) => Promise<void>
    unmount: () => Promise<void>
}

/**
 * The panel under test, drawn from the state the harness holds.
 *
 * A function rather than an element, because it is re-invoked on every commit — a panel that took
 * a snapshot of the state would never see an action land.
 */
export type Draw = (props: {state: AppState; dispatch: Dispatch<AppAction>}) => ReactNode

export const mountPanel = async (
    volume: Volume,
    draw: Draw,
    /** The document to open on: a chance to arm a tool or select something before the first paint. */
    start: (state: AppState) => AppState = state => state
): Promise<Panel> => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    /*
     * Published out of the render rather than through a ref, because a test is not React and has
     * to be able to read the latest state from outside a commit. It is the same trick
     * `src/app/handle.ts` plays on the whole app, at one panel's scale.
     */
    let held: AppState | undefined
    let fire: Dispatch<AppAction> | undefined

    const Harness = (): ReactNode => {
        const [state, dispatch] = useReducer(reduce, volume, grid =>
            start(initialState(grid, 'car.vox'))
        )
        held = state
        fire = dispatch
        return draw({state, dispatch})
    }

    await act(async () => {
        root.render(<Harness />)
    })

    const control = (label: string): HTMLElement => {
        const found = [...host.querySelectorAll<HTMLElement>('button, input')].find(
            node => node.getAttribute('aria-label') === label || node.textContent.trim() === label
        )
        if (!found) throw new Error(`nothing labelled "${label}"`)
        return found
    }

    const inAct = async (body: () => void | Promise<void>): Promise<void> => {
        await act(async () => {
            await body()
        })
    }

    return {
        host,
        state: () => {
            if (!held) throw new Error('the harness has not rendered')
            return held
        },
        dispatch: async action => {
            await inAct(() => {
                fire?.(action)
            })
        },
        control,
        click: async label => {
            await inAct(() => {
                control(label).click()
            })
        },
        act: inAct,
        unmount: async () => {
            await act(async () => {
                root.unmount()
            })
            host.remove()
        }
    }
}
