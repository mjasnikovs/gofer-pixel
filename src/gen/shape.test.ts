import {expect, test} from 'bun:test'
import {voxelAt, voxelIndex, type Volume} from '../render/volume'
import {countFilled, rasterise, readSpec, type VoxOp, type VoxSpec} from './ops'
import {bboxFill, connectivity} from './score'
import {
    MAX_HALF,
    MAX_ROW,
    readRibs,
    silhouette,
    silhouetteScope,
    SILHOUETTE_EXAMPLES,
    type Rib
} from './shape'

const GREY = '#8a8a86'

const gridOf = (ops: readonly VoxOp[]): Volume => {
    const spec: VoxSpec = {name: 'hull', size: [32, 32, 32], mirror_x: false, ops}
    return rasterise(spec)
}

/**
 * The width of one layer of the grid, in voxels, measured by walking it.
 *
 * A row of the outline is a layer of the `Volume`: ops are y-up and the rasteriser swaps, so the
 * op language's row `y` is the grid's `z`. Nothing about the outline is asserted through the
 * numbers that produced it — the claim is about the voxels.
 */
const layerWidth = (volume: Volume, z: number): number => {
    let lo = -1
    let hi = -1
    for (let x = 0; x < volume.sx; x += 1) {
        for (let y = 0; y < volume.sy; y += 1) {
            if ((volume.data[voxelIndex(volume, x, y, z)] ?? 0) === 0) continue
            if (lo < 0) lo = x
            hi = x
            break
        }
    }
    return lo < 0 ? 0 : hi - lo + 1
}

/** Filled cells in one layer — the cross-section, whichever axis the outline curved on. */
const layerFill = (volume: Volume, z: number): number => {
    let count = 0
    for (let i = z * volume.sx * volume.sy; i < (z + 1) * volume.sx * volume.sy; i += 1) {
        if ((volume.data[i] ?? 0) !== 0) count += 1
    }
    return count
}

const lowestLayer = (volume: Volume): number => {
    for (let z = 0; z < volume.sz; z += 1) {
        for (let i = z * volume.sx * volume.sy; i < (z + 1) * volume.sx * volume.sy; i += 1) {
            if ((volume.data[i] ?? 0) !== 0) return z
        }
    }
    return -1
}

/** A literal outline, typed as ribs — the tests are written in the numbers the reply would send. */
const ribs = (rows: readonly [number, number][]): readonly Rib[] => rows

test('a constant front and a constant side are one box, the size the ribs asked for', () => {
    // Half 3 across and half 2 deep, held from row 0 to row 9: six wide, four deep, ten tall.
    const ops = silhouette(
        ribs([
            [0, 3],
            [9, 3]
        ]),
        ribs([
            [0, 2],
            [9, 2]
        ]),
        GREY
    )

    // One op, not ten slices of one: identical rows are merged, so the cheap case stays cheap.
    expect(ops).toHaveLength(1)
    const volume = gridOf(ops)
    expect([volume.sx, volume.sy, volume.sz]).toEqual([6, 4, 10])
    expect(countFilled(volume)).toBe(6 * 4 * 10)
})

test('nothing downstream learns a new word: every op is a box', () => {
    const ops = silhouette(
        ribs([
            [0, 4],
            [7, 1]
        ]),
        ribs([
            [0, 3],
            [7, 3]
        ]),
        '#c0392b'
    )

    expect(ops.length).toBeGreaterThan(1)
    for (const op of ops) expect(op.op).toBe('box')
    expect(ops.every(op => op.op === 'box' && op.color === '#c0392b')).toBe(true)
})

