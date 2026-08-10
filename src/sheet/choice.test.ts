import {expect, test} from 'bun:test'
import {DEFAULT_OUTPUT, type SavedOutput} from '../doc/save'
import {reseeded, seeded, shipped, toggled} from './choice'
import type {SheetMap} from './sheet'

const output = (over: Partial<SavedOutput> = {}): SavedOutput => ({...DEFAULT_OUTPUT, ...over})

test('the ticks start as the selected preset’s maps', () => {
    expect(seeded(output()).maps).toEqual(['color', 'normal'])
    expect(seeded(output({preset: 'Godot 8-direction'})).maps).toEqual([
        'color',
        'normal',
        'emission'
    ])
})

test('choosing a preset replaces the ticks, and anything else leaves them alone', () => {
    const mine = toggled(seeded(output()), 'ao', true)
    expect(mine.maps).toEqual(['color', 'normal', 'ao'])

    // A re-render with nothing changed must not throw the artist's ticks away.
    expect(reseeded(mine, output())).toBe(mine)
    // Padding is not the preset. Neither is anything else in `SavedOutput`.
    expect(reseeded(mine, output({padding: 4}))).toBe(mine)

    expect(reseeded(mine, output({preset: 'Indexed colour'})).maps).toEqual(['color', 'index'])
})

test('ticks keep the list’s own order, however they were added', () => {
    let choice = seeded(output({preset: 'Indexed colour'}))
    choice = toggled(choice, 'ao', true)
    choice = toggled(choice, 'normal', true)
    expect(choice.maps).toEqual(['color', 'normal', 'ao', 'index'])
})

/*
 * `renderSheet` puts colour back whatever it is asked for, so a dialog that let it be unticked would
 * show an empty box and write the file regardless. The refusal lives here rather than in a disabled
 * control: the row simply does not respond.
 */
test('colour cannot be unticked', () => {
    const choice = seeded(output())
    expect(toggled(choice, 'color', false)).toBe(choice)
    expect(toggled(choice, 'normal', false).maps).toEqual(['color'])
})

/*
 * The one rule the write and the count both have to agree on. A preset naming emission on a model
 * with nothing glowing writes colour and normal, and says two.
 */
test('an empty map is ticked but never shipped', () => {
    const choice = seeded(output({preset: 'Godot 8-direction'}))
    const empty = new Set<SheetMap>(['emission'])
    expect(choice.maps).toContain('emission')
    expect(shipped(choice, empty)).toEqual(['color', 'normal'])
    expect(shipped(choice, new Set())).toEqual(['color', 'normal', 'emission'])
})
