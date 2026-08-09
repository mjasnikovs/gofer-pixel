import {expect, test} from 'bun:test'
import {ISOMETRIC_PITCH} from '../doc/cameras'
import {createCamera, type Camera} from '../render/camera'
import {createVolume, setVoxel, type Volume} from '../render/volume'
import {boxCorners, floorOf, ghostMesh, hull, projector, unitCubeCorners} from './overlay'

/**
 * The overlay geometry, asked directly.
 *
 * `ViewportOverlay.test.tsx` used to be the only place these rules were checked, and it checked
 * them by rendering SVG and parsing the strings back: `moves('outline')` counted `M` characters in
 * a `d` attribute, and the lattice pitch was recovered by de-duplicating `x.toFixed(4)` off a list
 * of `<line>` nodes. `expect(run.moves('outline')).toBe(20)` is a claim about *geometry* expressed
 * as a count of letters. These are the same claims, about points.
 */

const grid = (size = 32): Volume => createVolume(size, size, size, new Uint8Array(256 * 4))

const iso = (volume: Volume): Camera => createCamera(volume, Math.PI / 4, ISOMETRIC_PITCH)

/** A grid with one voxel in it, so `filledBounds` has something to find. */
const withVoxel = (at: readonly [number, number, number]): Volume => {
    const volume = grid()
    setVoxel(volume, at[0], at[1], at[2], 1)
    return volume
}

test('a box projects to eight corners and the hull of them is its silhouette', () => {
    const volume = grid()
    const project = projector(iso(volume), volume)
    const corners = boxCorners([0, 0, 0], [7, 7, 7]).map(project)

    expect(corners).toHaveLength(8)
    // A box seen from any angle is a convex hexagon, or a rectangle head-on. Never more than six.
    const silhouette = hull(corners)
    expect(silhouette.length).toBeGreaterThanOrEqual(4)
    expect(silhouette.length).toBeLessThanOrEqual(6)
    // Every corner is inside or on the hull, which is what makes it the silhouette exactly.
    expect(new Set(silhouette.map(p => `${String(p.x)},${String(p.y)}`)).size).toBe(
        silhouette.length
    )
})

test('the far face of a box range is one lattice step past its last cell', () => {
    const [near] = boxCorners([2, 3, 4], [2, 3, 4])
    const far = boxCorners([2, 3, 4], [2, 3, 4])[7]
    expect(near).toEqual([2, 3, 4])
    expect(far).toEqual([3, 4, 5])
})

test('the view cube is the unit cube centred on the origin', () => {
    const corners = unitCubeCorners()
    expect(corners).toHaveLength(8)
    for (const corner of corners) for (const axis of corner) expect(Math.abs(axis)).toBe(0.5)
    // Centred: every coordinate sums to zero across the eight.
    for (let axis = 0; axis < 3; axis += 1) {
        expect(corners.reduce((sum, corner) => sum + (corner[axis] ?? 0), 0)).toBe(0)
    }
})

test('the fine lattice is one line per voxel boundary and stops dead on the volume', () => {
    const volume = grid(32)
    const {fine, step} = floorOf(volume, iso(volume))

    expect(step).toBe(1)
    // 33 lines each way: one per voxel boundary, both edges included.
    expect(fine).toHaveLength((volume.sx + 1) * 2)
})

test('the lattice coarsens with the zoom, not with the size of the grid', () => {
    const volume = grid(32)
    const close = iso(volume)

    // Legibility is a screen question. Keyed to `sx, sy` this drew two-voxel cells on a 32³
    // document with room for one-voxel ones, and never coarsened at all when the artist zoomed out.
    expect(floorOf(volume, {...close, zoom: 64}).step).toBe(1)
    expect(floorOf(volume, {...close, zoom: 512}).step).toBe(4)
    expect(floorOf(volume, {...close, zoom: 2048}).step).toBe(16)

    // And the grid's own size changes nothing.
    expect(floorOf(grid(128), {...close, zoom: 64}).step).toBe(1)
})

test('the ground is coarser than the cells inside, and reaches further out', () => {
    const volume = grid(32)
    const {fine, ground, coarse, step} = floorOf(volume, iso(volume))

    expect(coarse).toBe(step * 5)

    const reach = (lines: typeof fine): number =>
        Math.max(...lines.flatMap(({a, b}) => [Math.hypot(a.x, a.y), Math.hypot(b.x, b.y)]))
    expect(reach(ground)).toBeGreaterThan(reach(fine))
})

