import {createVolume, type Volume} from '../render/volume'

/**
 * The generated volume, fixed in code. `docs/GEN_IDEAS.md` §1.
 *
 * `score.ts` measures disconnected parts, floating hats, unused height — and then only sorts by
 * them, so a batch of six shows the artist two piles of debris ranked fourth and fifth. The
 * diagnosis in `GEN_IDEAS.md` is that the model cannot express a fix in the representation it was
 * handed: it is on absolute integer coordinates in 3D, twelve numbers a limb, and the outside
 * literature calls that "a fundamental gap in geometric reasoning". So the geometry is repaired
 * here, on the grid, with no model call.
 *
 * **This is not the dead revision loop.** Nothing is fed back to anything. It is arithmetic on a
 * `Uint8Array`, so a `.gpix` record still reproduces its asset exactly, which is the property
 * `rasterise → finish` was built to keep.
 *
 * Two constraints hold every rule down, and they are the reason each is separately exported and
 * separately tested:
 *
 * 1. **A repair that fires on a good model is worse than a failure that is honest.** Every
 *    threshold below was picked against the five worked examples in `builtin.ts`, and
 *    `repair.test.ts` asserts the whole pass is the identity on all five. A rule that fires on the
 *    dog is a bug in the rule.
 * 2. **Nothing invents.** Sizes never change, so the document is not resized under its owner;
 *    colours are never mixed or chosen, only copied off a neighbour that already carried them.
 */
export interface RepairReport {
    /** Voxels removed as debris. */
    readonly dropped: number
    /** Voxels added to close gaps. */
    readonly bridged: number
    /** Layers the model was moved down by. */
    readonly lifted: number
    /** Voxels added to thin columns. */
    readonly thickened: number
    /** Whether the near-symmetric half was reflected. */
    readonly mirrored: boolean
}

/**
 * A component smaller than this fraction of the largest one is debris.
 *
 * A tenth. The detail an artist paints separately — an eye, a nose, a comb — is 1 to 6 voxels
 * against a body of hundreds, so *every* meaningful part is under a tenth and the number does not
 * separate "small" from "worthless". What it separates is small from **structural**: a head or a
 * mushroom cap that came off whole is a third of the model or more, and it survives. That is
 * deliberate. Deleting a detached head leaves the artist a decapitated model, which is a worse
 * picture than a floating one and hides the failure instead of showing it; deleting a stray cube
 * two cells off the shoulder loses nothing, because a detail that far from the surface it belongs
 * to was never the detail.
 *
 * `bridgeGaps` runs first precisely so that the details this would delete are reattached instead.
 */
export const DEBRIS_FRACTION = 0.1

/**
 * How tall a 1×1 column has to be before it is widened.
 *
 * Four, and **the bank does not choose this number — measured, it only fails to object.** None of
 * the five worked examples contains a free-standing 1×1 column of any length at all, so no
 * threshold down to 1 would fire on them. What the bank does say is how close the miss is: the
 * chicken's beak, `box(4,11,9, 4,12,9)`, *is* a 1×1 protrusion two voxels long, and it survives
 * this rule on the lateral test — it is welded to the head across `y` — rather than on its length.
 * A rule whose safety on a worked example rests on one neighbour needs a generous run length, not a
 * tight one.
 *
 * So the number comes from what the size means. Two or three voxels of free-standing 1×1 on a 32³
 * model is every antenna, whisker, horn and tail-tip anybody draws on purpose. At four and above it
 * is a limb the model failed to give width to, and it exports as a hairline: one voxel wide is
 * under a pixel at any zoom that is not pixel-perfect (`render/perfect.ts`).
 */
export const SPINDLE_RUN = 4

