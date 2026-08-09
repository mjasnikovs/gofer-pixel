import {expect, test} from 'bun:test'
import {DEFAULT_OUTPUT, type SavedOutput} from '../doc/save'
import {
    allPresets,
    DEFAULT_PRESET,
    dropPreset,
    PRESETS,
    presetMaps,
    presetNamed,
    savePreset
} from './presets'

/**
 * The four rules a list of export presets keeps. They were four expressions scattered through
 * `app/state.ts`, each one a chance for the next case to spell the fallback differently.
 */

const output = (): SavedOutput => ({...DEFAULT_OUTPUT, preset: DEFAULT_PRESET.name})

const named = (saved: SavedOutput | undefined): string[] =>
    saved === undefined ? [] : saved.presets.map(entry => entry.name)

test('a saved preset joins the built-ins and becomes the selected one', () => {
    const saved = savePreset(output(), 'My rig', ['color', 'ao'])
    if (!saved) throw new Error('a fresh name is not refused')
    expect(named(saved)).toEqual(['My rig'])
    expect(saved.preset).toBe('My rig')
    expect(allPresets(saved).map(entry => entry.name)).toContain('My rig')
    expect(presetMaps(saved, 'My rig')).toEqual(['color', 'ao'])
})

test('a name is trimmed, and a name that is only spaces is refused', () => {
    expect(named(savePreset(output(), '  My rig  ', ['color']))).toEqual(['My rig'])
    expect(savePreset(output(), '   ', ['color'])).toBeUndefined()
    expect(savePreset(output(), '', ['color'])).toBeUndefined()
})

/** Two `Every map` rows is a list nobody can use, and the built-in is the one that has to win. */
test('a built-in name cannot be taken', () => {
    for (const {name} of PRESETS) expect(savePreset(output(), name, ['color'])).toBeUndefined()
})

test('saving over your own name replaces it — you typed it twice and meant the second', () => {
    const first = savePreset(output(), 'My rig', ['color'])
    const second = first && savePreset(first, 'My rig', ['normal', 'depth'])
    expect(named(second)).toEqual(['My rig'])
    expect(second && presetMaps(second, 'My rig')).toEqual(['normal', 'depth'])
})

test('dropping the selected preset falls back to the default', () => {
    const saved = savePreset(output(), 'My rig', ['color'])
    const dropped = saved && dropPreset(saved, 'My rig')
    expect(named(dropped)).toEqual([])
    expect(dropped?.preset).toBe(DEFAULT_PRESET.name)
})

test('dropping a preset nobody selected leaves the selection alone', () => {
    const two = savePreset(savePreset(output(), 'A', ['color']) ?? output(), 'B', ['normal'])
    const dropped = two && dropPreset(two, 'A')
    expect(named(dropped)).toEqual(['B'])
    expect(dropped?.preset).toBe('B')
})

test('a built-in cannot be dropped, and neither can a name that was never saved', () => {
    expect(dropPreset(output(), DEFAULT_PRESET.name)).toBeUndefined()
    expect(dropPreset(output(), 'never existed')).toBeUndefined()
})

/** An unknown name writes the default's maps rather than nothing at all — an empty export is worse. */
test('an unknown preset name still writes something', () => {
    expect(presetMaps(output(), 'gone')).toEqual(DEFAULT_PRESET.maps)
})

test('a file that names no preset means the default', () => {
    expect(presetNamed('')).toBe(DEFAULT_PRESET.name)
    expect(presetNamed(undefined)).toBe(DEFAULT_PRESET.name)
    expect(presetNamed('My rig')).toBe('My rig')
})

test('the built-ins come first, in the order the selector lists them', () => {
    const saved = savePreset(output(), 'My rig', ['color'])
    if (!saved) throw new Error('a fresh name is not refused')
    expect(allPresets(saved).map(entry => entry.name)).toEqual([
        ...PRESETS.map(entry => entry.name),
        'My rig'
    ])
})
