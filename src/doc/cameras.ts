import {basisFor, defaultZoom, type Camera} from '../render/camera'
import type {Volume} from '../render/volume'

/**
 * A camera is a stored orthographic transform plus a name. That is the whole data model — the
 * thumbnails, the sheet and the viewport are all views of it, and nothing about a camera says how
 * big the sprite it produces is, because that belongs to the export rather than to the camera.
 */
export interface NamedCamera {
    readonly id: string
    readonly name: string
    readonly camera: Camera
}

/**
 * Three-quarters down the isometric diagonal: `atan(1 / √2)`, 35.26°, the pitch at which a cube's
 * three visible faces come out the same area. It is the angle voxel art is *modelled* at.
 *
 * It is not the angle it is drawn at, and that is worth knowing before reaching for it: at yaw 45°
 * a voxel's x edge moves `1/√3` down the screen for every 1 across, so a staircase off it is never
 * even and no zoom makes it so. See `DIMETRIC_PITCH` below and `render/perfect.ts`.
 */
export const ISOMETRIC_PITCH = Math.atan(Math.SQRT1_2)

/**
 * The 2:1 that everybody calls isometric and nobody means: `asin(1/2)`, 30° of elevation.
 *
 * At yaw 45° a voxel's x edge moves exactly 1 pixel down for every 2 across — the even staircase
 * pixel artists draw by hand, and the reason 2:1 is the convention rather than 35.26°. Blender's
 * (60, 0, 45) is this angle; the 26.57° figure quoted alongside it is the *screen* slope of the
 * line, `atan(1/2)`, not the camera.
 *
 * Its vertical edge is `√1.5` times the horizontal half-step, so a cube still does not close on
 * the grid. Hand-drawn 2:1 art squashes the height to make it and a real orthographic camera
 * cannot, so this is the closest an honest camera gets — and it is the default the app opens on,
 * because the horizontal staircase is the one the eye reads along a silhouette.
 *
 * **`asin(1/3)`, 19.47°, is the only three-quarter elevation where a whole voxel closes** — 3
 * pixels across, 1 down, 4 tall, every component of `voxelSteps` whole. It is deliberately not
 * offered, and this is the record of that decision so nobody adds it back on the arithmetic alone.
 * Measured on a solid cube at one scale, the top face is 33% of the sprite at true isometric, 29%
 * at 2:1 and 20% at 19.47° — a third less of the roofs, shoulders and table tops that carry the
 * shape. Against that, every tileset and asset pack in existence is 2:1, so a sheet built at 19.47°
 * lines up with nothing. Even stairs are not worth a sprite that matches nothing and shows less.
 * `render/perfect.test.ts` keeps the arithmetic alive; only the button is gone.
 */
export const DIMETRIC_PITCH = Math.asin(0.5)

/** Yaw 0 looks along `-y`, so the model's `-y` side is its front, and yaw turns anticlockwise. */
const DIRECTION_NAMES = [
    'Front',
    'Front Right',
    'Right',
    'Back Right',
    'Back',
    'Back Left',
    'Left',
    'Front Left'
]

/** The counts `FEATURESET.md` §13 names: four, and every 45°, which is eight. */
export const DIRECTION_COUNTS = [4, 8] as const

/**
 * The pitches a ring is built at. A ring is a count *and* a pitch, and the count was the only one
 * of the two the strip could say.
 *
 * They are in order of how much top face they show, because that is the axis an artist is actually
 * choosing along, and the button cycles them in that order. What separates them is how evenly the
 * result staircases, which nothing about looking at the viewport reveals:
 *
 * - `dimetric` — 30°, the 2:1 everyone draws. Slope exactly 1/2. **The default.**
 * - `iso` — 35.26°, the modelling angle. Slope `1/√3`. Never even, at any zoom.
 * - `flat` — exactly zero, a straight-on elevation. Whole on every axis whenever the sprite size
 *   divides by the zoom, which makes it the easy case rather than a lesser one.
 *
 * `dimetric` leads because it is what the artist wants by default: 2:1 is the convention every
 * tileset and asset pack is drawn to, so it is the one whose sheets line up with the rest of a
 * project. `iso` used to lead, and it is the *modelling* angle rather than the drawing one.
 *
 * `flat` is the view a side-on character sheet is drawn at, and the same stop `alignCamera` snaps
 * to. `views.ts`'s `opening` calls it the wrong one to open a 3D tool on, and that is still true —
 * it is not the wrong one to *export*, which is the whole distinction between looking at a model
 * and shipping a sprite of it.
 */
export const RING_PITCHES = {
    dimetric: DIMETRIC_PITCH,
    iso: ISOMETRIC_PITCH,
    flat: 0
} as const

export type RingPitch = keyof typeof RING_PITCHES

/** The order the pitch button cycles, starting from the default. */
export const RING_PITCH_ORDER = ['dimetric', 'iso', 'flat'] as const

export const nextRingPitch = (pitch: RingPitch): RingPitch => {
    const at = RING_PITCH_ORDER.indexOf(pitch)
    return RING_PITCH_ORDER[(at + 1) % RING_PITCH_ORDER.length] ?? 'dimetric'
}

/**
 * A ring of cameras around one pivot, at one click — `FEATURESET.md` §13.
 *
 * Everything but the yaw is shared: the same pitch, the same zoom, the same pivot, so the sprites
 * come out at one scale and one horizon. A sheet whose rows disagree about either is not a sheet,
 * and §14's "consistent object scale between camera views" is this line rather than a feature.
 *
 * Four directions are named from the eight, taking every other one, so Front is Front in both.
 */