test('four numbers describe twenty-four rows of curve', () => {
    // The whole reason this beats `box`: two ribs per outline, and the rows between them are
    // interpolated. Half 6 at the floor to half 1 at row 23, so the width really is per row.
    const volume = gridOf(
        silhouette(
            ribs([
                [0, 6],
                [23, 1]
            ]),
            ribs([
                [0, 2],
                [23, 2]
            ]),
            GREY
        )
    )

    expect(volume.sz).toBe(24)
    expect(layerWidth(volume, 0)).toBe(12)
    expect(layerWidth(volume, 23)).toBe(2)

    const widths: number[] = []
    for (let z = 0; z < volume.sz; z += 1) widths.push(layerWidth(volume, z))
    // Monotone, and it really steps — a taper that came out as two blocks would pass a first and
    // last check and be a box with a lid.
    for (let z = 1; z < widths.length; z += 1) {
        expect(widths[z] ?? 0).toBeLessThanOrEqual(widths[z - 1] ?? 0)
    }
    expect(new Set(widths).size).toBeGreaterThanOrEqual(6)
})

test('the model stands on the floor', () => {
    const volume = gridOf(
        silhouette(
            ribs([
                [0, 3],
                [11, 1]
            ]),
            ribs([
                [0, 3],
                [11, 2]
            ]),
            GREY
        )
    )

    expect(lowestLayer(volume)).toBe(0)
})

test('a hull is one 6-connected piece and is not a solid brick', () => {
    // The claim that matters. A silhouette that comes out at bboxFill 1.0 has bought nothing over a
    // `box`, and one that comes apart has bought less than nothing.
    const volume = gridOf(
        silhouette(
            ribs([
                [0, 1],
                [4, 4],
                [15, 1]
            ]),
            ribs([
                [0, 2],
                [6, 5],
                [15, 1]
            ]),
            GREY
        )
    )

    expect(connectivity(volume)).toBe(1)
    expect(bboxFill(volume)).toBeLessThan(0.75)
    expect(bboxFill(volume)).toBeGreaterThan(0)
})

test('a single rib is a constant extent, and the outlines need not be the same height', () => {
    // Flat below the first rib and above the last, in both directions: a rib is a statement about a
    // row, and silence is not a statement about a shape.
    const volume = gridOf(
        silhouette(
            ribs([[4, 3]]),
            ribs([
                [0, 2],
                [9, 2]
            ]),
            GREY
        )
    )

    expect([volume.sx, volume.sy, volume.sz]).toEqual([6, 4, 10])
    expect(countFilled(volume)).toBe(6 * 4 * 10)
})

test('a rib under the floor steers the outline and paints no voxels', () => {
    // The taper from half 5 at row -4 to half 1 at row 4 is nine rows of curve, of which five are
    // above the ground. Dropping the control point would have flattened those five.
    const volume = gridOf(
        silhouette(
            ribs([
                [-4, 5],
                [4, 1]
            ]),
            ribs([
                [0, 2],
                [4, 2]
            ]),
            GREY
        )
    )

    expect(volume.sz).toBe(5)
    expect(lowestLayer(volume)).toBe(0)
    // Half 5 at -4 and half 1 at 4 is half 3 at row 0, so the floor is six across, not ten.
    expect(layerWidth(volume, 0)).toBe(6)
    expect(layerWidth(volume, 4)).toBe(2)
})

test('half may be fractional, and the rounding happens once', () => {
    // Rounding each rib before the interpolation would have given 3, 3, 5 — a step. The arithmetic
    // stays real: 1.5, 2.0, 2.5, rounded once at the end. The middle row wants 4 and comes out 5,
    // which is the parity lock and a tie going to the wider row.
    const volume = gridOf(
        silhouette(
            ribs([
                [0, 1.5],
                [2, 2.5]
            ]),
            ribs([
                [0, 1.5],
                [2, 1.5]
            ]),
            GREY
        )
    )

    expect(layerWidth(volume, 0)).toBe(3)
    expect(layerWidth(volume, 1)).toBe(5)
    expect(layerWidth(volume, 2)).toBe(5)
})

