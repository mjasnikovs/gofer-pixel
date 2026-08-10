import {expect, test} from 'bun:test'
import {ISOMETRIC_PITCH} from '../doc/cameras'
import {type Camera} from './camera'
import {
    isPerfect,
    isWhole,
    nearestPerfectZoom,
    perfectCell,
    perfectZooms,
    pixelsPerVoxel,
    stepPerfectZoom,
    voxelSteps
} from './perfect'
import {createVolume, type Volume} from './volume'

const volume = (): Volume => createVolume(16, 16, 16, new Uint8Array(256 * 4))

const camera = (yaw: number, pitch: number, zoom: number): Camera => ({
    yaw,
    pitch,
    zoom,
    panX: 0,
    panY: 0
})

const DIMETRIC = Math.asin(0.5)
const THIRDS = Math.asin(1 / 3)

test('pixels per voxel is the scale read the useful way round', () => {
    expect(pixelsPerVoxel(camera(0, 0, 32), 64)).toBe(2)
    expect(pixelsPerVoxel(camera(0, 0, 8), 64)).toBe(8)
})

/*
 * The measurement this module exists for. A striped slab rendered at the default camera of a 16³
 * model — zoom 31 into a 64 px cell — comes out `3 2 2 2 2 2 2 2 3`, and the old readout rounded
 * that to "2 px". The ratio is 2.06 and the staircase is uneven, which is the whole story.
 */
test('a front view is perfect exactly when the cell divides by the zoom', () => {
    expect(isPerfect(camera(0, 0, 32), volume(), 64)).toBe(true)
    expect(isPerfect(camera(0, 0, 16), volume(), 64)).toBe(true)
    expect(isPerfect(camera(0, 0, 31), volume(), 64)).toBe(false)
    expect(isPerfect(camera(0, 0, 24), volume(), 64)).toBe(false)
})

/*
 * The finding that makes `FEATURESET.md` §14's "integer zoom" the wrong invariant, in one line:
 * both of these zooms are integers and only one of them is a whole number of pixels per voxel.
 */
test('an integer zoom is not the same claim as a whole pixel', () => {
    expect(Number.isInteger(31)).toBe(true)
    expect(isPerfect(camera(0, 0, 31), volume(), 64)).toBe(false)
})

/*
 * True isometric is `atan(1/√2)`, the angle at which a cube's three faces come out the same area.
 * Its screen slope is `1/√3`, so a voxel that spans a whole number of pixels across spans an
 * irrational number down. There is no zoom that fixes it, which is the point of returning nothing
 * rather than a nearest integer.
 */
test('true isometric has no pixel-perfect zoom at all', () => {
    expect(perfectZooms(camera(Math.PI / 4, ISOMETRIC_PITCH, 31), volume(), 64, 2, 512)).toEqual([])
    expect(
        nearestPerfectZoom(camera(Math.PI / 4, ISOMETRIC_PITCH, 31), volume(), 64, 2, 512)
    ).toBeUndefined()
    expect(perfectCell(camera(Math.PI / 4, ISOMETRIC_PITCH, 31), volume(), 64, [32, 64, 128])).toBe(
        undefined
    )
})

/*
 * The 2:1 dimetric everyone calls isometric. Its *horizontal* slope is exactly 0.5 — two across,
 * one down — which is why pixel artists draw at it. Its vertical edge is `√1.5` times the
 * horizontal half-step, so the cube still does not close on the grid: 2:1 pixel art squashes the
 * height by hand, and a real orthographic camera cannot.
 */
test('the 2:1 dimetric has an exact screen slope and still no perfect zoom', () => {
    const steps = voxelSteps(camera(Math.PI / 4, DIMETRIC, 32), volume(), 64)
    expect(steps.x.dy / steps.x.dx).toBeCloseTo(-0.5, 6)
    expect(Math.abs(steps.z.dy / steps.x.dx)).toBeCloseTo(Math.sqrt(1.5), 6)
    expect(perfectZooms(camera(Math.PI / 4, DIMETRIC, 32), volume(), 64, 2, 512)).toEqual([])
})

/*
 * The one angle off the axes that does close. `asin(1/3)` is 19.47° of elevation: one voxel moves
 * three pixels across and one down, and stands four pixels tall. Every one of the six components
 * is a whole number, which is what `isPerfect` is actually asking.
 */
