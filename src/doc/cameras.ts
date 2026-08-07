import {defaultZoom, type Camera} from '../render/camera'
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
