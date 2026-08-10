import {expect, test} from 'bun:test'
import type {Camera} from '../render/camera'
import {createVolume} from '../render/volume'
import {apply, type OrbitRules, type OrbitState} from './orbit'

const start: Camera = {yaw: 0, pitch: 0.5, zoom: 32, panX: 0, panY: 0}
const idle: OrbitState = {camera: start, gesture: undefined}
const HEIGHT = 400

const volume = createVolume(16, 16, 16, new Uint8Array(256 * 4))

/**
 * What a snap is measured against. `cell` is here because SNAP is a claim about pixels and the
 * zoom alone cannot make one — see `render/perfect.ts`.
 */
const rules = (over: Partial<OrbitRules> = {}): OrbitRules => ({
    snap: false,
    invert: false,
    cell: 64,
    volume,
    ...over
})

test('a move with no button down changes nothing', () => {
    expect(apply(idle, {type: 'pointermove', x: 50, y: 50}, HEIGHT)).toBe(idle)
})

test('a drag orbits, and the same drag replayed lands in the same place', () => {
    const down = apply(idle, {type: 'pointerdown', x: 100, y: 100, secondary: false}, HEIGHT)
    const half = apply(down, {type: 'pointermove', x: 150, y: 80}, HEIGHT)
    const end = apply(half, {type: 'pointermove', x: 200, y: 60}, HEIGHT)

    expect(end.camera.yaw).toBeCloseTo(1, 10)
    expect(end.camera.pitch).toBeCloseTo(0.9, 10)

    // The gesture is replayed from where it started, so intermediate moves cannot accumulate.
    const jumped = apply(down, {type: 'pointermove', x: 200, y: 60}, HEIGHT)
    expect(jumped.camera).toEqual(end.camera)
})

test('inverting turns the drag the other way, and leaves panning alone', () => {
    const down = apply(idle, {type: 'pointerdown', x: 100, y: 100, secondary: false}, HEIGHT)
    const plain = apply(down, {type: 'pointermove', x: 200, y: 60}, HEIGHT, rules())
    const inverted = apply(
        down,
        {type: 'pointermove', x: 200, y: 60},
        HEIGHT,
        rules({invert: true})
    )

    // Both axes flip together — an inversion that only reversed yaw would be a diagonal drag
    // curving the wrong way, which is worse than either convention on its own.
    expect(inverted.camera.yaw - start.yaw).toBeCloseTo(-(plain.camera.yaw - start.yaw), 10)
    expect(inverted.camera.pitch - start.pitch).toBeCloseTo(-(plain.camera.pitch - start.pitch), 10)

    // Panning drags the picture under a fixed frame, which is the gesture nobody argues about.
    const grabbed = apply(idle, {type: 'pointerdown', x: 0, y: 0, secondary: true}, HEIGHT)
    const move = {type: 'pointermove', x: 100, y: 50} as const
    expect(apply(grabbed, move, HEIGHT, rules({invert: true})).camera).toEqual(
        apply(grabbed, move, HEIGHT, rules()).camera
    )
})

test('pitch stops at the poles instead of tumbling past them', () => {
    const down = apply(idle, {type: 'pointerdown', x: 0, y: 0, secondary: false}, HEIGHT)
    expect(apply(down, {type: 'pointermove', x: 0, y: -1000}, HEIGHT).camera.pitch).toBe(
        Math.PI / 2
    )
    expect(apply(down, {type: 'pointermove', x: 0, y: 1000}, HEIGHT).camera.pitch).toBe(
        -Math.PI / 2
    )
})

test('a secondary drag pans in view units, so it tracks the pointer at any zoom', () => {
    const down = apply(idle, {type: 'pointerdown', x: 0, y: 0, secondary: true}, HEIGHT)
    const moved = apply(down, {type: 'pointermove', x: 100, y: 50}, HEIGHT)

    // 32 voxels over 400 px is 0.08 voxels per pixel.
    expect(moved.camera.panX).toBeCloseTo(-8, 10)
    expect(moved.camera.panY).toBeCloseTo(4, 10)
    expect(moved.camera.yaw).toBe(start.yaw)
})

test('releasing ends the gesture, and a later move does nothing', () => {
    const down = apply(idle, {type: 'pointerdown', x: 0, y: 0, secondary: false}, HEIGHT)
    const dragged = apply(down, {type: 'pointermove', x: 60, y: 0}, HEIGHT)
    const up = apply(dragged, {type: 'pointerup'}, HEIGHT)

    expect(up.gesture).toBeUndefined()
    expect(apply(up, {type: 'pointermove', x: 500, y: 500}, HEIGHT).camera).toEqual(up.camera)
})

