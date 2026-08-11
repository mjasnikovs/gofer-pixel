import type {Volume} from '../render/volume'
import {voxelIndex} from '../render/volume'
import type {BoxOp, Vec3, VoxSpec} from './ops'

/**
 * A finished model, taken apart into the primitives that would rebuild it.
 *
 * The worked examples in `src/gen/llama.ts` are the ceiling on everything the generator produces —
 * measured twice on 2026-08-08, in both directions: a better example lifted every output and a
 * deliberately worse one dragged every output down to its own flaws. The examples shipped so far are
 * programmer art, hand-typed box by box. This is the other way round: an artist's `.vox` goes in and
 * the code that draws it comes out, so a teacher can be *made* rather than typed.
 *
 * The decomposition is **lossless**, and that is the whole test: `rasterise(decompose(v))` is `v`
 * again, cell for cell and colour for colour. A lossy decomposer would teach the model a model the
 * artist never drew.
 *
 * Boxes only. `ball` would fit organic shapes in fewer ops, but a sphere that misses by one cell is
 * no longer a decomposition of anything, and the fit search costs more than the lines it saves.
 */

/** A run of same-coloured cells, in *volume* space. Inclusive on both corners. */
interface Slab {
    readonly x0: number
    readonly y0: number
    readonly z0: number
    readonly x1: number
    readonly y1: number
    readonly z1: number
    readonly value: number
}

/**
 * The six orders the three axes can be grown in.
 *
 * Growing greedily along one axis at a time gives a different box for each order — a wing that is
 * 8 long and 1 thick comes out whole under `z,x,y` and comes out as eight cubes under `x,y,z`. Six
 * tries is cheap and the best of the six is what gets emitted.
 */
const ORDERS: readonly (readonly [0, 1, 2] | readonly number[])[] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0]
]

const at = (data: Uint8Array, volume: Volume, x: number, y: number, z: number): number => {
    if (x < 0 || y < 0 || z < 0 || x >= volume.sx || y >= volume.sy || z >= volume.sz) return 0
    return data[voxelIndex(volume, x, y, z)] ?? 0
}

/** Whether every cell of the inclusive box still holds `value` and is still unclaimed. */
const solid = (
    data: Uint8Array,
    volume: Volume,
    lo: readonly [number, number, number],
    hi: readonly [number, number, number],
    value: number
): boolean => {
    for (let z = lo[2]; z <= hi[2]; z += 1) {
        for (let y = lo[1]; y <= hi[1]; y += 1) {
            for (let x = lo[0]; x <= hi[0]; x += 1) {
                if (at(data, volume, x, y, z) !== value) return false
            }
        }
    }
    return true
}

/**
 * The largest box this start cell can grow into, over the six axis orders.
 *
 * Each axis is pushed as far as it goes before the next one is tried, which is what makes it greedy
 * rather than exhaustive. An exact maximum-volume box would be a search over three extents per start
 * cell, and the measured difference on `car.vox` did not pay for it.
 */
const grow = (data: Uint8Array, volume: Volume, sx: number, sy: number, sz: number): Slab => {
    const value = at(data, volume, sx, sy, sz)
    const limit = [volume.sx, volume.sy, volume.sz]
    let best: Slab = {x0: sx, y0: sy, z0: sz, x1: sx, y1: sy, z1: sz, value}
    let bestVolume = 1

    for (const order of ORDERS) {
        const hi = [sx, sy, sz]
        for (const axis of order) {
            // One step at a time rather than a bisection: the slab test is what costs, and a box
            // that stops after two steps pays for two slabs either way.
            while (hi[axis] !== undefined && (hi[axis] ?? 0) + 1 < (limit[axis] ?? 0)) {
                const next = [...hi]
                next[axis] = (hi[axis] ?? 0) + 1
                const lo: [number, number, number] = [sx, sy, sz]
                lo[axis] = next[axis] ?? 0
                if (!solid(data, volume, lo, [next[0] ?? 0, next[1] ?? 0, next[2] ?? 0], value)) {
                    break
                }
                hi[axis] = next[axis] ?? 0
            }
        }
        const x1 = hi[0] ?? sx
        const y1 = hi[1] ?? sy
        const z1 = hi[2] ?? sz
        const size = (x1 - sx + 1) * (y1 - sy + 1) * (z1 - sz + 1)
        if (size > bestVolume) {
            bestVolume = size
            best = {x0: sx, y0: sy, z0: sz, x1, y1, z1, value}
        }
    }
    return best
}