/**
 * The band of x-agreement inside which the better half is reflected.
 *
 * **Both ends are load-bearing and the upper one is the surprising half.**
 *
 * Below `SYMMETRY_LOW` the model is not nearly symmetric, and "make it symmetric" stops being a
 * repair: a fish seen side-on, a plant, a tower with a door on one face are legitimately asymmetric
 * subjects, and reflecting a half of one invents a model the generator did not produce.
 *
 * Above `SYMMETRY_HIGH` the only asymmetry left **is** deliberate detail, and that end is measured
 * against the bank rather than argued: the tower's third window, `box(0,13,4, 0,15,5)`, is six
 * voxels standing off a face whose opposite deliberately has none — exactly 6 unmatched of 1448,
 * which is **0.9959**. Symmetrising it puts a window on a fourth face the example chose not to
 * have. Every deliberate one-sided detail lands in that same last percent, so the rule stops before
 * it; the other four examples are at 1.0000 and are not what fixes this end of the band.
 *
 * What is left in between is the defect the rule is for: a limb short on one side, three legs where
 * there should be four, an arm the model only remembered once. Those are 2 % to 20 % of the voxels.
 */
export const SYMMETRY_LOW = 0.8
export const SYMMETRY_HIGH = 0.98

/** One label per cell and the size of each, over the same face neighbours `score.ts` counts. */
export interface Components {
    /** Label per cell, `-1` where the cell is empty. */
    readonly labels: Int32Array
    /** Voxels in each label, indexed by label. */
    readonly sizes: readonly number[]
    /** The largest label, or `-1` for an empty grid. A tie goes to the one found first. */
    readonly largest: number
}

/** The six face neighbours of a cell, in the order `score.ts` walks them. */
const around = (x: number, y: number, z: number): readonly [number, number, number][] => [
    [x + 1, y, z],
    [x - 1, y, z],
    [x, y + 1, z],
    [x, y - 1, z],
    [x, y, z + 1],
    [x, y, z - 1]
]

/**
 * 6-connected components, re-derived rather than imported.
 *
 * `connectivity` in `score.ts` has the same walk inside it and returns one number, so there is
 * nothing to import; what there is to share is the *definition*, and it is the same one: face
 * neighbours only, matching `doc/selection.ts`. Two lumps touching at a corner are two lumps here
 * too — which is what makes a corner touch something `bridgeGaps` can fix rather than something the
 * flood fill quietly forgives.
 */
export const components = (volume: Volume): Components => {
    const {sx, sy, sz, data} = volume
    const labels = new Int32Array(data.length).fill(-1)
    const sizes: number[] = []
    const stack: number[] = []
    let largest = -1
    for (let start = 0; start < data.length; start += 1) {
        if ((data[start] ?? 0) === 0 || labels[start] !== -1) continue
        const label = sizes.length
        labels[start] = label
        stack.push(start)
        let size = 0
        while (stack.length > 0) {
            const index = stack.pop() ?? 0
            size += 1
            const z = Math.floor(index / (sx * sy))
            const rest = index - z * sx * sy
            const x = rest % sx
            const y = Math.floor(rest / sx)
            for (const [nx, ny, nz] of around(x, y, z)) {
                if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue
                const next = (nz * sy + ny) * sx + nx
                if ((data[next] ?? 0) === 0 || labels[next] !== -1) continue
                labels[next] = label
                stack.push(next)
            }
        }
        sizes.push(size)
        if (largest < 0 || size > (sizes[largest] ?? 0)) largest = label
    }
    return {labels, sizes, largest}
}

const clone = (volume: Volume): Volume => {
    // The palette is copied rather than shared: the repaired volume is a separate document, and an
    // aliased palette would let a later recolour of one repaint the other.
    const out = createVolume(volume.sx, volume.sy, volume.sz, Uint8Array.from(volume.palette))
    out.data.set(volume.data)
    out.owner.set(volume.owner)
    out.emissive.set(volume.emissive)
    return out
}

const cellsOf = (labels: Int32Array, count: number): number[][] => {
    const cells: number[][] = []
    for (let i = 0; i < count; i += 1) cells.push([])
    for (let index = 0; index < labels.length; index += 1) {
        const label = labels[index] ?? -1
        if (label >= 0) cells[label]?.push(index)
    }
    return cells
}

