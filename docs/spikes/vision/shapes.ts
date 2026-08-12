/*
 * The stimulus corpus: shapes built in code, whose every ground truth is *computed from the volume*
 * rather than declared by hand.
 *
 * Three rules make this a measurement instead of an impression:
 *
 * 1. **Nothing is judged by eye.** `truthOf` walks the grid — 6-connected components, filled bounds,
 *    which component touches the floor, where the marked colour sits relative to the model's own
 *    centre. A shape whose declared name disagrees with its own geometry is a bug in the shape.
 * 2. **Colour never carries the answer.** Everything is one neutral grey-blue, because the first
 *    smoke run called a red ball "Tomato". The only second colour in the corpus is the deliberate
 *    mark, and the only question that uses it is the one about which side it is on.
 * 3. **Every question's answers are balanced**, and that rule was bought with a measurement. The
 *    first corpus was 16 one-part shapes out of 18 and 12 tall shapes out of 15, so the no-image
 *    control scored **89 % on "how many pieces" and 94 % on "is anything floating" with the pictures
 *    taken away** — the majority answer was the right answer. Each question now has its own family,
 *    sized so that always saying one thing scores at chance. `bun run …/run.ts corpus` prints the
 *    distribution, so the balance is checked rather than believed.
 *
 * Volume axes, which is what every truth below is stated in: `x` is left/right and `+x` is the
 * viewer's right at the Front camera, `y` is front/back with `+y` toward that camera, `z` is up.
 * That is `basisFor` at yaw 0 — `right = (1,0,0)`, `forward = (0,-1,0)`, `up = (0,0,1)` — and not
 * op space, which is y-up and gets swapped by `rasterise`. These shapes never go through ops.
 */
import {createVolume, filledBounds, setVoxel, voxelAt, type Volume} from '../../../src/render/volume'

/** The one colour the shapes are made of, and the one the mark is made of. */
const BASE = [0x9a, 0xa4, 0xb4, 0xff]
const MARK = [0xc8, 0x46, 0x3c, 0xff]

const BASE_INDEX = 1
const MARK_INDEX = 2

const palette = (): Uint8Array => {
    const bytes = new Uint8Array(256 * 4)
    bytes.set(BASE, BASE_INDEX * 4)
    bytes.set(MARK, MARK_INDEX * 4)
    return bytes
}

type Put = (x: number, y: number, z: number, mark?: boolean) => void

/** A builder writes into the grid it is handed. `n` is the cube's side. */
type Build = (put: Put, n: number) => void

export type QuestionId = 'name' | 'parts' | 'longest' | 'mark' | 'floating'

export interface Stimulus {
    readonly id: string
    /** Which questions this shape is part of. A shape answers only what its family was built for. */
    readonly asks: readonly QuestionId[]
    /** The word this shape is, for the closed-list naming question. */
    readonly name?: string
    readonly build: Build
}

/** Rounds toward the grid: `at(0.5, 32)` is 16. */
const at = (fraction: number, n: number): number => Math.round(fraction * (n - 1))

const boxFill = (
    put: Put,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number
): void => {
    for (let z = z0; z <= z1; z += 1) {
        for (let y = y0; y <= y1; y += 1) {
            for (let x = x0; x <= x1; x += 1) put(x, y, z)
        }
    }
}

/** A box in fractions of the cube, which is what makes one shape mean the same thing at 8³ and 64³. */
const boxAt = (
    put: Put,
    n: number,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number
): void =>
    boxFill(put, at(x0, n), at(y0, n), at(z0, n), at(x1, n), at(y1, n), at(z1, n))

const ballFill = (put: Put, cx: number, cy: number, cz: number, r: number, n: number): void => {
    for (let z = 0; z < n; z += 1) {
        for (let y = 0; y < n; y += 1) {
            for (let x = 0; x < n; x += 1) {
                const dx = (x - cx) / r
                const dy = (y - cy) / r
                const dz = (z - cz) / r
                if (dx * dx + dy * dy + dz * dz <= 1) put(x, y, z)
            }
        }
    }
}

