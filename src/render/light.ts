import {FACE_LIGHT, FACE_STEP} from './faces'

/**
 * A sun and an ambient floor — `FEATURESET.md` §21's first two lights.
 *
 * The whole of it is six numbers, and that is not a shortcut. A voxel face is flat, so a
 * directional light can only ever say one thing per face: the sun's entire effect *is* the
 * per-face table `faces.ts` used to hand-write. Nothing per-pixel changes, nothing per-voxel
 * changes, and both backends keep reading the same seven integers they always did.
 *
 * The third light on that list is not here and is a different animal. A point light varies across
 * a face, so it is per-pixel arithmetic, and it reads as a mistake without shadows — which is a
 * second ray march per pixel. That is the line this module deliberately stops at.
 *
 * **Lighting is off by default and that is the honest default**, for two reasons. The hand-tuned
 * table in `faces.ts` is not a sun — measured against it, no single Lambert direction reproduces
 * `-y 152` sitting above `-x 128` while both are meant to be facing away — so "on" cannot be made
 * to mean "what the app has always drawn". And a lit colour map goes to a game engine that is
 * about to light it again off the normal map, which is the argument §21 postponed the feature
 * with. An artist who wants a baked sun turns it on; nobody gets one by accident.
 */
export interface Lighting {
    readonly on: boolean
    /** Degrees around the up axis. `0` is a sun out along `+x`, turning toward `+y`. */
    readonly azimuth: number
    /** Degrees above the horizon. `90` is straight overhead, on `+z`. */
    readonly elevation: number
    /** How much the sun adds between a face turned away and a face turned into it, `0`–`1`. */
    readonly sun: number
    /** The floor under every face, `0`–`1`. What a face facing straight away still gets. */
    readonly ambient: number
}

export const DEFAULT_LIGHTING: Lighting = {
    on: false,
    // Not 45°, deliberately: at 45° the `+x` and `+y` faces take the same dot product and the two
    // sides of a box come out one tone. The whole job of a per-face light is telling them apart.
    azimuth: 30,
    elevation: 50,
    sun: 0.75,
    ambient: 0.25
}

/** What each `−`/`+` pair in the panel moves. Coarse on purpose — see `LightPanel.tsx`. */
export const LIGHT_STEP = {azimuth: 15, elevation: 10, sun: 0.05, ambient: 0.05} as const

const clamp = (value: number, low: number, high: number): number =>
    value < low ? low
    : value > high ? high
    : value

/** Azimuth wraps and the other three clamp — a compass has no ends and a percentage has two. */
export const withLight = (lighting: Lighting, change: Partial<Lighting>): Lighting => {
    const next = {...lighting, ...change}
    return {
        on: next.on,
        azimuth: ((next.azimuth % 360) + 360) % 360,
        elevation: clamp(next.elevation, 0, 90),
        sun: clamp(next.sun, 0, 1),
        ambient: clamp(next.ambient, 0, 1)
    }
}

/**
 * Half-Lambert, not Lambert, and the reason is the back of the model.
 *
 * Clamped `max(0, dot)` gives every face turned away from the sun the same number, so three of the
 * six faces tie at the ambient floor and the shaded side of a box becomes one flat silhouette.
 * Wrapping the term to `(dot + 1) / 2` keeps all six distinct at every angle, which is what the
 * hand-tuned table did and what makes a voxel shape readable from its unlit side.
 */
const shade = (dot: number, {sun, ambient}: Lighting): number =>
    clamp(ambient + sun * ((dot + 1) / 2), 0, 1)

/**
 * The six-face table, as the integers over 256 that both backends multiply by.
 *
 * Integer, and over a power of two, for exactly the reason `FACE_LIGHT` is: `floor(channel * light
 * / 256)` is exact in float32 for every input here, so the shader and the CPU exporter land on the
 * same byte instead of on two bytes a rounding mode apart. Rounding to an integer *here* is what
 * keeps that true — a `float` sun uniform would put the two backends on different sides of a half
 * and cost the parity the whole renderer is built on.
 *
 * `256` rather than `255` at the top end: the multiplier is over 256, so 256 is the colour
 * untouched, which is what the old table's `+z` meant.
 *
 * Returns `FACE_LIGHT` *itself* when the sun is off. The identity is load-bearing — it is a prop
 * on `Thumbnail` and a dependency of the viewport's render effect, so a fresh array every call
 * would redraw the GPU on every React render. The one-entry cache below does the same job for the
 * lit case; two documents' lightings alternating would thrash it and still be correct.
 */
let lastKey = ''
let lastTable = FACE_LIGHT
export const lightFor = (lighting: Lighting): Uint16Array => {
    if (!lighting.on) return FACE_LIGHT
    const {azimuth, elevation, sun, ambient} = lighting
    const key = `${String(azimuth)},${String(elevation)},${String(sun)},${String(ambient)}`
    if (key === lastKey) return lastTable

    const up = Math.sin((elevation * Math.PI) / 180)
    const flat = Math.cos((elevation * Math.PI) / 180)
    const lx = flat * Math.cos((azimuth * Math.PI) / 180)
    const ly = flat * Math.sin((azimuth * Math.PI) / 180)
    const table = new Uint16Array(7)
    for (let face = 1; face <= 6; face += 1) {
        /*
         * `FACE_STEP` is the outward face direction, so it is the normal and there is no second
         * copy of one here to drift from `faces.ts`.
         *
         * Not `FACE_NORMAL_RGB`, which is the same directions *encoded* and is asymmetric about
         * zero: `+1` is 255 and `-1` is 0, so `128` sits 127 from one end and 128 from the other,
         * and decoding it gives a vector of length 1.0079 on the negative side. That is enough to
         * make turning the sun through 180° land a face one byte off its own opposite.
         */
        const [nx, ny, nz] = FACE_STEP[face] ?? [0, 0, 0]
        const dot = nx * lx + ny * ly + nz * up
        table[face] = Math.round(shade(dot, lighting) * 256)
    }
    lastKey = key
    lastTable = table
    return table
}