test('asin(1/3) is the three-quarter angle that lands on whole pixels', () => {
    const zooms = perfectZooms(camera(Math.PI / 4, THIRDS, 16), volume(), 64, 2, 512)
    expect(zooms.length).toBeGreaterThan(0)
    const zoom = zooms.find(value => Math.abs(value - 64 / (3 * Math.SQRT2)) < 1e-6)
    expect(zoom).toBeDefined()
    const steps = voxelSteps(camera(Math.PI / 4, THIRDS, zoom ?? 0), volume(), 64)
    expect(steps.x.dx).toBeCloseTo(3, 4)
    expect(steps.x.dy).toBeCloseTo(-1, 4)
    expect(steps.z.dy).toBeCloseTo(4, 4)
    expect(isPerfect(camera(Math.PI / 4, THIRDS, zoom ?? 0), volume(), 64)).toBe(true)
})

/*
 * A voxel's y edge projects to nothing in a front view, and nothing is a whole number of pixels.
 * Without that the two degenerate components would fail the check and no front view would pass.
 */
test('an edge that projects to nothing does not fail the check', () => {
    const steps = voxelSteps(camera(0, 0, 32), volume(), 64)
    expect(steps.y.dx).toBe(0)
    expect(steps.y.dy).toBe(0)
    expect(isWhole(0)).toBe(true)
})

test('the perfect zooms of a front view are the cell over a whole number', () => {
    const zooms = perfectZooms(camera(0, 0, 31), volume(), 64, 2, 512)
    expect(zooms).toContain(64)
    expect(zooms).toContain(32)
    expect(zooms).toContain(16)
    expect(zooms).toContain(2)
    expect(zooms).not.toContain(31)
    expect(zooms.every(zoom => isWhole(64 / zoom))).toBe(true)
})

test('the range is honoured at both ends', () => {
    const zooms = perfectZooms(camera(0, 0, 31), volume(), 64, 8, 40)
    expect(Math.min(...zooms)).toBeGreaterThanOrEqual(8)
    expect(Math.max(...zooms)).toBeLessThanOrEqual(40)
})

test('the nearest perfect zoom is the nearest one, not the next one down', () => {
    expect(nearestPerfectZoom(camera(0, 0, 31), volume(), 64, 2, 512)).toBe(32)
    expect(nearestPerfectZoom(camera(0, 0, 17), volume(), 64, 2, 512)).toBe(16)
})

/*
 * Strictly past where it started, in both directions. Rounding to nearest is what left the old
 * integer snap stuck on the value a slow wheel was already sitting on.
 */
test('a notch always moves, even from a zoom that is already perfect', () => {
    expect(stepPerfectZoom(camera(0, 0, 32), volume(), 64, true, 2, 512)).toBe(64)
    expect(stepPerfectZoom(camera(0, 0, 32), volume(), 64, false, 2, 512)).toBeCloseTo(64 / 3, 6)
    expect(stepPerfectZoom(camera(0, 0, 31), volume(), 64, true, 2, 512)).toBe(32)
})

test('a step off the end of the list stays on the end of the list', () => {
    expect(stepPerfectZoom(camera(0, 0, 64), volume(), 64, true, 2, 512)).toBe(64)
    expect(stepPerfectZoom(camera(0, 0, 2), volume(), 64, false, 2, 512)).toBe(2)
})

test('an angle with no lattice steps nowhere', () => {
    expect(
        stepPerfectZoom(camera(Math.PI / 4, ISOMETRIC_PITCH, 31), volume(), 64, true, 2, 512)
    ).toBeUndefined()
})

/*
 * The other repair: leave the composed view alone and change what it is rendered into. Nearest
 * first, so an artist on 64 who could have 32 is not sent to 128.
 */
test('a cell size can be the thing that moves', () => {
    // A frame 128/3 voxels tall is three pixels a voxel at 128 px and a fraction at either of the
    // smaller two, so the only repair on offer is the bigger cell.
    expect(perfectCell(camera(0, 0, 128 / 3), volume(), 64, [32, 64, 128])).toBe(128)
    expect(perfectCell(camera(0, 0, 32), volume(), 64, [32, 64, 128])).toBe(64)
    expect(perfectCell(camera(0, 0, 31), volume(), 64, [32, 64, 128])).toBeUndefined()
})

/*
 * The size of the grid is not part of the question. A basis is built against a volume because that
 * is where the pivot comes from, and the pivot slides the lattice without stretching it.
 */
test('the answer does not depend on the volume or on the pan', () => {
    const small = createVolume(4, 4, 4, new Uint8Array(256 * 4))
    const big = createVolume(120, 90, 64, new Uint8Array(256 * 4))
    expect(isPerfect(camera(0, 0, 32), small, 64)).toBe(true)
    expect(isPerfect(camera(0, 0, 32), big, 64)).toBe(true)
    expect(isPerfect({...camera(0, 0, 32), panX: 3.7, panY: -1.2}, big, 64)).toBe(true)
})