const ballAt = (put: Put, n: number, cx: number, cy: number, cz: number, r: number): void =>
    ballFill(put, at(cx, n), at(cy, n), at(cz, n), Math.max(1, at(r, n)), n)

/* ------------------------------------------------------------------ *
 * Family 1 — the twelve primitives. The closed list the naming        *
 * question chooses from, and nothing else.                            *
 * ------------------------------------------------------------------ */

const PRIMITIVES: readonly Stimulus[] = [
    {
        id: 'ball',
        name: 'ball',
        asks: ['name'],
        // On the floor like everything that is not the floating case: a lone component off the ground
        // would answer "is anything floating" yes for a shape with no second part.
        build: (put, n) => ballAt(put, n, 0.5, 0.5, 0.4, 0.4)
    },
    {
        id: 'cube',
        name: 'cube',
        asks: ['name'],
        build: (put, n) =>
            boxFill(
                put,
                at(0.25, n),
                at(0.25, n),
                0,
                at(0.75, n),
                at(0.75, n),
                at(0.75, n) - at(0.25, n)
            )
    },
    {
        id: 'pillar',
        name: 'pillar',
        asks: ['name'],
        build: (put, n) => boxAt(put, n, 0.42, 0.42, 0, 0.58, 0.58, 0.95)
    },
    {
        id: 'cone',
        name: 'cone',
        asks: ['name'],
        build: (put, n) => {
            const top = at(0.9, n)
            for (let z = 0; z <= top; z += 1) {
                ballFill(put, at(0.5, n), at(0.5, n), z, Math.max(0.5, at(0.4, n) * (1 - z / top)), n)
            }
        }
    },
    {
        id: 'pyramid',
        name: 'pyramid',
        asks: ['name'],
        build: (put, n) => {
            const top = at(0.8, n)
            for (let z = 0; z <= top; z += 1) {
                const half = Math.round(at(0.4, n) * (1 - z / (top + 1)))
                const c = at(0.5, n)
                boxFill(put, c - half, c - half, z, c + half, c + half, z)
            }
        }
    },
    {
        id: 'ring',
        name: 'ring',
        asks: ['name'],
        build: (put, n) => {
            const c = at(0.5, n)
            const big = at(0.38, n)
            const small = Math.max(1, at(0.11, n))
            for (let z = 0; z < n; z += 1) {
                for (let y = 0; y < n; y += 1) {
                    for (let x = 0; x < n; x += 1) {
                        const q = Math.hypot(x - c, y - c) - big
                        if (q * q + (z - small) ** 2 <= small * small) put(x, y, z)
                    }
                }
            }
        }
    },
    {
        id: 'plate',
        name: 'plate',
        asks: ['name'],
        build: (put, n) => boxAt(put, n, 0.05, 0.2, 0, 0.95, 0.8, 0.08)
    },
    {
        id: 'l-shape',
        name: 'l-shape',
        asks: ['name'],
        build: (put, n) => {
            boxAt(put, n, 0.3, 0.4, 0, 0.45, 0.6, 0.85)
            boxAt(put, n, 0.3, 0.4, 0, 0.75, 0.6, 0.15)
        }
    },
    {
        id: 't-shape',
        name: 't-shape',
        asks: ['name'],
        build: (put, n) => {
            boxAt(put, n, 0.42, 0.42, 0, 0.58, 0.58, 0.7)
            boxAt(put, n, 0.2, 0.42, 0.72, 0.8, 0.58, 0.88)
        }
    },
    {
        id: 'cross',
        name: 'cross',
        asks: ['name'],
        build: (put, n) => {
            boxAt(put, n, 0.42, 0.45, 0, 0.58, 0.55, 0.9)
            boxAt(put, n, 0.15, 0.45, 0.5, 0.85, 0.55, 0.66)
        }
    },
    {
        id: 'staircase',
        name: 'staircase',
        asks: ['name'],
        build: (put, n) => {
            for (let i = 0; i < 4; i += 1) {
                const y0 = at(0.15 + i * 0.175, n)
                const y1 = at(0.15 + (i + 1) * 0.175, n) - 1
                boxFill(put, at(0.25, n), y0, 0, at(0.75, n), y1, at(0.2 + i * 0.2, n))
            }
        }
    },
    {
        id: 'arch',
        name: 'arch',
        asks: ['name'],
        build: (put, n) => {
            boxAt(put, n, 0.15, 0.42, 0, 0.32, 0.58, 0.6)
            boxAt(put, n, 0.68, 0.42, 0, 0.85, 0.58, 0.6)
            boxAt(put, n, 0.15, 0.42, 0.62, 0.85, 0.58, 0.8)
        }
    }
]

