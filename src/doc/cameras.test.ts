import {expect, test} from 'bun:test'
import {isPerfect, perfectZooms, voxelSteps} from '../render/perfect'
import {createVolume} from '../render/volume'
import {
    alignCamera,
    DIMETRIC_PITCH,
    directions,
    ISOMETRIC_PITCH,
    nextRingPitch,
    RING_PITCHES,
    RING_PITCH_ORDER,
    type RingPitch
} from './cameras'

/**
 * The three pitches a ring can be built at, judged by the only thing that separates them: how a
 * voxel lands on the pixel grid. `render/perfect.ts` is the arithmetic; this is the product claim
 * each label on the button is making.
 */

const volume = createVolume(16, 16, 16, new Uint8Array(256 * 4))
const CELL = 64
const YAW = Math.PI / 4

const slope = (pitch: number): number => {
    const steps = voxelSteps({yaw: YAW, pitch, zoom: 32, panX: 0, panY: 0}, volume, CELL)
    return Math.abs(steps.x.dy / steps.x.dx)
}

test('ISO is the modelling angle and its staircase is irrational', () => {
    expect(ISOMETRIC_PITCH).toBeCloseTo((35.264 * Math.PI) / 180, 4)
    expect(slope(ISOMETRIC_PITCH)).toBeCloseTo(1 / Math.sqrt(3), 6)
    expect(
        perfectZooms(
            {yaw: YAW, pitch: ISOMETRIC_PITCH, zoom: 32, panX: 0, panY: 0},
            volume,
            CELL,
            2,
            512
        )
    ).toEqual([])
})

test('2:1 is two across and one down, exactly', () => {
    expect(DIMETRIC_PITCH).toBeCloseTo(Math.PI / 6, 10)
    expect(slope(DIMETRIC_PITCH)).toBeCloseTo(0.5, 10)
})

/*
 * The measurement that says 2:1 is as close as an honest camera gets. `asin(1/3)` closes on the
 * grid and nothing else off the axes does — it was a fourth pitch for a while and is not one now,
 * because it shows a third less top face and lines up with no tileset on earth. See
 * `DIMETRIC_PITCH`'s note and `render/perfect.test.ts`.
 */
test('no pitch the button offers has a whole-pixel zoom off the axes', () => {
    for (const pitch of [ISOMETRIC_PITCH, DIMETRIC_PITCH]) {
        expect(
            perfectZooms({yaw: YAW, pitch, zoom: 32, panX: 0, panY: 0}, volume, CELL, 2, 512)
        ).toEqual([])
    }
})

/*
 * Flat is the easy case rather than a lesser one: at yaw 0 there is nothing to reconcile, so any
 * sprite size that divides by the zoom works. It is what a side-on character sheet is drawn at.
 */
test('flat is on the grid whenever the sprite size divides by the zoom', () => {
    expect(RING_PITCHES.flat).toBe(0)
    expect(isPerfect({yaw: 0, pitch: 0, zoom: 32, panX: 0, panY: 0}, volume, CELL)).toBe(true)
    expect(isPerfect({yaw: 0, pitch: 0, zoom: 31, panX: 0, panY: 0}, volume, CELL)).toBe(false)
})

test('the button cycles every pitch and comes back to the default', () => {
    let pitch: RingPitch = RING_PITCH_ORDER[0]
    const seen: RingPitch[] = [pitch]
    for (let i = 0; i < RING_PITCH_ORDER.length - 1; i += 1) {
        pitch = nextRingPitch(pitch)
        seen.push(pitch)
    }
    expect(seen).toEqual([...RING_PITCH_ORDER])
    // 2:1 is the default and therefore the one the cycle comes home to.
    expect(nextRingPitch(pitch)).toBe('dimetric')
    expect(RING_PITCH_ORDER[0]).toBe('dimetric')
})

test('every pitch in the order is a pitch the ring builder knows', () => {
    for (const pitch of RING_PITCH_ORDER) {
        expect(RING_PITCHES[pitch]).toBeDefined()
        const ring = directions(volume, 8, RING_PITCHES[pitch])
        expect(ring).toHaveLength(8)
        // A ring is one pitch, one zoom and one pivot; only the yaw moves. §14's "consistent
        // object scale between camera views" is that line rather than a feature.
        expect(ring.every(camera => camera.camera.pitch === RING_PITCHES[pitch])).toBe(true)
    }
})

/*
 * Align has to be able to reach the new pitches or the button offers an angle the artist cannot
 * get back to by hand. It snaps to the nearest, not to a named view — an artist roughly at 2:1
 * wants 2:1, not isometric.
 */
test('align reaches every pitch the button can build', () => {
    for (const pitch of RING_PITCH_ORDER) {
        const near = RING_PITCHES[pitch] + 0.02
        const camera = {yaw: 0.8, pitch: near, zoom: 32, panX: 0, panY: 0}
        expect(alignCamera(camera).pitch).toBeCloseTo(RING_PITCHES[pitch], 10)
    }
})

test('align still snaps the yaw to an eighth', () => {
    expect(alignCamera({yaw: 0.8, pitch: 0, zoom: 32, panX: 0, panY: 0}).yaw).toBeCloseTo(
        Math.PI / 4,
        10
    )
})