export const directions = (volume: Volume, count = 8, pitch = DIMETRIC_PITCH): NamedCamera[] => {
    const step = 8 / Math.max(1, count)
    return Array.from({length: count}, (_unused, i) => {
        const eighth = Math.round(i * step) % 8
        return {
            id: `dir-${String(i)}`,
            name: DIRECTION_NAMES[eighth] ?? `Direction ${String(i)}`,
            camera: {
                yaw: (eighth * Math.PI) / 4,
                pitch,
                zoom: defaultZoom(volume),
                panX: 0,
                panY: 0
            }
        }
    })
}

export const eightDirections = (volume: Volume, pitch = DIMETRIC_PITCH): NamedCamera[] =>
    directions(volume, 8, pitch)

/**
 * How many cameras this list is a ring of, or `undefined` when it is not a ring at all.
 *
 * Asked by the pitch toggle, which has to rebuild the ring the artist is looking at rather than
 * wait for them to press 4 or 8 again. Read off the ids, because the ids are what `directions`
 * mints and a captured camera is `cam-*` — so a list with one capture on it is not a ring, and the
 * toggle leaves it alone instead of quietly deleting work.
 */
export const ringCount = (cameras: readonly NamedCamera[]): number | undefined => {
    const count = cameras.length
    if (!DIRECTION_COUNTS.includes(count as (typeof DIRECTION_COUNTS)[number])) return undefined
    return cameras.every((camera, i) => camera.id === `dir-${String(i)}`) ? count : undefined
}

/**
 * Turn the view to the nearest of the eight yaws and the nearest of three pitches — level, three
 * quarters, and straight down.
 *
 * `FEATURESET.md` §14's "camera alignment tools", and the reason it snaps to the *nearest* rather
 * than jumping to a named view: an artist who has orbited to roughly three-quarters-left wants
 * exactly three-quarters-left, not Front.
 */
export const PITCH_STOPS = [
    0,
    DIMETRIC_PITCH,
    ISOMETRIC_PITCH,
    Math.PI / 2,
    -DIMETRIC_PITCH,
    -ISOMETRIC_PITCH,
    -Math.PI / 2
]

export const alignCamera = (camera: Camera): Camera => {
    const eighth = Math.PI / 4
    const turns = Math.round(camera.yaw / eighth)
    const nearest = PITCH_STOPS.reduce((best, stop) =>
        Math.abs(stop - camera.pitch) < Math.abs(best - camera.pitch) ? stop : best
    )
    return {...camera, yaw: turns * eighth, pitch: nearest}
}

/**
 * Capture the viewport's current view as a new camera, the way the mockup's shutter button does.
 * The serial is passed in rather than kept here so that the whole document stays a value.
 */
export const captureCamera = (camera: Camera, serial: number): NamedCamera => ({
    id: `cam-${String(serial)}`,
    name: `Camera ${String(serial)}`,
    camera
})

/**
 * The highest serial any camera on this list was minted with.
 *
 * Derived from the ids rather than saved beside them, because it has to be right for a file that
 * was written before anyone thought about it — and because a counter stored next to the thing it
 * counts is a second copy of the same fact, free to drift.
 *
 * Without it a document reopened with `Camera 1` and `Camera 2` on it starts counting from zero
 * again, and the next capture is a *second* `cam-1`. Ids are how a camera is selected, renamed,
 * reordered and deleted, so the duplicate does not fail — it acts on the wrong camera.
 */
export const lastSerial = (cameras: readonly NamedCamera[]): number => {
    let highest = 0
    for (const {id} of cameras) {
        const found = /^cam-(\d+)$/.exec(id)
        const serial = found?.[1] === undefined ? 0 : Number(found[1])
        if (Number.isFinite(serial) && serial > highest) highest = serial
    }
    return highest
}

/**
 * Point the current view at one box and fill the frame with it — `FEATURESET.md` §1's "focus /
 * isolate selected object".
 *
 * The angle is left alone. Focusing is a *zoom and a pan*, not a camera move: an artist who has
 * spent a minute finding the three-quarter view they want to work at should not lose it to a
 * button that means "look closer". Zoom and pan are the two things a camera has that say where the
 * frame is, and they are exactly what changes.
 */
export const focusOn = (
    camera: Camera,
    volume: Volume,
    box: {min: readonly [number, number, number]; max: readonly [number, number, number]}
): Camera => {
    // Built at zero pan on purpose: pan is the answer being computed, not an input to it.
    const {right, up} = basisFor({...camera, panX: 0, panY: 0}, volume, 1)
    const middle = [volume.sx / 2, volume.sy / 2, volume.sz / 2]

    let lowA = Infinity
    let highA = -Infinity
    let lowB = Infinity
    let highB = -Infinity
    // Every corner, because a box seen at an angle is wider on screen than any of its sides.
    for (let i = 0; i < 8; i += 1) {
        const dx = ((i & 1) === 0 ? box.min[0] : box.max[0] + 1) - (middle[0] ?? 0)
        const dy = (((i >> 1) & 1) === 0 ? box.min[1] : box.max[1] + 1) - (middle[1] ?? 0)
        const dz = (((i >> 2) & 1) === 0 ? box.min[2] : box.max[2] + 1) - (middle[2] ?? 0)
        const a = right[0] * dx + right[1] * dy + right[2] * dz
        const b = up[0] * dx + up[1] * dy + up[2] * dz
        lowA = Math.min(lowA, a)
        highA = Math.max(highA, a)
        lowB = Math.min(lowB, b)
        highB = Math.max(highB, b)
    }

    // A little air, so the thing being focused on is not jammed against the frame.
    const room = Math.max(highA - lowA, highB - lowB) * 1.15
    return {
        ...camera,
        zoom: Math.max(4, Math.ceil(room)),
        panX: (lowA + highA) / 2,
        panY: (lowB + highB) / 2
    }
}