test('the wheel scales the view proportionally and stops at both ends', () => {
    const inward = apply(idle, {type: 'wheel', delta: -100}, HEIGHT)
    expect(inward.camera.zoom).toBeCloseTo(32 * Math.exp(-0.1), 10)

    let state = idle
    for (let i = 0; i < 100; i += 1) state = apply(state, {type: 'wheel', delta: -1000}, HEIGHT)
    expect(state.camera.zoom).toBe(2)

    state = idle
    for (let i = 0; i < 100; i += 1) state = apply(state, {type: 'wheel', delta: 1000}, HEIGHT)
    expect(state.camera.zoom).toBe(512)
})

test('selecting a stored camera replaces the view and cancels any drag', () => {
    const down = apply(idle, {type: 'pointerdown', x: 0, y: 0, secondary: false}, HEIGHT)
    const picked: Camera = {yaw: 2, pitch: 0.6, zoom: 20, panX: 1, panY: 2}
    const state = apply(down, {type: 'camera', camera: picked}, HEIGHT)

    expect(state.camera).toEqual(picked)
    expect(state.gesture).toBeUndefined()
})

/*
 * SNAP, which `FEATURESET.md` §14 words as "integer zoom" and which is not that.
 *
 * `cell / zoom` is what lands on the pixel grid, so rounding the zoom is rounding the wrong half.
 * A 16³ document opens on zoom 31 — an integer — and 64 / 31 is 2.06, which exports as
 * `3 2 2 2 2 2 2 2 3`. These tests are about the switch picking stops that are actually stops.
 */

const flat: OrbitState = {
    camera: {yaw: 0, pitch: 0, zoom: 31, panX: 0, panY: 0},
    gesture: undefined
}

test('the wheel walks whole pixels per voxel, not whole zooms', () => {
    const inward = apply(flat, {type: 'wheel', delta: -100}, HEIGHT, rules({snap: true}))
    // 64 / 21.33 is exactly three pixels a voxel. 30 would have been the old answer.
    expect(inward.camera.zoom).toBeCloseTo(64 / 3, 10)

    const outward = apply(flat, {type: 'wheel', delta: 100}, HEIGHT, rules({snap: true}))
    expect(outward.camera.zoom).toBe(32)
})

test('a notch always moves, even from a stop the wheel is already sitting on', () => {
    const on: OrbitState = {camera: {...flat.camera, zoom: 32}, gesture: undefined}
    // A notch in is a smaller zoom, so the stops it walks are the ones below where it stands.
    expect(
        apply(on, {type: 'wheel', delta: -1}, HEIGHT, rules({snap: true})).camera.zoom
    ).toBeCloseTo(64 / 3, 10)
    expect(apply(on, {type: 'wheel', delta: 1}, HEIGHT, rules({snap: true})).camera.zoom).toBe(64)
})

/*
 * A wheel that refuses to turn is a worse answer than one that turns off the grid, and most angles
 * have no whole-pixel lattice at any zoom — true isometric among them, because its screen slope is
 * `1/√3`. The readout in `ScenePanel` is what says so; the wheel just keeps working.
 */
test('an angle with no lattice falls back to the free zoom rather than sticking', () => {
    const iso: OrbitState = {
        camera: {yaw: Math.PI / 4, pitch: Math.atan(Math.SQRT1_2), zoom: 31, panX: 0, panY: 0},
        gesture: undefined
    }
    const moved = apply(iso, {type: 'wheel', delta: -100}, HEIGHT, rules({snap: true}))
    expect(moved.camera.zoom).toBeCloseTo(31 * Math.exp(-0.1), 10)
})

test('a pan snaps to whole voxels and leaves a zoom it cannot improve alone', () => {
    const down = apply(flat, {type: 'pointerdown', x: 0, y: 0, secondary: true}, HEIGHT)
    const moved = apply(down, {type: 'pointermove', x: 37, y: 11}, HEIGHT, rules({snap: true}))
    expect(Number.isInteger(moved.camera.panX)).toBe(true)
    expect(Number.isInteger(moved.camera.panY)).toBe(true)
    // A pan with SNAP on also pulls the zoom onto the nearest stop: 31 is not one, 32 is.
    expect(moved.camera.zoom).toBe(32)
})

test('with the switch off nothing is rounded at all', () => {
    const down = apply(flat, {type: 'pointerdown', x: 0, y: 0, secondary: true}, HEIGHT)
    const moved = apply(down, {type: 'pointermove', x: 37, y: 11}, HEIGHT, rules())
    expect(Number.isInteger(moved.camera.panX)).toBe(false)
    expect(moved.camera.zoom).toBe(31)
})

/*
 * The sprite size is half the question, so the same wheel notch on the same camera lands somewhere
 * else when the export changes. That is the whole reason `cell` had to travel with the switch.
 */
test('the stops move when the sprite size moves', () => {
    const at = (cell: number): number =>
        apply(flat, {type: 'wheel', delta: -100}, HEIGHT, rules({snap: true, cell})).camera.zoom
    expect(at(64)).toBeCloseTo(64 / 3, 10)
    expect(at(128)).toBeCloseTo(128 / 5, 10)
})