/* ------------------------------------------------------------------ *
 * Family 2 — nine slabs for "which measurement is largest".           *
 * Three whose width wins, three height, three depth. Balanced by      *
 * construction and checked by `truthOf`.                              *
 * ------------------------------------------------------------------ */

const slab = (
    id: string,
    x: readonly [number, number],
    y: readonly [number, number],
    z: number
): Stimulus => ({
    id,
    asks: ['longest'],
    build: (put, n) => boxAt(put, n, x[0], y[0], 0, x[1], y[1], z)
})

const AXES: readonly Stimulus[] = [
    slab('wide-1', [0.05, 0.95], [0.4, 0.6], 0.3),
    slab('wide-2', [0.02, 0.98], [0.3, 0.7], 0.55),
    slab('wide-3', [0.1, 0.9], [0.45, 0.55], 0.15),
    slab('tall-1', [0.42, 0.58], [0.42, 0.58], 0.95),
    slab('tall-2', [0.3, 0.7], [0.35, 0.65], 0.9),
    slab('tall-3', [0.4, 0.6], [0.2, 0.5], 0.85),
    slab('deep-1', [0.4, 0.6], [0.05, 0.95], 0.3),
    slab('deep-2', [0.3, 0.7], [0.02, 0.98], 0.55),
    slab('deep-3', [0.45, 0.55], [0.1, 0.9], 0.15)
]

/* ------------------------------------------------------------------ *
 * Family 3 — twelve compounds for "how many pieces" and "is anything  *
 * floating". Three each of 1, 2, 3 and 4 pieces; six with a piece in  *
 * the air and six without. One family answers both questions, so the  *
 * balance holds for each of them separately.                          *
 * ------------------------------------------------------------------ */

const compound = (id: string, build: Build): Stimulus => ({id, asks: ['parts', 'floating'], build})

const PIECES: readonly Stimulus[] = [
    compound('one-block', (put, n) => boxAt(put, n, 0.3, 0.3, 0, 0.7, 0.7, 0.5)),
    compound('one-ball', (put, n) => ballAt(put, n, 0.5, 0.5, 0.35, 0.35)),
    compound('one-capped', (put, n) => {
        boxAt(put, n, 0.42, 0.42, 0, 0.58, 0.58, 0.55)
        ballAt(put, n, 0.5, 0.5, 0.72, 0.22)
    }),
    compound('two-floor', (put, n) => {
        boxAt(put, n, 0.05, 0.35, 0, 0.35, 0.65, 0.5)
        boxAt(put, n, 0.65, 0.35, 0, 0.95, 0.65, 0.5)
    }),
    compound('two-air', (put, n) => {
        boxAt(put, n, 0.3, 0.3, 0, 0.7, 0.7, 0.3)
        boxAt(put, n, 0.3, 0.3, 0.6, 0.7, 0.7, 0.9)
    }),
    compound('two-air-side', (put, n) => {
        boxAt(put, n, 0.05, 0.35, 0, 0.4, 0.65, 0.6)
        ballAt(put, n, 0.75, 0.5, 0.7, 0.2)
    }),
    compound('three-floor', (put, n) => {
        boxAt(put, n, 0.05, 0.4, 0, 0.25, 0.6, 0.7)
        boxAt(put, n, 0.4, 0.4, 0, 0.6, 0.6, 0.45)
        boxAt(put, n, 0.75, 0.4, 0, 0.95, 0.6, 0.6)
    }),
    compound('three-one-air', (put, n) => {
        boxAt(put, n, 0.05, 0.4, 0, 0.3, 0.6, 0.4)
        boxAt(put, n, 0.7, 0.4, 0, 0.95, 0.6, 0.4)
        boxAt(put, n, 0.35, 0.4, 0.65, 0.65, 0.6, 0.9)
    }),
    compound('three-two-air', (put, n) => {
        boxAt(put, n, 0.35, 0.35, 0, 0.65, 0.65, 0.25)
        ballAt(put, n, 0.2, 0.5, 0.65, 0.16)
        ballAt(put, n, 0.8, 0.5, 0.65, 0.16)
    }),
    compound('four-floor', (put, n) => {
        boxAt(put, n, 0.05, 0.05, 0, 0.3, 0.3, 0.5)
        boxAt(put, n, 0.7, 0.05, 0, 0.95, 0.3, 0.5)
        boxAt(put, n, 0.05, 0.7, 0, 0.3, 0.95, 0.5)
        boxAt(put, n, 0.7, 0.7, 0, 0.95, 0.95, 0.5)
    }),
    compound('four-one-air', (put, n) => {
        boxAt(put, n, 0.05, 0.4, 0, 0.25, 0.6, 0.4)
        boxAt(put, n, 0.4, 0.4, 0, 0.6, 0.6, 0.4)
        boxAt(put, n, 0.75, 0.4, 0, 0.95, 0.6, 0.4)
        boxAt(put, n, 0.4, 0.4, 0.65, 0.6, 0.6, 0.85)
    }),
    compound('four-two-air', (put, n) => {
        boxAt(put, n, 0.05, 0.4, 0, 0.3, 0.6, 0.35)
        boxAt(put, n, 0.7, 0.4, 0, 0.95, 0.6, 0.35)
        boxAt(put, n, 0.05, 0.4, 0.6, 0.3, 0.6, 0.9)
        boxAt(put, n, 0.7, 0.4, 0.6, 0.95, 0.6, 0.9)
    })
]

