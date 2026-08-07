import {expect, test} from 'bun:test'
import type {Camera} from '../render/camera'
import {apply, type OrbitState} from './orbit'

const start: Camera = {yaw: 0, pitch: 0.5, zoom: 32, panX: 0, panY: 0}
const idle: OrbitState = {camera: start, gesture: undefined}
const HEIGHT = 400

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
    const plain = apply(down, {type: 'pointermove', x: 200, y: 60}, HEIGHT, false, false)
    const inverted = apply(down, {type: 'pointermove', x: 200, y: 60}, HEIGHT, false, true)

    // Both axes flip together — an inversion that only reversed yaw would be a diagonal drag
    // curving the wrong way, which is worse than either convention on its own.
    expect(inverted.camera.yaw - start.yaw).toBeCloseTo(-(plain.camera.yaw - start.yaw), 10)
    expect(inverted.camera.pitch - start.pitch).toBeCloseTo(-(plain.camera.pitch - start.pitch), 10)

    // Panning drags the picture under a fixed frame, which is the gesture nobody argues about.
    const grabbed = apply(idle, {type: 'pointerdown', x: 0, y: 0, secondary: true}, HEIGHT)
    const move = {type: 'pointermove', x: 100, y: 50} as const
    expect(apply(grabbed, move, HEIGHT, false, true).camera).toEqual(
        apply(grabbed, move, HEIGHT, false, false).camera
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
