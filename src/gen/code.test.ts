import {expect, test} from 'bun:test'
import {specFromCode} from './code'
import {countFilled, MAX_SIZE, rasterise} from './ops'
import {DEFAULT_FLAGS} from './flags'

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

/*
 * The other two verbs. `box` is in every test above because it is what the examples teach with;
 * these two are what a model reaches for on a head or a hollow, and until now nothing said they
 * arrive as the ops `ops.ts` knows how to rasterise.
 */
test('ball and erase reach the spec as their own ops, and paint a rounded solid', () => {
    const spec = specFromCode(
        `ball(3,3,3, 3,3,3, '#ff8800')
erase(3,3,0, 3,3,6)`,
        'a head'
    )
    expect(spec?.ops.map(op => op.op)).toEqual(['ball', 'erase'])
    expect(spec?.ops[0]).toEqual({op: 'ball', at: [3, 3, 3], r: [3, 3, 3], color: '#ff8800'})

    // Rounded, so it is short of the 7³ box it is inscribed in — and hollowed by the erase.
    const filled = countFilled(
        rasterise(spec ?? {name: '', size: [1, 1, 1], mirror_x: false, ops: []})
    )
    expect(filled).toBeGreaterThan(0)
    expect(filled).toBeLessThan(7 * 7 * 7)
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

/*
 * §3, `silhouette` — `gen/shape.ts` in the reply's scope. Off, the name is genuinely undefined
 * rather than a stub: a reply that calls it throws on that line, keeps the ops before it, and the
 * batch cannot quietly run the experiment's prompt against none of its code.
 */
test('front and side exist only when the experiment is on', () => {
    const reply = `box(0,0,0, 1,1,1, '#8b5a2b')
front([[0,2],[6,1]], '#3f8fbf')
side([[0,3],[6,2]])`

    const off = specFromCode(reply, 'a fish')
    // The box before the throw survives, and nothing else does.
    expect(off?.ops).toHaveLength(1)

    const on = specFromCode(reply, 'a fish', MAX_SIZE, {...DEFAULT_FLAGS, silhouette: true})
    expect((on?.ops.length ?? 0) > 1).toBe(true)
    // The hull is boxes: nothing downstream learns a new word — see `gen/shape.ts`.
    expect(on?.ops.every(op => op.op === 'box')).toBe(true)
})

test('the silhouette paints where it was called, not at the end', () => {
    // The eye is drawn after the hull, so it has to survive being painted over.
    const reply = `front([[0,4],[8,4]], '#3f8fbf')
side([[0,4],[8,4]])
box(0,4,4, 0,4,4, '#101820')`
    const spec = specFromCode(reply, 'a fish', MAX_SIZE, {...DEFAULT_FLAGS, silhouette: true})
    const last = spec?.ops[spec.ops.length - 1]
    expect(last?.op === 'box' && last.color).toBe('#101820')
})

/*
 * §6, `procedural` — `gen/grow.ts` in the reply's scope. The canvas is supplied behind the model's
 * back and last, so a reply that names its own cannot resize a document it is not being asked about.
 */
test('the generators exist only when the experiment is on, and cannot choose the canvas', () => {
    const reply = "tree({height: 20, canvas: 128, leaf: '#2f6b33'})"

    expect(specFromCode(reply, 'a tree')).toBeUndefined()

    const on = specFromCode(reply, 'a tree', 16, {...DEFAULT_FLAGS, procedural: true})
    expect((on?.ops.length ?? 0) > 4).toBe(true)
    // Asked for 128 and held to 16: every op is inside the box the batch decided on.
    const highest = Math.max(
        ...(on?.ops ?? []).map(op => (op.op === 'ball' ? op.at[1] + op.r[1] : op.to[1]))
    )
    expect(highest).toBeLessThan(16)
})

/*
 * §2, `relational` — a different language, not more words in this one. `box` in it is the rig's own,
 * in the rig's frame, and the reply's ops are read after the program has run because the rig puts
 * the model on the floor and on its own axis at the end.
 */
test('the relational scope replaces the language rather than joining it', () => {
    const reply = `const torso = part('torso', 7, 8, 5, '#4a7a3a')
attach('head', torso, '+y', {w: 5, h: 5, d: 5, color: '#e0b088'})
legs(torso, {count: 2, length: 9, thick: 3, color: '#5a4632'})`

    // Off, none of those names exist and the reply paints nothing at all.
    expect(specFromCode(reply, 'a farmer')).toBeUndefined()

    const spec = specFromCode(reply, 'a farmer', 32, {...DEFAULT_FLAGS, relational: true})
    const volume = rasterise(spec ?? {name: '', size: [1, 1, 1], mirror_x: false, ops: []})
    expect(countFilled(volume)).toBeGreaterThan(300)
    // The legs reach the floor whatever the torso height is: that is the language's job, not the
    // model's, and it is why the coordinates were taken away.
    expect(volume.sz).toBeGreaterThan(20)
})

test('ball and mirrorX are not in the relational language', () => {
    const spec = specFromCode(
        "ball(4,4,4, 3,3,3, '#ffffff')\npart('body', 6, 6, 6, '#4a7a3a')",
        'a thing',
        32,
        {...DEFAULT_FLAGS, relational: true}
    )
    // The `ball` throws on line one; the part after it never runs, so nothing is painted.
    expect(spec).toBeUndefined()
})