/**
 * Reattach every component that is one empty cell away from the main body.
 *
 * This is the dilate-and-intersect of §1: the cells that touch both the trunk and the loose part
 * are exactly the cells that would join them, and filling them is a bridge rather than a deletion.
 * **It has to run before `dropDebris`** — a head one cell off the neck is a bridge and a hat one
 * layer over the brow is a bridge, and dropping first turns both into rubbish that was almost
 * right.
 *
 * The whole intersection is filled, not one pillar of it. A pillar connects the part and leaves it
 * looking like it is held on by a wire; the intersection is bounded by the contact footprint of two
 * parts that were meant to touch, which is the join the model was reaching for.
 *
 * A corner touch counts as a gap, because `components` counts it as two lumps — the empty cell that
 * completes the L touches both, so the same intersection finds it with no second rule.
 *
 * The added cell takes the **loose part's** colour, since it is the reach that was missing from
 * that part: a dark hat grows a dark cell rather than a stalk of skin.
 */
export const bridgeGaps = (volume: Volume): {volume: Volume; bridged: number} => {
    const {sx, sy, sz} = volume
    const {labels, sizes, largest} = components(volume)
    if (largest < 0 || sizes.length < 2) return {volume, bridged: 0}

    const cells = cellsOf(labels, sizes.length)
    const out = clone(volume)
    const data = out.data
    const joined = new Uint8Array(data.length)
    for (const index of cells[largest] ?? []) joined[index] = 1

    const pending = new Set<number>()
    for (let label = 0; label < sizes.length; label += 1) if (label !== largest) pending.add(label)

    let bridged = 0
    let progress = true
    // Passes rather than one sweep, so a chain — trunk, gap, lump, gap, lump — closes whichever
    // order the labels came out in. Each pass either joins a component or ends the loop, and there
    // are finitely many components, so this terminates without a cap.
    while (progress) {
        progress = false
        for (const label of pending) {
            const gaps = new Map<number, number>()
            // A bridge for one lump can land against a second one, which is then already attached
            // and must not be given a bridge of its own — that second cell would be a voxel added
            // to close a gap that is already closed.
            let attached = false
            for (const index of cells[label] ?? []) {
                const z = Math.floor(index / (sx * sy))
                const rest = index - z * sx * sy
                const x = rest % sx
                const y = Math.floor(rest / sx)
                for (const [nx, ny, nz] of around(x, y, z)) {
                    if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue
                    const empty = (nz * sy + ny) * sx + nx
                    if (joined[empty] === 1) attached = true
                    if ((data[empty] ?? 0) !== 0 || gaps.has(empty)) continue
                    const touches = around(nx, ny, nz).some(
                        ([tx, ty, tz]) =>
                            tx >= 0
                            && ty >= 0
                            && tz >= 0
                            && tx < sx
                            && ty < sy
                            && tz < sz
                            && joined[(tz * sy + ty) * sx + tx] === 1
                    )
                    if (touches) gaps.set(empty, index)
                }
            }
            if (attached) {
                for (const index of cells[label] ?? []) joined[index] = 1
                pending.delete(label)
                progress = true
                continue
            }
            if (gaps.size === 0) continue
            for (const [empty, from] of gaps) {
                data[empty] = data[from] ?? 0
                out.owner[empty] = out.owner[from] ?? 0
                joined[empty] = 1
                bridged += 1
            }
            for (const index of cells[label] ?? []) joined[index] = 1
            pending.delete(label)
            progress = true
        }
    }
    return bridged === 0 ? {volume, bridged: 0} : {volume: out, bridged}
}