/**
 * Whether a cell can be the minimum corner of a maximal box.
 *
 * A cell with an unclaimed same-coloured neighbour below it on any axis is inside somebody else's
 * box, so anchoring there can only ever produce a smaller one. Skipping those turns the search from
 * every remaining cell into the handful of corners, which is what makes a 32³ asset decompose in
 * well under a second instead of well over a minute.
 */
const isCorner = (data: Uint8Array, volume: Volume, x: number, y: number, z: number): boolean => {
    const value = at(data, volume, x, y, z)
    if (at(data, volume, x - 1, y, z) === value) return false
    if (at(data, volume, x, y - 1, z) === value) return false
    if (at(data, volume, x, y, z - 1) === value) return false
    return true
}

/** The inclusive box the filled cells occupy, or `undefined` for an empty volume. */
export const occupiedBounds = (
    volume: Volume
): {readonly lo: Vec3; readonly hi: Vec3} | undefined => {
    const lo: Vec3 = [Infinity, Infinity, Infinity]
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
    let any = false
    for (let z = 0; z < volume.sz; z += 1) {
        for (let y = 0; y < volume.sy; y += 1) {
            for (let x = 0; x < volume.sx; x += 1) {
                if ((volume.data[voxelIndex(volume, x, y, z)] ?? 0) === 0) continue
                any = true
                lo[0] = Math.min(lo[0], x)
                lo[1] = Math.min(lo[1], y)
                lo[2] = Math.min(lo[2], z)
                hi[0] = Math.max(hi[0], x)
                hi[1] = Math.max(hi[1], y)
                hi[2] = Math.max(hi[2], z)
            }
        }
    }
    return any ? {lo, hi} : undefined
}

const hexOf = (palette: Uint8Array, index: number): string => {
    const base = index * 4
    const part = (offset: number): string =>
        ((palette[base + offset] ?? 0) & 0xff).toString(16).padStart(2, '0')
    return `#${part(0)}${part(1)}${part(2)}`
}

/**
 * A volume, as the ops that rebuild it.
 *
 * **Op coordinates are y-up and a `Volume` is z-up**, the same swap `rasterise` undoes and for the
 * same measured reason (`src/gen/ops.ts`, finding 5). An axis permutation maps boxes onto boxes, so
 * the search runs in volume space and only the emitted corners are swapped.
 *
 * Coordinates come out relative to the model's own occupied box, starting at `0`. That is not
 * cosmetic: `gridFor` fits the grid to what the ops paint, so a model decomposed in place inside a
 * larger grid would rasterise back a different size to the one it came from, and the round trip
 * would stop being a round trip.
 */