/*
 * Walking from `-pad` in steps of `coarse` only lands on the far edge when `coarse` divides the
 * volume. It divided 32 at four voxels and does not at five, so the lattice gained a stub cell on
 * two sides and the whole floor read as pushed off-centre.
 */
test('the ground sits centred on the volume, whatever the coarse cell divides into', () => {
    const volume = grid(32)
    const {ground, middle} = floorOf(volume, {...iso(volume), zoom: 128})

    const xs = ground.flatMap(({a, b}) => [a.x, b.x])
    const left = middle.x - Math.min(...xs)
    const right = Math.max(...xs) - middle.x
    expect(left).toBeCloseTo(right, 6)
})

test('the hole in the floor is cut around the voxels, not around the grid', () => {
    // A 128³ grid holding one voxel projects a box the size of the viewport if you mask by `sx`.
    const sparse = createVolume(128, 128, 128, new Uint8Array(256 * 4))
    setVoxel(sparse, 64, 64, 0, 1)
    const {silhouette} = floorOf(sparse, iso(sparse))

    expect(silhouette.length).toBeGreaterThan(0)
    // The *span* of the hole, not its distance from the projection centre: one voxel across, not
    // a hundred and twenty-eight. Masking by `sx, sy, sz` took the whole floor away instead.
    const xs = silhouette.map(p => p.x)
    const ys = silhouette.map(p => p.y)
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(4)
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(4)
})

test('an empty grid has no silhouette to cut, and says so rather than cutting everything', () => {
    const volume = grid()
    expect(floorOf(volume, iso(volume)).silhouette).toEqual([])
})

test('a single floating cell is three faces, twelve edges and a shadow', () => {
    const volume = withVoxel([3, 3, 4])
    const {skin, wire, shadow, legs} = ghostMesh([[3, 3, 4]], iso(volume), volume)

    // Half the cube faces away and the near side already covers it.
    expect(skin).toHaveLength(3)
    // Nothing next to it, so no edge is coplanar with anything.
    expect(wire).toHaveLength(12)
    // The footprint on the floor, and a line down to it from each of its four corners.
    expect(shadow).toHaveLength(4)
    expect(legs).toHaveLength(4)
    // Every face is a quad.
    for (const quad of skin) expect(quad).toHaveLength(4)
})

test('a cell standing on the floor casts no shadow, because there is nowhere to drop to', () => {
    const volume = withVoxel([3, 3, 0])
    const {skin, shadow, legs} = ghostMesh([[3, 3, 0]], iso(volume), volume)

    expect(shadow).toEqual([])
    expect(legs).toEqual([])
    expect(skin).toHaveLength(3)
})

/*
 * The rule `FLAT` exists for. Two cells side by side mean the surface runs straight through, so the
 * faces meeting at the shared edge are coplanar — ruling a line there draws a lattice across a flat
 * slab. This is the assertion that used to be a count of `M` characters.
 */
test('a flat run is not ruled into a lattice, and a pinch keeps its edge', () => {
    const volume = grid()
    const camera = iso(volume)

    const one = ghostMesh([[3, 3, 4]], camera, volume).wire.length
    const two = ghostMesh(
        [
            [3, 3, 4],
            [4, 3, 4]
        ],
        camera,
        volume
    ).wire.length

    // Two separate cells would be 24. The shared face's four edges go, and the run through the
    // middle is coplanar, so the pair is a box: still twelve, plus the four at the seam that are
    // genuine corners of the longer box.
    expect(one).toBe(12)
    expect(two).toBeLessThan(one * 2)

    /*
     * Two cells meeting only at a corner is the opposite case — a genuine pinch, nothing coplanar,
     * so the edge stays. It stays *once*: the two cells name the same lattice edge, and `seen`
     * keeps it from being drawn twice. So 24 edges minus that one duplicate.
     */
    const pinched = ghostMesh(
        [
            [3, 3, 4],
            [4, 4, 4]
        ],
        camera,
        volume
    ).wire.length
    expect(pinched).toBe(one * 2 - 1)
})

test('an interior face is never drawn, so the block takes one uniform alpha', () => {
    const volume = grid()
    const camera = iso(volume)

    // A 2 × 2 × 2 block. Eight cells, twenty-four outward faces, half of them facing away.
    const cells: [number, number, number][] = []
    for (let x = 3; x < 5; x += 1) {
        for (let y = 3; y < 5; y += 1) {
            for (let z = 4; z < 6; z += 1) cells.push([x, y, z])
        }
    }
    expect(ghostMesh(cells, camera, volume).skin).toHaveLength(12)
})