test('every row is symmetric about one axis, so a curve is a curve and not a wobble', () => {
    // Rounded per row these would be 7, 6, 5, 4 across and each odd row would sit half a voxel off
    // the even ones. Locked to the widest row's parity they are 7, 7, 5, 5 and share a centre line.
    const volume = gridOf(
        silhouette(
            ribs([
                [0, 3.5],
                [3, 2]
            ]),
            ribs([
                [0, 2],
                [3, 2]
            ]),
            GREY
        )
    )

    for (let z = 0; z < volume.sz; z += 1) {
        expect(layerWidth(volume, z) % 2).toBe(1)
        for (let x = 0; x < volume.sx; x += 1) {
            for (let y = 0; y < volume.sy; y += 1) {
                expect(voxelAt(volume, x, y, z)).toBe(voxelAt(volume, volume.sx - 1 - x, y, z))
            }
        }
    }
})

test('a row of no reach is still one voxel, because a gap would cut the model in two', () => {
    const volume = gridOf(
        silhouette(
            ribs([
                [0, 2],
                [3, 0],
                [6, 2]
            ]),
            ribs([
                [0, 2],
                [6, 2]
            ]),
            GREY
        )
    )

    expect(layerWidth(volume, 3)).toBe(2)
    expect(connectivity(volume)).toBe(1)
})

test('an empty outline paints nothing, and one outline without the other paints nothing', () => {
    expect(silhouette([], ribs([[0, 2]]), GREY)).toEqual([])
    expect(silhouette(ribs([[0, 2]]), [], GREY)).toEqual([])
    expect(silhouette([], [], GREY)).toEqual([])
})

test('ribs are read, sorted, deduplicated and bounded', () => {
    expect(
        readRibs([
            [7, 2],
            [0, 4]
        ])
    ).toEqual([
        [0, 4],
        [7, 2]
    ])
    // A row restated is the reply correcting itself, the way a later op paints over an earlier one.
    expect(
        readRibs([
            [3, 2],
            [3, 5]
        ])
    ).toEqual([[3, 5]])
    // One unreadable pair is one straight stretch, not a refused outline.
    expect(readRibs([[0, 2], 'nose', [4], [2, 'wide'], [3, 1]])).toEqual([
        [0, 2],
        [3, 1]
    ])
    expect(readRibs('an outline')).toEqual([])
    expect(readRibs([])).toEqual([])
    // Out of range is dropped; a half past the biggest canvas is clamped to it.
    expect(
        readRibs([
            [MAX_ROW + 1, 2],
            [Number.NaN, 2],
            [2, Number.POSITIVE_INFINITY],
            [4, 900],
            [5, -3],
            [6.7, 1]
        ])
    ).toEqual([
        [4, MAX_HALF],
        [5, 0],
        [6, 1]
    ])
})

/*
 * The scope — the two functions the reply gets once the flag puts them there. Ordering is the whole
 * of what it decides, and ordering is the one thing a pure `silhouette(front, side, colour)` cannot
 * say by itself.
 */

const scoped = (draw: (shape: ReturnType<typeof silhouetteScope>, ops: unknown[]) => void) => {
    const ops: unknown[] = []
    const shape = silhouetteScope(op => ops.push(op))
    draw(shape, ops)
    return ops
}

test('a pair paints when it completes, so detail written after it paints over it', () => {
    const ops = scoped((shape, out) => {
        shape.front(
            [
                [0, 2],
                [5, 2]
            ],
            '#c0392b'
        )
        shape.side([
            [0, 2],
            [5, 2]
        ])
        out.push({op: 'box', from: [0, 5, 0], to: [0, 5, 0], color: '#ffffff'})
    })

    expect(ops).toHaveLength(2)
    const volume = gridOf(readSpec({name: 'x', size: [8, 8, 8], mirror_x: false, ops})?.ops ?? [])
    // The detail is the second palette entry, so it landed on top of the hull rather than under it.
    expect(voxelAt(volume, 2, 2, 5)).toBe(2)
})

