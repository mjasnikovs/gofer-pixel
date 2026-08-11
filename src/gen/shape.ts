import type {VoxOp} from './ops'

/**
 * Two outlines, extruded and intersected — the visual hull, as `box` ops.
 *
 * `docs/GEN_IDEAS.md` §3, and the only idea on that page that attacks **boxiness** rather than
 * coherence. A sprite artist thinks in silhouettes, not in solids, and the classical
 * shape-from-silhouette result is that two orthographic outlines, extruded and intersected, bound a
 * solid. For the subjects this project is measured on — a fish, a mushroom, a cat — that bound *is*
 * the model. So the model is asked for two outlines, and the curve comes out of the interpolation
 * rather than out of the model's arithmetic.
 *
 * **Nothing downstream learns a new word.** An x-extent and a z-extent intersected at one height *is*
 * a box, so a 24-row silhouette is at most 24 `box` ops and the rasteriser, the `.gpix` record and
 * the reproducibility of `rasterise → finish` are all exactly as they were. This module is pure: it
 * reads numbers and returns `VoxOp[]`.
 *
 * **The format is numbers, never an ASCII grid, and that is the one design rule with outside
 * evidence behind it.** VGBench finds open-weight models are the weakest of all at low-level 2D
 * output, which is precisely what this asks for — so the ask has to be the thing a language model
 * can actually do. Spans are arithmetic; a grid is alignment, and alignment is the failure mode. Six
 * numbers describing twenty-four rows of curve is also six numbers' worth of chances to be wrong,
 * against a hundred for the grid that would draw the same shape.
 *
 * Coordinates are the op language's: **y is up, the floor is `y = 0`** (`CLAUDE.md`, finding 5 — the
 * rasteriser is the one place that swaps to the z-up `Volume`, and it is not touched here). A hull is
 * centred on the `x = 0` and `z = 0` axes, so `half` is literally the reach either side of the
 * model's own centre line and two hulls stacked on each other are concentric by construction rather
 * than by the model getting two offsets to agree. Negative coordinates are ordinary — `gridFor` fits
 * the grid to what was painted, so the low corner is wherever the painting starts.
 *
 * **The honest limitation:** two silhouettes bound a solid whose every horizontal cross-section is a
 * rectangle. The curve is in the elevation, not in the plan — a mushroom cap comes out as tapering
 * square tiers seen from above. A round plan wants a third outline or a `ball`, and `ball` is already
 * in the language, so this does not grow one.
 *
 * Nothing here has been run against the live server. It is behind the `silhouette` flag for that
 * reason, and `docs/GEN_IDEAS.md` says how to kill it fast: one prompt, four subjects, one candidate
 * each, and look at the outlines as pictures before rasterising anything.
 */

/**
 * A control row: the height, and the reach of the outline either side of the centre at that height.
 *
 * The row comes first, because the list is read and checked in row order and a list sorted by its
 * own first column is a list a human can see the shape of. (§3's sketch wrote the pair the other way
 * round; nothing was built on it.)
 *
 * `half` is deliberately allowed to be fractional. The interpolation between two ribs is where the
 * curve comes from, so the arithmetic stays real and the rounding happens once, at the end, per row.
 */
export type Rib = readonly [row: number, half: number]

/**
 * The tallest row a rib may name, and the furthest a half may reach.
 *
 * 127 and 64 are the largest canvas — 128³ — read as a row index and as a half-width. A rib past
 * either is dropped rather than clamped: clamping a row would stack two ribs on one row and silently
 * pick one of them, and clamping a half would flatten a mistyped `600` into a wall that looks like
 * geometry instead of like an error.
 */
export const MAX_ROW = 127
export const MAX_HALF = 64

/**
 * The colour a hull falls back to — the stone grey the tower example is built in.
 *
 * It exists so that a hull is never *dropped* for want of a colour. `readSpec` throws away a box
 * whose colour is not a hex triple, and the hull is the whole model, so a mistyped colour would cost
 * everything and leave the detail boxes floating.
 */
const DEFAULT_COLOR = '#8a8a86'

const isHex = (value: unknown): value is string =>
    typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)

/**
 * The ribs as this module will use them: in row order, one per row, in range.
 *
 * Both entry points go through it, so a list handed straight to `silhouette` by our own code is held
 * to the same shape as one a reply passed. Two ribs on one row is the last one, matching the way a
 * later op paints over an earlier one — a reply that restates a row is correcting itself.
 */
const cleanRibs = (ribs: readonly Rib[]): readonly Rib[] => {
    const byRow = new Map<number, number>()
    for (const [row, half] of ribs) {
        if (!Number.isFinite(row) || !Number.isFinite(half)) continue
        const at = Math.floor(row)
        if (at < -MAX_ROW || at > MAX_ROW) continue
        byRow.set(at, Math.min(MAX_HALF, Math.max(0, half)))
    }
    return [...byRow].sort((a, b) => a[0] - b[0])
}