/* ------------------------------------------------------------------ *
 * Family 4 — eight marked shapes, two per side. This is the tank      *
 * failure as a question with a right answer: the model has to say     *
 * which way a feature faces.                                          *
 * ------------------------------------------------------------------ */

type Face = 'front' | 'back' | 'left' | 'right'

const marked = (id: string, face: Face, tall: boolean): Stimulus => ({
    id,
    asks: ['mark'],
    build: (put, n) => {
        const lo = at(0.25, n)
        const hi = at(0.75, n)
        const top = at(tall ? 0.85 : 0.5, n)
        boxFill(put, lo, lo, 0, hi, hi, top)
        const a = at(0.38, n)
        const b = at(0.62, n)
        const z0 = at(0.2, n)
        const z1 = at(0.4, n)
        for (let z = z0; z <= z1; z += 1) {
            for (let t = a; t <= b; t += 1) {
                if (face === 'front') put(t, hi, z, true)
                else if (face === 'back') put(t, lo, z, true)
                else if (face === 'right') put(hi, t, z, true)
                else put(lo, t, z, true)
            }
        }
    }
})

const MARKS: readonly Stimulus[] = [
    marked('mark-front-a', 'front', false),
    marked('mark-front-b', 'front', true),
    marked('mark-back-a', 'back', false),
    marked('mark-back-b', 'back', true),
    marked('mark-left-a', 'left', false),
    marked('mark-left-b', 'left', true),
    marked('mark-right-a', 'right', false),
    marked('mark-right-b', 'right', true)
]

export const CORPUS: readonly Stimulus[] = [...PRIMITIVES, ...AXES, ...PIECES, ...MARKS]

export const build = (stimulus: Stimulus, n: number): Volume => {
    const volume = createVolume(n, n, n, palette())
    stimulus.build((x, y, z, mark) => {
        if (x < 0 || y < 0 || z < 0 || x >= n || y >= n || z >= n) return
        setVoxel(volume, x, y, z, mark === true ? MARK_INDEX : BASE_INDEX)
    }, n)
    return volume
}

