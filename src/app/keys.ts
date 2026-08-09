import type {AppAction} from './state'

/**
 * Every keyboard shortcut, as one table.
 *
 * It was fifty-five lines inside a `useEffect` that registered a `document` listener, which made a
 * pure question — *this key, these modifiers: what happens, and does the browser still see it?* —
 * answerable only by mounting a window and dispatching a real `KeyboardEvent`. It also meant no two
 * branches ever sat next to each other, so the one thing worth checking at a glance was the one
 * thing you could not: `Ctrl+S` is swallowed, `Escape` is not, `ArrowUp` is, `[` is not.
 *
 * `swallow` is a field here rather than a `preventDefault()` call scattered through the branches, so
 * a new binding has to say what it does about the browser instead of inheriting whatever the
 * surrounding `if` happened to do.
 */

/** A key press, with the DOM taken off it. */
export interface KeyPress {
    readonly key: string
    /** Either accelerator — this app makes no distinction, and neither do the artists. */
    readonly ctrl: boolean
    readonly shift: boolean
    readonly alt: boolean
    /** Whether the press landed in a text field, where every shortcut is just a letter. */
    readonly typing: boolean
}

/**
 * A shortcut that is not an action, because it goes to the disk and may be cancelled.
 *
 * The four of them are `session.ts`'s, and they are named rather than inlined so that this module
 * stays a table: it says *what a key means*, and nothing here can await anything.
 */
export type Command = 'save' | 'save-as' | 'open' | 'new'

export type Binding =
    | {readonly kind: 'action'; readonly action: AppAction; readonly swallow: boolean}
    | {readonly kind: 'command'; readonly command: Command; readonly swallow: boolean}

const act = (action: AppAction, swallow = false): Binding => ({kind: 'action', action, swallow})
const run = (command: Command): Binding => ({kind: 'command', command, swallow: true})

/** A `KeyboardEvent` as a `KeyPress`. The only line in this file that knows about the DOM. */
export const pressOf = (event: KeyboardEvent): KeyPress => {
    const target = event.target
    return {
        key: event.key,
        ctrl: event.metaKey || event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
        typing:
            target instanceof HTMLElement
            && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))
    }
}

/**
 * Nudging is along the axes of the *model*, not of the screen: a voxel-safe move is by whole cells
 * of the grid, and mapping a screen direction onto a grid axis would have to round somewhere.
 */
const NUDGES: Record<string, readonly [number, number, number] | undefined> = {
    ArrowRight: [1, 0, 0],
    ArrowLeft: [-1, 0, 0],
    ArrowUp: [0, 1, 0],
    ArrowDown: [0, -1, 0]
}

/**
 * What a press means. `undefined` for a key this app has no opinion about, which is most of them.
 *
 * `slicing` is the only piece of the document a shortcut reads — S toggles slice mode, so it has to
 * know which way. Passing that one boolean rather than the whole state is deliberate: the listener
 * in `App.tsx` re-registers when its dependencies change, and depending on the whole state would
 * mean tearing the listener down and building it again on every stroke.
 */
export const keyAction = (press: KeyPress, slicing: boolean): Binding | undefined => {
    // In a text field every shortcut is just a letter, including Ctrl-A and Ctrl-C.
    if (press.typing) return undefined

    if (press.ctrl) {
        switch (press.key.toLowerCase()) {
            case 'z':
                // Swallowed: the browser's own undo would otherwise walk the focused input.
                return act({type: press.shift ? 'redo' : 'undo'}, true)
            case 'c':
                return act({type: 'copy'}, true)
            case 'v':
                return act({type: 'paste'}, true)
            // Must be swallowed or the browser opens its own Save Page dialog over the top of ours.
            // Shift is Save As, which always asks.
            case 's':
                return run(press.shift ? 'save-as' : 'save')
            case 'o':
                return run('open')
            case 'n':
                return run('new')
            default:
                return undefined
        }
    }

    // Alt is the window manager's and the browser's menu bar. Nothing here competes for it.
    if (press.alt) return undefined

    const nudge = NUDGES[press.key]
    if (nudge) {
        const [dx, dy, dz] = nudge
        /*
         * Shift swaps the horizontal pair for the vertical one, which is the third axis a
         * two-dimensional keyboard cannot otherwise reach. Swallowed, because the arrows would
         * otherwise scroll the page out from under the model.
         */
        return act(
            {
                type: 'transform',
                op: {kind: 'move', delta: press.shift ? [0, 0, dx + dy] : [dx, dy, dz]}
            },
            true
        )
    }

    switch (press.key.toLowerCase()) {
        // The mockup's `C`. A shortcut that only exists in the hint bar's caption is a caption.
        case 'c':
            return act({type: 'capture'})
        case 'f':
            return act({type: 'focus'})
        // `FEATURESET.md` §6's "press a key". S for slice, and it toggles.
        case 's':
            return act({type: 'slice', on: !slicing})
        case 'escape':
            return act({type: 'clear-selection'})
        // The two brackets that every editor uses for "more of this" and "less of this".
        case ']':
            return act({type: 'grow-selection'})
        case '[':
            return act({type: 'shrink-selection'})
        case 'delete':
        case 'backspace':
            return act({type: 'transform', op: {kind: 'delete'}})
        default:
            return undefined
    }
}
