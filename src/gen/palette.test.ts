import {expect, test} from 'bun:test'
import {freshenPalette, projectPalette} from '../doc/palette'
import {newDocument} from '../doc/templates'
import {createVolume, setVoxel, voxelAt, type Volume} from '../render/volume'
import {finish} from './finish'
import {rasterise} from './ops'
import {snapTo, swatchesOf} from './palette'

/**
 * The palette a candidate is held to, and what holding it there costs.
 *
 * The thing being protected is the project: a model that invents six browns and then shades each of
 * them into three tones puts eighteen colours nobody chose into a palette the artist tuned. What is
 * being risked is the shading, because a palette with no ramp under a colour cannot express three
 * tones of it — so both halves are measured here rather than argued about.
 */

/** A document freshened exactly as `initialState` freshens one, so its palette is DB32. */
const project = (): Volume => {
    const {volume} = newDocument([8, 8, 8])
    return {...volume, palette: freshenPalette(volume)}
}

const rgbAt = (volume: Volume, index: number): readonly number[] => [
    ...volume.palette.subarray(index * 4, index * 4 + 3)
]

const painted = (colour: string): Volume =>
    rasterise({
        name: 'test',
        size: [4, 4, 4],
        mirror_x: false,
        ops: [{op: 'box', from: [0, 0, 0], to: [3, 3, 3], color: colour}]
    })

test('the swatches are the project palette, which is what the artist is looking at', () => {
    const doc = project()
    const swatches = swatchesOf(doc)

    // DB32 and nothing else: a new document paints with nothing, and the format's filler is skipped.
    expect(swatches.slots).toHaveLength(32)
    expect(swatches.slots).toEqual(projectPalette(doc, 255).map(entry => entry.index))
    // The whole palette travels, not only the slots — the model adopts it, it does not replace it.
    expect(swatches.palette).toEqual(doc.palette)
})

test('a generated colour lands on the nearest project colour, and the model keeps its shape', () => {
    const doc = project()
    // DB32 has no #010203, and its nearest is its black at 000000 rather than any of its darks.
    const made = snapTo(painted('#010203'), swatchesOf(doc))

    expect(rgbAt(made, voxelAt(made, 0, 0, 0))).toEqual([0, 0, 0])
    expect([made.sx, made.sy, made.sz]).toEqual([4, 4, 4])
    // Every cell that was painted is still painted, and every empty one is still empty.
    expect(made.data.every(value => value !== 0)).toBe(true)
})

/*
 * Oklab rather than RGB, and this is the case that decides it.
 *
 * `#d77bba` is DB32's own pink. `finish` darkens it by 0.72 into `#9b5986`, which is on no palette.
 * The nearest DB32 entry to that *in plain RGB* is `#847e87`, a grey — because RGB measures the
 * squared distance between three bytes and a dark saturated colour is numerically close to a mid
 * grey. Perceptually the nearest is `#76428a`, the purple, which is a darker pink and reads as one.
 * A crevice tone that comes back grey is the difference between shading and dirt.
 *
 * The interior voxel is the one under test because `finish` gives it the crevice tone by
 * construction: it has no open top and no open side, and only the two lighter kinds are jittered.
 */
test('a darkened colour keeps its hue on the way to the palette, rather than going grey', () => {
    const made = snapTo(finish(painted('#d77bba')), swatchesOf(project()))

    expect(rgbAt(made, voxelAt(made, 1, 1, 1))).toEqual([0x76, 0x42, 0x8a])
})

test('shading is snapped along with the colour it came from, not left off the palette', () => {
    const doc = project()
    const shaded = finish(painted('#8f563b'))
    // Three tones before the snap: the lit top, the base and the crevices.
    const before = new Set(shaded.data.filter(value => value !== 0))
    expect(before.size).toBe(3)

    const made = snapTo(shaded, swatchesOf(doc))
    const after = new Set(made.data.filter(value => value !== 0))
    for (const value of after) expect(swatchesOf(doc).slots).toContain(value)
    // The tones survive here because DB32 has a brown ramp. Where a palette has none they collapse,
    // which is the honest outcome — see the note on `snapTo`.
    expect(after.size).toBeGreaterThan(1)
})

test('a palette with one colour flattens the shading rather than inventing a second', () => {
    const one = createVolume(2, 2, 2)
    one.palette.set([255, 0, 0, 255], 4)
    setVoxel(one, 0, 0, 0, 1)
    const made = snapTo(finish(painted('#8f563b')), swatchesOf(one))

    expect(new Set(made.data.filter(value => value !== 0))).toEqual(new Set([1]))
})

test('nothing to snap to leaves the candidate alone rather than painting it black', () => {
    const empty = createVolume(2, 2, 2)
    const candidate = painted('#8f563b')

    expect(snapTo(candidate, swatchesOf(empty))).toBe(candidate)
})

test('the project palette brings its emission with it, since the model has none of its own', () => {
    const doc = project()
    const glowing = {...doc, emissive: Uint8Array.from(doc.emissive)}
    glowing.emissive[projectPalette(doc, 1)[0]?.index ?? 1] = 200
    const made = snapTo(painted('#000000'), swatchesOf(glowing))

    expect(made.emissive[voxelAt(made, 0, 0, 0)]).toBe(200)
})