/** Erase every component under `DEBRIS_FRACTION` of the largest. */
export const dropDebris = (volume: Volume): {volume: Volume; dropped: number} => {
    const {labels, sizes, largest} = components(volume)
    if (largest < 0 || sizes.length < 2) return {volume, dropped: 0}
    const floor = (sizes[largest] ?? 0) * DEBRIS_FRACTION

    let dropped = 0
    const doomed = new Set<number>()
    for (let label = 0; label < sizes.length; label += 1) {
        if (label === largest || (sizes[label] ?? 0) >= floor) continue
        doomed.add(label)
        dropped += sizes[label] ?? 0
    }
    if (dropped === 0) return {volume, dropped: 0}

    const out = clone(volume)
    for (let index = 0; index < labels.length; index += 1) {
        if (!doomed.has(labels[index] ?? -1)) continue
        out.data[index] = 0
        // An empty cell is always unowned — `render/volume.ts` says so about `owner`.
        out.owner[index] = 0
    }
    return {volume: out, dropped}
}

/**
 * Translate the model down until its lowest filled layer is `z = 0`.
 *
 * `Volume` is z-up and the op language is y-up (`ops.ts` does the swap), so this is the "feet on the
 * floor" the system prompt has always asked for, enforced instead of requested. `rasterise` already
 * lands a fitted grid at zero, which is why this rule earns its place *after* `dropDebris`: a stray
 * voxel on the ground is what was holding the grid down, and deleting it leaves the model hovering.
 */
export const dropToFloor = (volume: Volume): {volume: Volume; lifted: number} => {
    const {sx, sy, sz, data} = volume
    const layer = sx * sy
    let lowest = -1
    for (let z = 0; z < sz && lowest < 0; z += 1) {
        for (let i = z * layer; i < (z + 1) * layer; i += 1) {
            if ((data[i] ?? 0) !== 0) {
                lowest = z
                break
            }
        }
    }
    if (lowest <= 0) return {volume, lifted: 0}

    const out = createVolume(sx, sy, sz, Uint8Array.from(volume.palette))
    out.emissive.set(volume.emissive)
    out.data.set(data.subarray(lowest * layer), 0)
    out.owner.set(volume.owner.subarray(lowest * layer), 0)
    return {volume: out, lifted: lowest}
}

/** The x range the model occupies, or `undefined` for an empty grid. */
const xSpan = ({sx, data}: Volume): {lo: number; hi: number} | undefined => {
    let lo = sx
    let hi = -1
    for (let index = 0; index < data.length; index += 1) {
        if ((data[index] ?? 0) === 0) continue
        const x = index % sx
        if (x < lo) lo = x
        if (x > hi) hi = x
    }
    return hi < lo ? undefined : {lo, hi}
}

/**
 * Widen any 1×1 column that runs `SPINDLE_RUN` voxels or more.
 *
 * A cell is part of a spindle when all four of its lateral neighbours are empty; off the grid counts
 * as empty, because a leg against the wall of the canvas is just as thin as one in the middle. The
 * runs are found against the **input** and written into the copy, so the answer does not depend on
 * which column was widened first.
 *
 * One neighbouring column rather than all four, and one direction for the whole run: a run widened
 * per layer is a staircase, and one axis is the smallest change that removes the single-voxel line
 * — widening both axes turns a four-tall pin into a sixteen-voxel post and moves the silhouette
 * from the front as well as the side, which is a redesign and not a repair.
 *
 * **The direction is outward, away from the model's own x centre line, and that is not a taste
 * call.** A fixed `+x` preference was the first version and it breaks mirrors: two 1×1 legs at
 * `x = 2` and `x = 5` under a body spanning `2…5` both grow right, the model's x bounds become
 * `2…6`, the mirror plane moves half a cell, and `xAgreement` on a model that was a perfect 1.0000
 * lands on exactly 0.80 — inside `symmetrise`'s band, so the next rule in the pass reflects a body
 * it had no business touching. Outward, that same pair becomes `1…2` and `5…6`, the plane does not
 * move, and the model is still exactly symmetric. Inward was the other candidate and it is worse
 * still: two legs three cells apart close up into a slab and the model loses its stance.
 *
 * A column standing *on* the centre line has no outward, so it takes both sides and comes out three
 * wide and still centred. That is the one place this rule spends twice the voxels, and it spends
 * them rather than move the plane.
 */
