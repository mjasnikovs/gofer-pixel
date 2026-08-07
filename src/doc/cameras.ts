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

/**
 * The eight directions a sprite sheet is usually cut into, at one click. `pitch` is shared: a sheet
 * whose rows disagree about the horizon is not a sheet.
 */
export const eightDirections = (volume: Volume, pitch = ISOMETRIC_PITCH): NamedCamera[] =>
    DIRECTION_NAMES.map((name, i) => ({
        id: `dir-${String(i)}`,
        name,
        camera: {
            yaw: (i * Math.PI) / 4,
            pitch,
            zoom: defaultZoom(volume),
            panX: 0,
            panY: 0
        }
    }))

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
