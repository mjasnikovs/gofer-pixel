import {expect, test} from 'bun:test'
import {keyAction, pressOf, type Binding, type Command, type KeyPress} from './keys'
import type {AppAction} from './state'

/**
 * Every shortcut, asked directly.
 *
 * These used to be five mounted windows dispatching real `KeyboardEvent`s at `document`, which is
 * 223 ms each to find out whether a letter reaches the reducer. The whole table below is one file
 * and no DOM, so a sixth shortcut costs nothing to cover.
 */

const NOTHING_HELD = {ctrl: false, shift: false, alt: false, typing: false}

const press = (key: string, held: Partial<KeyPress> = {}): Binding | undefined =>
    keyAction({key, ...NOTHING_HELD, ...held}, false)

/** The action a press means, or `undefined` when it means a command or nothing. */
const acted = (bound: Binding | undefined): AppAction | undefined =>
    bound?.kind === 'action' ? bound.action : undefined

/** The command a press means, or `undefined` when it means an action or nothing. */
const ran = (bound: Binding | undefined): Command | undefined =>
    bound?.kind === 'command' ? bound.command : undefined

test('the accelerator shortcuts, and every one of them is taken off the browser', () => {
    expect(press('z', {ctrl: true})).toEqual({
        kind: 'action',
        action: {type: 'undo'},
        swallow: true
    })
    expect(acted(press('Z', {ctrl: true, shift: true}))).toEqual({type: 'redo'})
    expect(acted(press('c', {ctrl: true}))).toEqual({type: 'copy'})
    expect(acted(press('v', {ctrl: true}))).toEqual({type: 'paste'})

    // The four that go to the disk are commands, not actions: they can be cancelled, and a
    // cancelled one must change nothing. See `session.ts`.
    expect(press('s', {ctrl: true})).toEqual({kind: 'command', command: 'save', swallow: true})
    expect(ran(press('s', {ctrl: true, shift: true}))).toBe('save-as')
    expect(ran(press('o', {ctrl: true}))).toBe('open')
    expect(ran(press('n', {ctrl: true}))).toBe('new')

    // Every accelerator binding swallows the key. Ctrl-S is the one that matters — unswallowed it
    // opens the browser's own Save Page dialog over the top of ours.
    for (const key of ['z', 'c', 'v', 's', 'o', 'n']) {
        expect(press(key, {ctrl: true})?.swallow).toBe(true)
    }
})

test('the bare-letter shortcuts, and none of them fight the browser for the key', () => {
    expect(acted(press('c'))).toEqual({type: 'capture'})
    expect(acted(press('f'))).toEqual({type: 'focus'})
    expect(acted(press('Escape'))).toEqual({type: 'clear-selection'})
    expect(acted(press(']'))).toEqual({type: 'grow-selection'})
    expect(acted(press('['))).toEqual({type: 'shrink-selection'})
    expect(acted(press('Delete'))).toEqual({type: 'transform', op: {kind: 'delete'}})
    expect(acted(press('Backspace'))).toEqual({type: 'transform', op: {kind: 'delete'}})

    for (const key of ['c', 'f', 'Escape', ']', '[', 'Delete', 'Backspace']) {
        expect(press(key)?.swallow).toBe(false)
    }
})

test('the letters are the same shortcut with Shift or Caps Lock on', () => {
    for (const key of ['C', 'F', 'S']) {
        const lower = press(key.toLowerCase())
        if (!lower) throw new Error(`${key} is not bound`)
        expect(press(key)).toEqual(lower)
    }
})

test('S toggles slice mode, which is the one thing a shortcut reads off the document', () => {
    expect(acted(keyAction({key: 's', ...NOTHING_HELD}, false))).toEqual({
        type: 'slice',
        on: true
    })
    expect(acted(keyAction({key: 's', ...NOTHING_HELD}, true))).toEqual({
        type: 'slice',
        on: false
    })
})

test('the arrows nudge along the grid, and Shift reaches the third axis', () => {
    expect(acted(press('ArrowRight'))).toEqual({
        type: 'transform',
        op: {kind: 'move', delta: [1, 0, 0]}
    })
    expect(acted(press('ArrowLeft'))).toEqual({
        type: 'transform',
        op: {kind: 'move', delta: [-1, 0, 0]}
    })
    expect(acted(press('ArrowUp'))).toEqual({
        type: 'transform',
        op: {kind: 'move', delta: [0, 1, 0]}
    })
    expect(acted(press('ArrowDown'))).toEqual({
        type: 'transform',
        op: {kind: 'move', delta: [0, -1, 0]}
    })

    // Shift swaps the horizontal pair for the vertical one — the axis a flat keyboard cannot reach.
    expect(acted(press('ArrowUp', {shift: true}))).toEqual({
        type: 'transform',
        op: {kind: 'move', delta: [0, 0, 1]}
    })
    expect(acted(press('ArrowDown', {shift: true}))).toEqual({
        type: 'transform',
        op: {kind: 'move', delta: [0, 0, -1]}
    })
    expect(acted(press('ArrowRight', {shift: true}))).toEqual({
        type: 'transform',
        op: {kind: 'move', delta: [0, 0, 1]}
    })

    // Swallowed, or the arrows scroll the page out from under the model.
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
        expect(press(key)?.swallow).toBe(true)
    }
})

test('a press in a text field is just a letter', () => {
    for (const key of ['c', 'f', 's', '[', 'Delete', 'ArrowLeft']) {
        expect(press(key, {typing: true})).toBeUndefined()
    }
    // Including the accelerators: Ctrl-C in a field is the field's copy, not the document's.
    expect(press('c', {ctrl: true, typing: true})).toBeUndefined()
    expect(press('s', {ctrl: true, typing: true})).toBeUndefined()
})

test('Alt belongs to the window manager, and unbound keys mean nothing', () => {
    expect(press('c', {alt: true})).toBeUndefined()
    expect(press('ArrowUp', {alt: true})).toBeUndefined()
    expect(press('q')).toBeUndefined()
    expect(press('F5')).toBeUndefined()
    expect(press('q', {ctrl: true})).toBeUndefined()
})

test('a KeyboardEvent reads as a press, and either accelerator is the accelerator', () => {
    expect(pressOf(new KeyboardEvent('keydown', {key: 'z', ctrlKey: true}))).toEqual({
        key: 'z',
        ctrl: true,
        shift: false,
        alt: false,
        typing: false
    })
    // Cmd on a Mac, Ctrl everywhere else. This app makes no distinction and neither do artists.
    expect(pressOf(new KeyboardEvent('keydown', {key: 'z', metaKey: true})).ctrl).toBe(true)

    const field = document.createElement('input')
    const inField = new KeyboardEvent('keydown', {key: 'c'})
    Object.defineProperty(inField, 'target', {value: field})
    expect(pressOf(inField).typing).toBe(true)

    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    const inEditable = new KeyboardEvent('keydown', {key: 'c'})
    Object.defineProperty(inEditable, 'target', {value: editable})
    expect(pressOf(inEditable).typing).toBe(true)
})
