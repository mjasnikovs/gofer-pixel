import {expect, test} from 'bun:test'
import {basisFor, type Camera} from '../render/camera'
import {FACE_NORMAL_RGB} from '../render/faces'
import {render} from '../render/raycast'
import {createVolume, setVoxel} from '../render/volume'
import {facingShare, LIGHT_DIRECTION, lightNormals} from './lightcheck'

/** One byte quartet of an encoded normal map, so a face can be lit on its own. */
const mapOf = (rgb: readonly [number, number, number]): Uint8Array =>
    Uint8Array.from([rgb[0], rgb[1], rgb[2], 255])

test('a face pointing at the light is bright and one pointing away is not', () => {
    const [lx, ly, lz] = LIGHT_DIRECTION
    const towards = mapOf([
        Math.round(128 + lx * 127),
        Math.round(128 + ly * 127),
        Math.round(128 + lz * 127)
    ])
    const away = mapOf([
        Math.round(128 - lx * 127),
        Math.round(128 - ly * 127),
        Math.round(128 - lz * 127)
    ])

    expect(lightNormals(towards)[0]).toBe(255)
    // Ambient, and nothing else: a surface facing away is readable rather than a black hole.
    expect(lightNormals(away)[0]).toBe(Math.round(0.25 * 255))
    expect(facingShare(towards)).toBe(1)
    expect(facingShare(away)).toBe(0)
})

test('the preview keeps the sprite silhouette exactly', () => {
    const map = Uint8Array.from([255, 128, 128, 255, 0, 0, 0, 0])
    const lit = lightNormals(map)
    expect(lit[3]).toBe(255)
    // A miss stays clear rather than becoming ambient grey on transparent black.
    expect(lit[7]).toBe(0)
    expect(lit[4]).toBe(0)
    expect(facingShare(map)).toBeLessThan(1)
})

/**
 * The test the diagnostic exists for. Invert the green channel of a real render — the single
 * mistake `FEATURESET.md` §19 names — and the share of the model facing the light has to move. If
 * this decoded the map with the renderer's own table the two would cancel and it would not.
 */
test('an inverted green channel is visible in the number, not only in the picture', () => {
    const volume = createVolume(8, 8, 8, new Uint8Array(256 * 4))
    for (let y = 0; y < 6; y += 1) {
        for (let x = 0; x < 6; x += 1) {
            for (let z = 0; z < 4; z += 1) setVoxel(volume, x + 1, y + 1, z + 1, 1)
        }
    }
    const camera: Camera = {yaw: 0.7, pitch: 0.5, zoom: 10, panX: 0, panY: 0}
    const {normal} = render(volume, basisFor(camera, volume, 48), 48, 48)

    const flipped = new Uint8Array(normal)
    for (let i = 1; i < flipped.length; i += 4) flipped[i] = 255 - (flipped[i] ?? 128)

    expect(facingShare(normal)).not.toBeCloseTo(facingShare(flipped), 2)
})

/**
 * The decode is written from the documented encoding rather than from the table, and this is the
 * one place the two are allowed to meet: every face the renderer knows about has to survive a
 * round trip through it, or the documentation and the table have drifted.
 */
test('every face decodes back to the unit vector the encoding says it is', () => {
    for (let face = 1; face <= 6; face += 1) {
        const rgb = FACE_NORMAL_RGB[face]
        if (!rgb) throw new Error(`face ${String(face)} has a normal`)
        const decode = (byte: number): number => (byte - 128) / (byte >= 128 ? 127 : 128)
        const decoded = [decode(rgb[0]), decode(rgb[1]), decode(rgb[2])] as const
        // Exactly one, not nearly one: the encoding's two poles are exact and its middle is zero.
        expect(Math.hypot(...decoded)).toBe(1)
        // Exactly one axis is non-zero on a face normal, and it is ±1.
        expect(decoded.filter(value => Math.abs(value) > 0.5)).toHaveLength(1)
    }
})