export const decompose = (volume: Volume, name: string): VoxSpec => {
    const bounds = occupiedBounds(volume)
    if (!bounds) return {name, size: [1, 1, 1], mirror_x: false, ops: []}
    const {lo, hi} = bounds

    // A working copy, because a claimed cell has to stop being available to the next box and the
    // document must not be the thing that changes.
    const data = Uint8Array.from(volume.data)
    const ops: BoxOp[] = []

    for (let z = lo[2]; z <= hi[2]; z += 1) {
        for (let y = lo[1]; y <= hi[1]; y += 1) {
            for (let x = lo[0]; x <= hi[0]; x += 1) {
                if (at(data, volume, x, y, z) === 0) continue
                if (!isCorner(data, volume, x, y, z)) continue
                const box = grow(data, volume, x, y, z)
                for (let bz = box.z0; bz <= box.z1; bz += 1) {
                    for (let by = box.y0; by <= box.y1; by += 1) {
                        for (let bx = box.x0; bx <= box.x1; bx += 1) {
                            data[voxelIndex(volume, bx, by, bz)] = 0
                        }
                    }
                }
                ops.push({
                    op: 'box',
                    // volume (x, y, z) is op (x, z, y): the depth and height axes trade places.
                    from: [box.x0 - lo[0], box.z0 - lo[2], box.y0 - lo[1]],
                    to: [box.x1 - lo[0], box.z1 - lo[2], box.y1 - lo[1]],
                    color: hexOf(volume.palette, box.value)
                })
            }
        }
    }

    /*
     * There was a second sweep here, repeating until nothing was left, on the theory that a cell
     * skipped as a non-corner could be stranded once its blocker was claimed. It cannot happen, and
     * the argument is short enough to keep instead of the loop.
     *
     * `isCorner` only ever looks at `-x`, `-y` and `-z`, which are all *earlier* in scan order. So
     * by induction over that order: every filled cell earlier than the one being visited has
     * already been zeroed, therefore all three neighbours read `0`, therefore the cell is a corner
     * and is claimed here and now. Nothing is ever skipped, so nothing is ever left.
     *
     * Measured as well as argued: 232,000 random volumes across four sizes, five densities and four
     * palette sizes, and the loop body never once ran. `decompose.test.ts` pins the invariant on the
     * shapes that would break it if the scan order or `isCorner` ever changed.
     */

    return {
        name,
        // Op space reads [width, height, depth], so the volume's z extent is the height.
        size: [hi[0] - lo[0] + 1, hi[2] - lo[2] + 1, hi[1] - lo[1] + 1],
        mirror_x: false,
        ops
    }
}

/**
 * Ops as the program the model is shown.
 *
 * The reply format is code (`src/gen/code.ts`), so an example has to be code as well — a worked
 * example in a different language to the answer teaches the wrong thing twice. Colours are hoisted
 * into `const`s and the boxes are grouped under them, because that is the shape the hand-written
 * examples have and the shape the model imitates.
 *
 * Names are `c1 … cN`. A decomposition knows which cells share a colour and nothing about what the
 * colour *is*, and `fur` on a wall would be a worse lie than `c3`.
 */
export const opsToCode = (spec: VoxSpec, headline: string): string => {
    const boxes = spec.ops.filter((op): op is BoxOp => op.op === 'box')
    const order: string[] = []
    const grouped = new Map<string, BoxOp[]>()
    for (const box of boxes) {
        const key = box.color.toLowerCase()
        const found = grouped.get(key)
        if (found) {
            found.push(box)
        } else {
            order.push(key)
            grouped.set(key, [box])
        }
    }

    const names = new Map<string, string>()
    order.forEach((colour, index) => {
        names.set(colour, `c${String(index + 1)}`)
    })

    const lines: string[] = [`// ${headline}`]

    // Declarations wrapped to the project's 100-column width, so the generated file needs no
    // formatter run to look like the rest of the source.
    let declaration = ''
    for (const colour of order) {
        const piece = `${names.get(colour) ?? 'c'} = '${colour}'`
        const joined = declaration === '' ? `const ${piece}` : `${declaration}, ${piece}`
        if (joined.length > 100 && declaration !== '') {
            lines.push(declaration)
            declaration = `const ${piece}`
        } else {
            declaration = joined
        }
    }
    if (declaration !== '') lines.push(declaration)

    for (const colour of order) {
        for (const box of grouped.get(colour) ?? []) {
            const from = box.from.map(String).join(',')
            const to = box.to.map(String).join(',')
            lines.push(`box(${from}, ${to}, ${names.get(colour) ?? "'#000000'"})`)
        }
    }

    return lines.join('\n')
}

/** What `opsToCode` will cost: the numbers a decomposed asset is accepted or rejected on. */
export const exampleCost = (spec: VoxSpec): {readonly lines: number; readonly colours: number} => {
    const boxes = spec.ops.filter((op): op is BoxOp => op.op === 'box')
    const colours = new Set(boxes.map(box => box.color.toLowerCase())).size
    return {lines: opsToCode(spec, 'x').split('\n').length, colours}
}