const readRib = (value: unknown): Rib | undefined => {
    if (!Array.isArray(value)) return undefined
    const pair: readonly unknown[] = value
    const [row, half] = pair
    if (typeof row !== 'number' || typeof half !== 'number') return undefined
    return [row, half]
}

/**
 * What a reply passed, narrowed into ribs. Anything that is not one is dropped, not fatal.
 *
 * The same call `readSpec` makes for the same reason: a list of twenty ribs with one typo in it is
 * nineteen good ribs and a straight stretch, and refusing the whole outline over one pair would cost
 * the eight seconds of generation that produced it.
 */
export const readRibs = (value: unknown): readonly Rib[] => {
    if (!Array.isArray(value)) return []
    const rows: readonly unknown[] = value
    return cleanRibs(rows.map(readRib).filter((rib): rib is Rib => rib !== undefined))
}

/**
 * The outline's reach at one row: linear between the two ribs around it, flat outside them.
 *
 * Flat rather than tapering, in both directions, because a rib is a statement about a row and
 * silence is not a statement about a shape. Tapering to nothing above the last rib would invent a
 * point the model never asked for; holding the last reach gives a flat cut, which is what a plinth
 * and a cropped top actually look like.
 */
const halfAt = (ribs: readonly Rib[], row: number): number => {
    const first = ribs[0]
    const last = ribs[ribs.length - 1]
    if (!first || !last) return 0
    if (row <= first[0]) return first[1]
    if (row >= last[0]) return last[1]
    for (let i = 1; i < ribs.length; i += 1) {
        const lo = ribs[i - 1]
        const hi = ribs[i]
        if (!lo || !hi) continue
        if (row > hi[0]) continue
        const span = hi[0] - lo[0]
        if (span <= 0) return hi[1]
        return lo[1] + ((hi[1] - lo[1]) * (row - lo[0])) / span
    }
    return last[1]
}

/**
 * One row's real extent, rounded to whole voxels **with the parity of the widest row**.
 *
 * The parity lock is the whole difference between a curve and a wobble. Rounding each row on its own
 * gives widths 4, 3, 4, 3 down a straight flank, and a row of odd width cannot sit centred on the
 * same axis as a row of even width — so the silhouette shifts half a voxel side to side and reads as
 * noise rather than as an outline. Locked, every row of a hull is symmetric about the same axis and
 * the centring below is exact rather than rounded.
 *
 * A tie goes to the wider row: a curve that loses a voxel reads as a step, and the reach the model
 * named is a floor on what it wanted, not a ceiling.
 *
 * A row is never empty. A `half` of 0 comes out one voxel (two, under an even parity) because a zero
 * row cuts the model in two, and one 6-connected piece is the property this whole idea has to keep
 * to be worth anything — `score.ts` measures it and `bank.test.ts` holds the examples to it.
 */
const widthAt = (want: number, parity: number): number => {
    const steps = Math.ceil((parity - want) / 2 - 0.5)
    return Math.max(parity % 2 === 0 ? 2 : 1, parity - 2 * steps)
}

/**
 * Two outlines into boxes: one box per run of rows that come out the same size.
 *
 * The rows painted are the rows the outlines talk about — from the lowest row either list names to
 * the highest — and never below `y = 0`, which is the op language's floor. A rib under the floor is
 * therefore a *control point* rather than a row: the outline it steers still bends over the rows
 * above it, and nothing is painted under the ground.
 *
 * A list with nothing in it paints nothing, and so does one outline without the other: a single
 * silhouette is an extrusion with no bound on the other axis, and there is no honest depth to invent
 * for it. `specFromCode` reads an op list with nothing in it as no model at all, which is already
 * what `retryEmpty` (§11) is for.
 */
export const silhouette = (
    front: readonly Rib[],
    side: readonly Rib[],
    color: string
): readonly VoxOp[] => {
    const across = cleanRibs(front)
    const deep = cleanRibs(side)
    const firstAcross = across[0]
    const firstDeep = deep[0]
    const lastAcross = across[across.length - 1]
    const lastDeep = deep[deep.length - 1]
    if (!firstAcross || !firstDeep || !lastAcross || !lastDeep) return []
    const low = Math.max(0, Math.min(firstAcross[0], firstDeep[0]))
    const top = Math.max(lastAcross[0], lastDeep[0])
    if (top < low) return []
    const tint = isHex(color) ? color : DEFAULT_COLOR

    // The widest and deepest row first, because they set the parity every other row is locked to.
    let widest = 1
    let deepest = 1
    for (let row = low; row <= top; row += 1) {
        widest = Math.max(widest, Math.round(2 * halfAt(across, row)))
        deepest = Math.max(deepest, Math.round(2 * halfAt(deep, row)))
    }

    const rows: (readonly [number, number])[] = []
    for (let row = low; row <= top; row += 1) {
        rows.push([
            widthAt(2 * halfAt(across, row), widest),
            widthAt(2 * halfAt(deep, row), deepest)
        ])
    }

    const ops: VoxOp[] = []
    for (let i = 0; i < rows.length;) {
        const cell = rows[i]
        if (!cell) {
            i += 1
            continue
        }
        const [w, d] = cell
        // One box per run of identical rows, so a straight flank is one op and a constant pair of
        // outlines is exactly the box it describes rather than twenty-four slices of one.
        let end = i + 1
        while (end < rows.length) {
            const next = rows[end]
            if (next?.[0] !== w || next[1] !== d) break
            end += 1
        }
        // Parity is locked, so `w` and `widest` agree and this halving is exact: odd rows centre on
        // column 0, even rows on the boundary at 0, and every row of the hull on the same axis.
        const x0 = -Math.floor(w / 2)
        const z0 = -Math.floor(d / 2)
        ops.push({
            op: 'box',
            from: [x0, low + i, z0],
            to: [x0 + w - 1, low + end - 1, z0 + d - 1],
            color: tint
        })
        i = end
    }
    return ops
}