/** 6-connected components of everything filled. Returns one label grid and the component count. */
const components = (volume: Volume): {labels: Int32Array; count: number} => {
    const {sx, sy, sz, data} = volume
    const labels = new Int32Array(sx * sy * sz).fill(-1)
    const stack: number[] = []
    let count = 0
    const index = (x: number, y: number, z: number): number => (z * sy + y) * sx + x
    const steps: readonly (readonly [number, number, number])[] = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1]
    ]
    for (let z = 0; z < sz; z += 1) {
        for (let y = 0; y < sy; y += 1) {
            for (let x = 0; x < sx; x += 1) {
                const start = index(x, y, z)
                if ((data[start] ?? 0) === 0 || labels[start] !== -1) continue
                labels[start] = count
                stack.push(x, y, z)
                while (stack.length > 0) {
                    const cz = stack.pop() ?? 0
                    const cy = stack.pop() ?? 0
                    const cx = stack.pop() ?? 0
                    for (const [dx, dy, dz] of steps) {
                        const nx = cx + dx
                        const ny = cy + dy
                        const nz = cz + dz
                        if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue
                        const to = index(nx, ny, nz)
                        if ((data[to] ?? 0) === 0 || labels[to] !== -1) continue
                        labels[to] = count
                        stack.push(nx, ny, nz)
                    }
                }
                count += 1
            }
        }
    }
    return {labels, count}
}

export type Axis = 'width' | 'height' | 'depth'
export type Side = 'front' | 'back' | 'left' | 'right'

export interface Truth {
    readonly id: string
    readonly asks: readonly QuestionId[]
    readonly name: string | undefined
    readonly voxels: number
    readonly parts: number
    readonly floating: boolean
    /** `undefined` when two extents tie — an honest "this shape does not answer that question". */
    readonly longest: Axis | undefined
    readonly extents: readonly [number, number, number]
    readonly mark: Side | undefined
}

/** Everything the questions are scored against, read off the grid. */
export const truthOf = (stimulus: Stimulus, volume: Volume): Truth => {
    const {sx, sy, sz, data} = volume
    const bounds = filledBounds(volume)
    const {labels, count} = components(volume)

    let voxels = 0
    for (const value of data) if (value !== 0) voxels += 1

    // A component is "on the floor" if any of its cells sits at z = 0.
    const grounded = new Set<number>()
    for (let y = 0; y < sy; y += 1) {
        for (let x = 0; x < sx; x += 1) {
            const label = labels[y * sx + x] ?? -1
            if (label >= 0) grounded.add(label)
        }
    }

    const extents: [number, number, number] =
        bounds ?
            [
                bounds.max[0] - bounds.min[0] + 1,
                bounds.max[1] - bounds.min[1] + 1,
                bounds.max[2] - bounds.min[2] + 1
            ]
        :   [0, 0, 0]
    const [ex, ey, ez] = extents
    const best = Math.max(ex, ey, ez)
    const ties = [ex, ey, ez].filter(value => value === best).length
    const longest: Axis | undefined =
        ties > 1 ? undefined
        : best === ex ? 'width'
        : best === ez ? 'height'
        : 'depth'

    // Where the mark sits, relative to the model's own centre. Computed, never declared.
    let markCount = 0
    let mx = 0
    let my = 0
    for (let z = 0; z < sz; z += 1) {
        for (let y = 0; y < sy; y += 1) {
            for (let x = 0; x < sx; x += 1) {
                if (voxelAt(volume, x, y, z) !== MARK_INDEX) continue
                markCount += 1
                mx += x
                my += y
            }
        }
    }
    let mark: Side | undefined
    if (markCount > 0 && bounds) {
        const cx = (bounds.min[0] + bounds.max[0]) / 2
        const cy = (bounds.min[1] + bounds.max[1]) / 2
        const dx = mx / markCount - cx
        const dy = my / markCount - cy
        mark =
            Math.abs(dx) >= Math.abs(dy) ?
                dx >= 0 ?
                    'right'
                :   'left'
            : dy >= 0 ? 'front'
            : 'back'
    }

    return {
        id: stimulus.id,
        asks: stimulus.asks,
        name: stimulus.name,
        voxels,
        parts: count,
        floating: count > grounded.size,
        longest,
        extents,
        mark
    }
}

/** The closed list the naming question picks from — every named shape, and nothing else. */
export const NAMES: readonly string[] = CORPUS.flatMap(s => (s.name === undefined ? [] : [s.name]))