test('a second pair is a second part, concentric with the first', () => {
    const ops = scoped(shape => {
        shape.front(
            [
                [0, 1],
                [3, 1]
            ],
            '#efe6d2'
        )
        shape.side([
            [0, 1],
            [3, 1]
        ])
        shape.front(
            [
                [4, 3],
                [6, 1]
            ],
            '#c0392b'
        )
        shape.side([
            [4, 3],
            [6, 1]
        ])
    })

    const volume = gridOf(readSpec({name: 'x', size: [8, 8, 8], mirror_x: false, ops})?.ops ?? [])
    expect(volume.sz).toBe(7)
    expect(connectivity(volume)).toBe(1)
    // Both parts are centred on the same axis: the narrow one is centred inside the wide one, not
    // laid against its edge.
    expect(layerWidth(volume, 0)).toBe(2)
    expect(layerWidth(volume, 4)).toBe(6)
    for (let z = 0; z < volume.sz; z += 1) {
        for (let x = 0; x < volume.sx; x += 1) {
            for (let y = 0; y < volume.sy; y += 1) {
                expect(voxelAt(volume, x, y, z)).toBe(voxelAt(volume, volume.sx - 1 - x, y, z))
            }
        }
    }
})

test('one outline on its own paints nothing, and an unreadable one leaves its partner waiting', () => {
    expect(
        scoped(shape => {
            shape.front([[0, 2]])
        })
    ).toEqual([])
    expect(
        scoped(shape => {
            shape.side([
                [0, 2],
                [4, 2]
            ])
            shape.front('an outline')
            shape.front([
                [0, 2],
                [4, 2]
            ])
        })
    ).toHaveLength(1)
})

test('a colour that is not a colour falls back rather than dropping the hull', () => {
    // `readSpec` throws away a box with a bad colour, and the hull is the whole model.
    const ops = scoped(shape => {
        shape.front([[0, 2]], 'red')
        shape.side([[0, 2]])
    })

    expect(readSpec({name: 'x', size: [8, 8, 8], mirror_x: false, ops})?.ops).toHaveLength(1)
})

/*
 * The worked examples, held to the floor `bank.test.ts` holds the built-in replies to. `front` and
 * `side` are a language the model has never seen, and finding 7 says the example is what teaches it
 * — so a broken example here teaches breakage in a format nobody can check by eye yet.
 */

/** The example run the way the reply will be: `box` and the two outlines, and nothing else. */
const runExample = (source: string): VoxSpec | undefined => {
    const ops: unknown[] = []
    const shape = silhouetteScope(op => ops.push(op))
    const box = (...args: unknown[]): void => {
        const [x0, y0, z0, x1, y1, z1, color] = args
        ops.push({op: 'box', from: [x0, y0, z0], to: [x1, y1, z1], color})
    }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const program = new Function('box', 'front', 'side', source) as (...fns: unknown[]) => void
    program(box, shape.front, shape.side)
    return readSpec({name: 'example', size: [32, 32, 32], mirror_x: false, ops})
}

test('every worked example is a model, not a story about one', () => {
    for (const [id, source] of Object.entries(SILHOUETTE_EXAMPLES)) {
        const spec = runExample(source ?? '')
        if (!spec) throw new Error(`the ${id} example paints nothing`)

        const volume = rasterise(spec)
        expect(connectivity(volume)).toBe(1)
        expect(bboxFill(volume)).toBeLessThan(0.75)
        expect(volume.sz).toBeGreaterThan(8)
        // The outlines did the work: the body is hulls, and the detail is a handful of boxes.
        expect(spec.ops.length).toBeLessThan(16)
        for (const op of spec.ops) expect(op.op).toBe('box')
    }
})

test('the examples are outlines, not boxes with an outline call in front of them', () => {
    for (const source of Object.values(SILHOUETTE_EXAMPLES)) {
        expect(source ?? '').toContain('front([[')
        expect(source ?? '').toContain('side([[')
        // A curve is what this is for, so the cross-section has to change with the row — measured as
        // area rather than as width, because the fish's curve is in its depth and not across it.
        const spec = runExample(source ?? '')
        const volume = spec ? rasterise(spec) : undefined
        if (!volume) throw new Error('an example that does not rasterise teaches nothing')
        const areas = new Set<number>()
        for (let z = 0; z < volume.sz; z += 1) areas.add(layerFill(volume, z))
        expect(areas.size).toBeGreaterThanOrEqual(4)
    }
})
