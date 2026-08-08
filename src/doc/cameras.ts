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
 * three visible faces come out the same area. It is the angle voxel art is drawn at.
 */
export const ISOMETRIC_PITCH = Math.atan(Math.SQRT1_2)

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
 * A ring of cameras around one pivot, at one click — `FEATURESET.md` §13.
 *
 * Everything but the yaw is shared: the same pitch, the same zoom, the same pivot, so the sprites
 * come out at one scale and one horizon. A sheet whose rows disagree about either is not a sheet,
 * and §14's "consistent object scale between camera views" is this line rather than a feature.
 *
 * Four directions are named from the eight, taking every other one, so Front is Front in both.
 */
export const directions = (volume: Volume, count = 8, pitch = ISOMETRIC_PITCH): NamedCamera[] => {
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

export const eightDirections = (volume: Volume, pitch = ISOMETRIC_PITCH): NamedCamera[] =>
    directions(volume, 8, pitch)

/**
 * Turn the view to the nearest of the eight yaws and the nearest of three pitches — level, three
 * quarters, and straight down.
 *
 * `FEATURESET.md` §14's "camera alignment tools", and the reason it snaps to the *nearest* rather
 * than jumping to a named view: an artist who has orbited to roughly three-quarters-left wants
 * exactly three-quarters-left, not Front.
 */
export const PITCH_STOPS = [0, ISOMETRIC_PITCH, Math.PI / 2, -ISOMETRIC_PITCH, -Math.PI / 2]

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
