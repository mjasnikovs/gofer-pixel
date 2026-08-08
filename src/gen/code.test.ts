import {expect, test} from 'bun:test'
import {specFromCode} from './code'
import {countFilled, rasterise} from './ops'

test('a program becomes a spec: loops run, mirrorX sets the flag, the prompt is the name', () => {
    const spec = specFromCode(
        `for (const z of [0, 4]) box(0,0,z, 1,1,z+1, '#ff0000')
mirrorX()`,
        'a cart'
    )
    expect(spec).toBeDefined()
    expect(spec?.name).toBe('a cart')
    expect(spec?.mirror_x).toBe(true)
    expect(spec?.ops).toHaveLength(2)
})

test('a markdown fence is stripped, because the model was asked not to and sometimes does anyway', () => {
    const spec = specFromCode("```js\nbox(0,0,0, 1,1,1, '#00ff00')\n```", 'x')
    expect(spec?.ops).toHaveLength(1)
})

test('a crash after the first op keeps what was painted', () => {
    // A model that dies on line two painted line one, and refusing it would throw away the model
    // over a typo — the same call readSpec makes about one broken op in forty.
    const spec = specFromCode(
        `box(0,0,0, 2,2,2, '#808080')
thisFunctionDoesNotExist()`,
        'x'
    )
    expect(spec?.ops).toHaveLength(1)
    expect(
        countFilled(rasterise(spec ?? {name: '', size: [1, 1, 1], mirror_x: false, ops: []}))
    ).toBe(27)
})

test('prose, a syntax error, or code that paints nothing is undefined, not an empty model', () => {
    expect(specFromCode('the reply was an apology, not a program', 'x')).toBeUndefined()
    expect(specFromCode('const x =', 'x')).toBeUndefined()
    expect(specFromCode('const size = 32', 'x')).toBeUndefined()
})

test('an op with an unreadable argument is dropped, not smeared', () => {
    const spec = specFromCode(
        `box(0,0,0, 1,1,1, '#0000ff')
box('wide',0,0, 1,1,1, '#0000ff')`,
        'x'
    )
    expect(spec?.ops).toHaveLength(1)
})

test('a runaway loop is cut at the op budget instead of allocating forever', () => {
    const spec = specFromCode(
        `for (let i = 0; i < 100000; i += 1) box(0,0,0, 0,0,0, '#ffffff')`,
        'x'
    )
    expect(spec?.ops).toHaveLength(4096)
})