/** The two functions a reply gets, once the `silhouette` flag puts them in scope. */
export interface Silhouette {
    /** Half-width in x per row, and optionally the colour the hull is painted in. */
    readonly front: (rows: unknown, color?: unknown) => void
    /** Half-depth in z per row. */
    readonly side: (rows: unknown, color?: unknown) => void
}

/**
 * `front` and `side` over an emitter, so the hull lands **where the reply called for it**.
 *
 * The pair emits the moment it completes — front and side both in hand — rather than being collected
 * and appended at the end, and that ordering is the reason this is a module and not two lines in
 * `code.ts`. Ops paint in list order, so a hull appended last would paint over every eye, spot and
 * fin the reply drew after it. Emitting on completion puts the hull exactly where the reply put it,
 * with no decision left at the call site.
 *
 * A completed pair also clears both halves, so a second `front`/`side` pair is a second part: a
 * stalk and a cap, in two colours, concentric because every hull is centred on the same axes. Either
 * call may carry the colour and the last one given wins, because the model writes the colour beside
 * whichever outline it thought of first.
 */
export const silhouetteScope = (
    emit: (op: VoxOp) => void,
    fallback: string = DEFAULT_COLOR
): Silhouette => {
    let across: readonly Rib[] | undefined
    let deep: readonly Rib[] | undefined
    let color = isHex(fallback) ? fallback : DEFAULT_COLOR
    const pair = (): void => {
        if (!across || !deep) return
        for (const op of silhouette(across, deep, color)) emit(op)
        across = undefined
        deep = undefined
    }
    /** An unreadable list is *no* list, so the next good call still finds its partner waiting. */
    const held = (rows: unknown): readonly Rib[] | undefined => {
        const read = readRibs(rows)
        return read.length > 0 ? read : undefined
    }
    return {
        front: (rows, tint) => {
            across = held(rows)
            if (isHex(tint)) color = tint
            pair()
        },
        side: (rows, tint) => {
            deep = held(rows)
            if (isHex(tint)) color = tint
            pair()
        }
    }
}

/**
 * The worked examples for the flag, in the reply's own code style.
 *
 * Finding 7 is that one worked example beats every rule in the system prompt, and `front`/`side` are
 * a language the model has never seen — so whoever wires the flag teaches with these rather than
 * with prose about ribs. They are held to the same floor as the bank's replies in `shape.test.ts`:
 * one 6-connected piece, nowhere near a solid brick, and taller than it is thick.
 *
 * Two, because two is what the format has to say for itself: **the fish is one hull** whose whole
 * shape is the lens the side outline draws, and **the mushroom is two hulls stacked**, which is how
 * a model gets two colours and a flare out of an intersection that is one colour per pair. Detail —
 * an eye, a fin, the spots — stays in `box`, painted after, which is also what §3 says it is for.
 *
 * `mushroom` is a bank id and `fish` is not; the fish is the subject §3 names, and it is the one
 * whose old box-built version came back a slab.
 */
export const SILHOUETTE_EXAMPLES: Readonly<Record<string, string | undefined>> = {
    fish: `// fish: 14 long, 10 tall, 4 across; the side outline is the whole shape, the front is thin
front([[0,1],[4,2],[9,1]], '#3f8fbf')   // half-width per row: thin, thickest at mid-height
side([[0,3],[4,7],[9,4]])               // half-depth per row: the lens that makes it a fish
box(-1,3,-9, 0,6,-7, '#2f6f96')         // tail fin, standing off the back
box(-2,6,3, -2,6,4, '#101820')          // left eye, on the flank near the nose
box(1,6,3, 1,6,4, '#101820')            // right eye`,

    mushroom: `// mushroom: pale stalk 4 across, red cap flaring at row 8 and closing to a dome
front([[0,2],[7,2]], '#efe6d2')         // the stalk: straight, so both outlines are two ribs
side([[0,2],[7,2]])
front([[8,5],[10,4],[12,1]], '#c0392b') // the cap: widest where it meets the stalk
side([[8,5],[10,4],[12,1]])
box(-4,10,-1, -4,10,0, '#ffffff')       // spots, on the tier the one above leaves showing
box(-1,10,3, 0,10,3, '#ffffff')`
}
