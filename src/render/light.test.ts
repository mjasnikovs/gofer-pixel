import {expect, test} from 'bun:test'
import {
    FACE_LIGHT,
    FACE_X_NEG,
    FACE_X_POS,
    FACE_Y_NEG,
    FACE_Y_POS,
    FACE_Z_NEG,
    FACE_Z_POS
} from './faces'
import {DEFAULT_LIGHTING, LIGHT_STEP, lightFor, withLight} from './light'

const lit = (change: Parameters<typeof withLight>[1]): Uint16Array =>
    lightFor(withLight(DEFAULT_LIGHTING, {on: true, ...change}))

test('off hands back the hand-tuned table itself, identity and all', () => {
    // Identity, not equality. It is a `Thumbnail` prop and a viewport render dependency, so a fresh
    // array here would redraw the GPU on every React render.
    expect(lightFor(DEFAULT_LIGHTING)).toBe(FACE_LIGHT)
    expect(lightFor(withLight(DEFAULT_LIGHTING, {on: false, azimuth: 200}))).toBe(FACE_LIGHT)
})

test('the same lighting hands back the same array, so a render effect does not re-fire', () => {
    expect(lit({azimuth: 75})).toBe(lit({azimuth: 75}))
})

/**
 * The parity requirement, stated as a test rather than as a comment.
 *
 * Both backends compute `floor(channel * light / 256)`. That is exact in float32 for every integer
 * light in 0–256 — `255 * 256` is far below the 2²⁴ where float32 stops counting whole numbers — so
 * the shader and the CPU exporter land on the same byte. A fractional light would put them on two
 * sides of a rounding boundary and cost the agreement the whole renderer is built on.
 */
test('every face light is a whole number in 0–256, at every angle', () => {
    for (let azimuth = 0; azimuth < 360; azimuth += 5) {
        for (let elevation = 0; elevation <= 90; elevation += 5) {
            for (const sun of [0, 0.5, 1]) {
                for (const ambient of [0, 0.5, 1]) {
                    const table = lit({azimuth, elevation, sun, ambient})
                    for (let face = 1; face <= 6; face += 1) {
                        const value = table[face] ?? -1
                        expect(Number.isInteger(value)).toBe(true)
                        expect(value).toBeGreaterThanOrEqual(0)
                        expect(value).toBeLessThanOrEqual(256)
                    }
                }
            }
        }
    }
})

test('overhead is the top face brightest, the underside darkest, and the four sides tied', () => {
    const table = lit({elevation: 90, sun: 1, ambient: 0})
    expect(table[FACE_Z_POS]).toBe(256)
    expect(table[FACE_Z_NEG]).toBe(0)
    // Every side face is edge-on to the sun, so half-Lambert puts all four at the halfway mark.
    expect(table[FACE_X_POS]).toBe(128)
    expect(table[FACE_X_NEG]).toBe(128)
    expect(table[FACE_Y_POS]).toBe(128)
    expect(table[FACE_Y_NEG]).toBe(128)
})

/**
 * Why `DEFAULT_LIGHTING.azimuth` is 30 and not 45.
 *
 * At 45° the sun makes the same angle with `+x` and `+y`, so the two visible sides of a box come
 * out one tone and the corner between them disappears. Telling those two apart is most of what a
 * per-face light is for on a three-quarter camera, which is every camera this app ships with.
 */
test('45° flattens the two side faces together and 30° does not', () => {
    const flat = lit({azimuth: 45})
    expect(flat[FACE_X_POS]).toBe(flat[FACE_Y_POS] ?? -1)

    const table = lit({azimuth: 30})
    expect(table[FACE_X_POS]).not.toBe(table[FACE_Y_POS] ?? -1)
})

/**
 * Why the term is half-Lambert and not `max(0, dot)`.
 *
 * Clamped, every face turned away from the sun takes the same number, so three of the six tie at
 * the ambient floor and the shaded side of a model becomes one flat silhouette. Wrapped, all six
 * stay distinct — which is what the hand-tuned table did, and what makes a voxel shape readable
 * from the side the sun is not on.
 */
test('all six faces stay distinct at the default angle', () => {
    const table = lit({})
    const values = new Set(Array.from(table).slice(1))
    expect(values.size).toBe(6)
})

test('turning the sun half a circle swaps a face for the one opposite it', () => {
    const here = lit({azimuth: 0, elevation: 0})
    const there = lit({azimuth: 180, elevation: 0})
    expect(there[FACE_X_NEG]).toBe(here[FACE_X_POS] ?? -1)
    expect(there[FACE_X_POS]).toBe(here[FACE_X_NEG] ?? -1)
    // The sun never left the horizon, so the top and the bottom did not move.
    expect(there[FACE_Z_POS]).toBe(here[FACE_Z_POS] ?? -1)
})

test('a sun of nothing is a flat model at the ambient level', () => {
    const table = lit({sun: 0, ambient: 0.5})
    expect(Array.from(table).slice(1)).toEqual([128, 128, 128, 128, 128, 128])
})

test('ambient is a floor: full ambient is the palette untouched', () => {
    const table = lit({sun: 0, ambient: 1})
    expect(Array.from(table).slice(1)).toEqual([256, 256, 256, 256, 256, 256])
})

test('the azimuth wraps and the other three clamp', () => {
    // A compass has no ends.
    expect(withLight(DEFAULT_LIGHTING, {azimuth: 370}).azimuth).toBe(10)
    expect(withLight(DEFAULT_LIGHTING, {azimuth: -15}).azimuth).toBe(345)
    expect(withLight(DEFAULT_LIGHTING, {azimuth: 360}).azimuth).toBe(0)

    // A height above the horizon and a percentage both do.
    expect(withLight(DEFAULT_LIGHTING, {elevation: 140}).elevation).toBe(90)
    expect(withLight(DEFAULT_LIGHTING, {elevation: -20}).elevation).toBe(0)
    expect(withLight(DEFAULT_LIGHTING, {sun: 3}).sun).toBe(1)
    expect(withLight(DEFAULT_LIGHTING, {ambient: -1}).ambient).toBe(0)
})

test('a step of azimuth is a visible change on a face, and a degree would not be', () => {
    const table = lit({})
    const stepped = lit({azimuth: DEFAULT_LIGHTING.azimuth + LIGHT_STEP.azimuth})
    const moved = Math.abs((stepped[FACE_X_POS] ?? 0) - (table[FACE_X_POS] ?? 0))
    // Out of 256. A degree moves under one, which is a button that appears to do nothing.
    expect(moved).toBeGreaterThan(4)
})