export const thickenSpindles = (volume: Volume): {volume: Volume; thickened: number} => {
    const {sx, sy, sz, data} = volume
    const at = (x: number, y: number, z: number): number => {
        if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return 0
        return data[(z * sy + y) * sx + x] ?? 0
    }
    const pin = (x: number, y: number, z: number): boolean =>
        at(x, y, z) !== 0
        && at(x + 1, y, z) === 0
        && at(x - 1, y, z) === 0
        && at(x, y + 1, z) === 0
        && at(x, y - 1, z) === 0

    const runs: {x: number; y: number; z0: number; z1: number}[] = []
    for (let y = 0; y < sy; y += 1) {
        for (let x = 0; x < sx; x += 1) {
            let z = 0
            while (z < sz) {
                if (!pin(x, y, z)) {
                    z += 1
                    continue
                }
                let end = z
                while (end + 1 < sz && pin(x, y, end + 1)) end += 1
                if (end - z + 1 >= SPINDLE_RUN) runs.push({x, y, z0: z, z1: end})
                z = end + 1
            }
        }
    }
    const span = xSpan(volume)
    if (runs.length === 0 || !span) return {volume, thickened: 0}
    const sum = span.lo + span.hi

    const out = clone(volume)
    let thickened = 0
    for (const {x, y, z0, z1} of runs) {
        const outward =
            x * 2 < sum ? -1
            : x * 2 > sum ? 1
            : 0
        // In preference order, and the first whose every cell is on the grid wins. `-y` is last
        // because depth is the axis a sprite sheet shows least of.
        const choices: readonly (readonly (readonly [number, number])[])[] =
            outward === 0 ?
                [
                    [
                        [1, 0],
                        [-1, 0]
                    ],
                    [[1, 0]],
                    [[-1, 0]],
                    [[0, 1]],
                    [[0, -1]]
                ]
            :   [[[outward, 0]], [[-outward, 0]], [[0, 1]], [[0, -1]]]
        const steps = choices.find(set =>
            set.every(([dx, dy]) => x + dx >= 0 && x + dx < sx && y + dy >= 0 && y + dy < sy)
        )
        if (!steps) continue
        for (const [dx, dy] of steps) {
            for (let z = z0; z <= z1; z += 1) {
                const target = (z * sy + (y + dy)) * sx + (x + dx)
                if ((out.data[target] ?? 0) !== 0) continue
                const source = (z * sy + y) * sx + x
                out.data[target] = data[source] ?? 0
                out.owner[target] = volume.owner[source] ?? 0
                thickened += 1
            }
        }
    }
    return thickened === 0 ? {volume, thickened: 0} : {volume: out, thickened}
}

/**
 * How much of the model has its x-mirror filled, `0 … 1`. An empty grid agrees with itself.
 *
 * **The plane is the model's own bounding box, never the grid's centre.** With the canvas switch on,
 * `gridFor` centres the content with a `Math.floor`, so a perfectly symmetric model in a grid one
 * cell wider than it needs sits half a cell off centre — and measured about the grid, that model
 * reads as almost completely asymmetric.
 *
 * Occupancy only. A blue left eye and a brown right one is a colour asymmetry, not a broken shape,
 * and a rule that reflects geometry has no business voting on it.
 */
export const xAgreement = (volume: Volume): number => {
    const {sx, sy, sz, data} = volume
    const span = xSpan(volume)
    if (!span) return 1
    const {lo: x0, hi: x1} = span
    let total = 0
    for (const value of data) if (value !== 0) total += 1

    const sum = x0 + x1
    let matched = 0
    for (let z = 0; z < sz; z += 1) {
        for (let y = 0; y < sy; y += 1) {
            for (let x = x0; x <= x1; x += 1) {
                if ((data[(z * sy + y) * sx + x] ?? 0) === 0) continue
                if ((data[(z * sy + y) * sx + (sum - x)] ?? 0) !== 0) matched += 1
            }
        }
    }
    return matched / total
}

/**
 * Reflect the better half in x when the model is nearly symmetric — see `SYMMETRY_LOW/HIGH`.
 *
 * The better half is the one carrying more voxels, because the defect this repairs is a part the
 * model forgot on one side rather than a part it added. A tie keeps the low-x half, which is a
 * coin-flip made once so the pass stays deterministic.
 *
 * **The middle column of an odd-width model is left exactly as it is.** Its mirror is itself, so it
 * belongs to both halves and reflecting it is the identity — which is also the only honest answer:
 * the plane passes through those voxels, and a rule that "corrected" them would be inventing a
 * seam. Where the width is even there is no fixed column and every cell has a partner across the
 * plane.
 */
export const symmetrise = (volume: Volume): {volume: Volume; mirrored: boolean} => {
    const agreement = xAgreement(volume)
    if (agreement < SYMMETRY_LOW || agreement >= SYMMETRY_HIGH) return {volume, mirrored: false}

    const {sx, sy, sz, data} = volume
    const span = xSpan(volume)
    if (!span) return {volume, mirrored: false}
    const {lo: x0, hi: x1} = span
    const sum = x0 + x1

    let low = 0
    let high = 0
    for (let index = 0; index < data.length; index += 1) {
        if ((data[index] ?? 0) === 0) continue
        const doubled = (index % sx) * 2
        if (doubled < sum) low += 1
        else if (doubled > sum) high += 1
    }
    const keepLow = low >= high

    const out = clone(volume)
    for (let z = 0; z < sz; z += 1) {
        for (let y = 0; y < sy; y += 1) {
            for (let x = x0; x <= x1; x += 1) {
                // The cells written are the discarded half's; the middle column, where `doubled`
                // equals `sum`, is skipped by both branches because it is its own mirror.
                const doubled = x * 2
                if (keepLow ? doubled <= sum : doubled >= sum) continue
                const source = (z * sy + y) * sx + (sum - x)
                const target = (z * sy + y) * sx + x
                out.data[target] = data[source] ?? 0
                out.owner[target] = volume.owner[source] ?? 0
            }
        }
    }
    return {volume: out, mirrored: true}
}

/**
 * Every rule, in the one order they compose in, and the record of what fired.
 *
 * The order is not a preference:
 *
 * - **bridge before debris**, or the head that was one cell short becomes rubbish.
 * - **thicken before symmetrise.** Widening is decided against the model's own centre line, so it
 *   cannot move the mirror plane and cannot turn a symmetric model into a candidate for reflection;
 *   running it afterwards would fix the same spindle twice, once on each side of the plane, for the
 *   same picture.
 * - **the floor last**, because both `dropDebris` and `symmetrise` can take away the lowest voxel
 *   there was — the stray cube on the ground, or a foot that only the discarded half had.
 *
 * The input object comes back when every rule was the identity, so a caller can tell the pass did
 * nothing by `===` rather than by reading five zeroes.
 */
export const repair = (volume: Volume): {volume: Volume; report: RepairReport} => {
    const bridge = bridgeGaps(volume)
    const debris = dropDebris(bridge.volume)
    const thick = thickenSpindles(debris.volume)
    const mirror = symmetrise(thick.volume)
    const floor = dropToFloor(mirror.volume)
    // Each rule hands its input straight back when it changed nothing, so five identities compose
    // into one: `floor.volume` *is* `volume` exactly when the pass was a no-op.
    return {
        volume: floor.volume,
        report: {
            dropped: debris.dropped,
            bridged: bridge.bridged,
            lifted: floor.lifted,
            thickened: thick.thickened,
            mirrored: mirror.mirrored
        }
    }
}
