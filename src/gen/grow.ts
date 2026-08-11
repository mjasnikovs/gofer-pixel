import {MAX_SIZE, type Vec3, type VoxOp} from './ops'

/**
 * Three procedural generators, for the three subjects that actually have one.
 *
 * `docs/GEN_IDEAS.md` §6. The diagnosis it comes out of is that the model is responsible for
 * absolute integer coordinates in 3D, twelve numbers per limb, and that nothing above ~20 primitives
 * comes back coherent. Finding 4 says organic and architectural subjects are the ones that work and
 * directional machines are the ones that do not — and plants and buildings are also exactly the two
 * things procedural generation solved forty years ago. So the model does what the picking call
 * already does, which is *choose*: a generator and four numbers. Code grows the four hundred voxels
 * of branch that would otherwise be four hundred coordinates it cannot count.
 *
 * **This is deliberately not general and must not pretend to be.** Three subjects — a tree, a tower,
 * a rock — and everything else falls through to the op language exactly as before. A fourth
 * generator is a fourth measurement, not a refactor of these into a framework: the moment `grow.ts`
 * grows a general grammar engine it stops being three shapes an artist would keep and becomes a
 * language nobody writes examples in.
 *
 * Two properties hold the whole thing together, and both are contracts rather than conveniences:
 *
 * 1. **Everything comes out as the existing `VoxOp[]`.** `box`, `ball`, `erase`, and nothing else.
 *    A branch is a run of small boxes; that is fine, and it is what keeps the record unchanged —
 *    `rasterise → finish` still reproduces the asset from the ops, `gen/decompose.ts` still reads it
 *    back, `sheet/` never learns a new word. The cost is op count, which is why every generator below
 *    says out loud what bounds it against `code.ts`'s `OP_BUDGET` of 4096.
 *
 * 2. **Determinism, with no exceptions.** No `Math.random`, no `Date`. Every varying number comes
 *    from `hash`, which is `finish.ts`'s integer mixer with a fourth input so a seed can travel
 *    beside a coordinate. The whole record in `docs/GEN_RESEARCH.md` is fixed-seed comparisons, and
 *    `GenerationRecord` promises that a spec reproduces its asset; a generator that reached for
 *    `Math.random` would break both at once and only be noticed a session later.
 *
 * Coordinates are the op language's: **y-up, feet at y = 0** (finding 5), centred in x and z, and
 * inside the canvas. Every emitted op goes through `fitBox`/`fitBall`, so the canvas is enforced here
 * as well as asked for — these numbers arrive from a 27B model, `MAX_SIZE` is enforced downstream
 * anyway, and a generator that painted at `y = 400` would be silently dropped rather than clamped.
 */

/** Deterministic hash on the half-open unit interval — `finish.ts`'s mixer with a seed lane. */
const hash = (a: number, b: number, c: number, d: number): number => {
    let h =
        (Math.trunc(a) * 374761393
            + Math.trunc(b) * 668265263
            + Math.trunc(c) * 2147483647
            + Math.trunc(d) * 1442695041)
        >>> 0
    h = (h ^ (h >>> 13)) >>> 0
    h = (h * 1274126177) >>> 0
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

/** One roll from a seed, addressed by an index rather than by call order. */
const jitter = (seed: number, index: number): number => hash(seed, index, 7, 0)

const clampInt = (value: number, lo: number, hi: number): number =>
    Math.max(lo, Math.min(Math.max(lo, hi), Math.round(value)))

/**
 * An option read as a whole number, or its default.
 *
 * Every number in every options object goes through this, because every one of them was typed by a
 * model: `height: 26.5`, `height: "26"` and `height: 2600` are all replies that have happened, and
 * the third would otherwise allocate nothing and paint nothing.
 */
const whole = (value: number | undefined, fallback: number, lo: number, hi: number): number =>
    clampInt(typeof value === 'number' && Number.isFinite(value) ? value : fallback, lo, hi)

const HEX = /^#[0-9a-fA-F]{6}$/

const hexOf = (value: string | undefined, fallback: string): string =>
    typeof value === 'string' && HEX.test(value) ? value : fallback

/**
 * The cube the generator draws inside.
 *
 * The floor is 12 rather than 1: below that a battlemented tower has no room for a parapet and the
 * clamps would collapse it into a post, which is a shape nobody asked for rather than a small tower.
 * The ceiling is 256 because `ask.ts` offers 128 at the top and `MAX_SIZE` clamps again downstream.
 */
const canvasOf = (value: number | undefined): number => whole(value, MAX_SIZE, 12, 256)

const seedOf = (value: number | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) % 2147483647 : 1

const unit = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback

const span = (a: number, b: number, cap: number): readonly [number, number] | undefined => {
    const low = Math.min(Math.round(a), Math.round(b))
    const high = Math.max(Math.round(a), Math.round(b))
    if (high < 0 || low > cap) return undefined
    return [Math.max(0, low), Math.min(cap, high)]
}

/**
 * A box clipped to the canvas, or `undefined` for one that is entirely outside it.
 *
 * Outside is dropped rather than clamped, for the same reason `rasterise` drops off-grid writes:
 * clamping smears a mistake along a wall, where it looks like geometry instead of like an error.
 */
const fitBox = (from: Vec3, to: Vec3, cap: number): readonly [Vec3, Vec3] | undefined => {
    const x = span(from[0], to[0], cap)
    const y = span(from[1], to[1], cap)
    const z = span(from[2], to[2], cap)
    if (!x || !y || !z) return undefined
    return [
        [x[0], y[0], z[0]],
        [x[1], y[1], z[1]]
    ]
}

/**
 * A ball moved and shrunk until it fits the canvas.
 *
 * An ellipsoid cannot be clipped — there is no op for half a ball — so containment has to be bought
 * by squashing the radius, which also squashes the far side. Every generator below sizes its blobs
 * to fit by construction; this is the net under that arithmetic, not the mechanism.
 */
const fitBall = (at: Vec3, r: Vec3, cap: number): readonly [Vec3, Vec3] => {
    const cx = clampInt(at[0], 0, cap)
    const cy = clampInt(at[1], 0, cap)
    const cz = clampInt(at[2], 0, cap)
    const fit = (radius: number, centre: number): number =>
        Math.max(0, Math.min(Math.round(radius), centre, cap - centre))
    return [
        [cx, cy, cz],
        [fit(r[0], cx), fit(r[1], cy), fit(r[2], cz)]
    ]
}

const addBox = (out: VoxOp[], cap: number, from: Vec3, to: Vec3, color: string): void => {
    const fitted = fitBox(from, to, cap)
    if (fitted) out.push({op: 'box', from: [...fitted[0]], to: [...fitted[1]], color})
}

const addErase = (out: VoxOp[], cap: number, from: Vec3, to: Vec3): void => {
    const fitted = fitBox(from, to, cap)
    if (fitted) out.push({op: 'erase', from: [...fitted[0]], to: [...fitted[1]]})
}

const addBall = (out: VoxOp[], cap: number, at: Vec3, r: Vec3, color: string): void => {
    const [centre, radius] = fitBall(at, r, cap)
    out.push({op: 'ball', at: [...centre], r: [...radius], color})
}

/**
 * The voxels a limb passes through, one axis at a time.
 *
 * One axis per step is the whole point: it makes the run **6-connected**, which is the connectivity
 * `score.ts` measures and the connectivity a detached canopy fails. A diagonal walk that moved two
 * axes at once would produce a branch that looks continuous in the viewport and scores as a scatter
 * of debris — the exact failure this project already has from the model, and one it would be
 * inexcusable to ship from code we wrote ourselves.
 *
 * Sampled at three points per voxel of arc, so a shallow limb never skips a cell. The guard bounds
 * the inner walk at 8 cells, which no sample one third of a voxel apart can ever need; it is there so
 * a direction vector of the wrong magnitude cannot spin.
 */
const walk = (from: Vec3, dir: Vec3, length: number): readonly Vec3[] => {
    let x = Math.round(from[0])
    let y = Math.round(from[1])
    let z = Math.round(from[2])
    const path: Vec3[] = [[x, y, z]]
    const steps = Math.max(1, Math.ceil(length * 3))
    for (let i = 1; i <= steps; i += 1) {
        const t = (i / steps) * length
        const tx = Math.round(from[0] + dir[0] * t)
        const ty = Math.round(from[1] + dir[1] * t)
        const tz = Math.round(from[2] + dir[2] * t)
        let guard = 0
        while ((x !== tx || y !== ty || z !== tz) && guard < 8) {
            if (x !== tx) x += Math.sign(tx - x)
            else if (y !== ty) y += Math.sign(ty - y)
            else z += Math.sign(tz - z)
            path.push([x, y, z])
            guard += 1
        }
    }
    return path
}

/** A direction from an azimuth around y and an elevation above the horizon. */
const heading = (azimuth: number, elevation: number): Vec3 => [
    Math.cos(elevation) * Math.cos(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.sin(azimuth)
]

/** The golden angle, so `n` branches around a trunk never stack over each other for any `n`. */
const GOLDEN = 2.399963229728653

export interface TreeOptions {
    readonly seed?: number
    /** The cube to draw inside. Everything is clamped to it. */
    readonly canvas?: number
    /** Total height in voxels, feet at `y = 0`. */
    readonly height?: number
    /** Trunk thickness across. */
    readonly trunk?: number
    /** First-order branches for `round`, needle tiers for `pine`. */
    readonly branches?: number
    /** How far a branch reaches from the trunk, in voxels. */
    readonly spread?: number
    readonly shape?: 'round' | 'pine'
    readonly bark?: string
    readonly leaf?: string
}

/**
 * A tree: trunk, branches, canopy.
 *
 * The `round` shape is the L-system — an axiom (the trunk) and one rewrite applied twice: a limb
 * leaves its parent at a golden-angle turn with a shorter length and a steeper rise, and a leaf blob
 * sits on every tip. Two generations rather than five, because a voxel branch is one voxel thick at
 * the third and a one-voxel twig disappears at sprite resolution — depth past the point where the
 * result is visible is op budget spent on nothing.
 *
 * `pine` is the same trunk with tiers of needles instead, and it is a separate shape rather than a
 * parameter sweep of the first because a conifer's silhouette is not a deciduous one with the
 * numbers turned down: the branches are hidden inside the needles, so drawing them is a hundred ops
 * nobody can see.
 *
 * **Connectivity is by construction, not by luck.** Every limb starts on a voxel that is already
 * painted — a branch at the trunk's own axis, a child at a recorded cell of its parent's path — every
 * run is 6-connected by `walk`, and every leaf blob is centred on the tip it hangs from, so it
 * contains that voxel even after `fitBall` has squashed it against a wall. The crown is centred on
 * the top of the trunk for the same reason.
 *
 * **Bound:** at most 8 branches, each a run of at most `spread × 1.2` voxels plus one child at 55 %
 * of that, and `walk` costs at most √3 cells per voxel of length. Worst case at canvas 256 is under
 * 1400 ops; at the 32 the findings were walked on it is about 150. `pine` is at most 10 ops total.
 */
export const tree = (opts: TreeOptions = {}): readonly VoxOp[] => {
    const canvas = canvasOf(opts.canvas)
    const cap = canvas - 1
    const seed = seedOf(opts.seed)
    const shape = opts.shape === 'pine' ? 'pine' : 'round'
    const height = whole(opts.height, Math.round(canvas * 0.78), 5, cap)
    const trunk = whole(
        opts.trunk,
        Math.max(1, Math.round(canvas / 12)),
        1,
        Math.max(1, Math.floor(canvas / 4))
    )
    const reach = Math.max(1, Math.floor((canvas - 1) / 2) - 1)
    const spread = whole(opts.spread, Math.max(2, Math.round(height * 0.32)), 1, reach)
    const bark = hexOf(opts.bark, '#5a3d24')
    const leaf = hexOf(opts.leaf, '#3a7a2a')
    const cx = Math.floor(canvas / 2)
    const cz = Math.floor(canvas / 2)
    const half = Math.floor(trunk / 2)
    const ops: VoxOp[] = []

    // The trunk carries the whole tree, so it is one box and every limb starts on its axis.
    const trunkTop = shape === 'pine' ? height - 1 : Math.max(2, Math.round(height * 0.6))
    addBox(
        ops,
        cap,
        [cx - half, 0, cz - half],
        [cx - half + trunk - 1, trunkTop, cz - half + trunk - 1],
        bark
    )

    if (shape === 'pine') {
        const tiers = whole(opts.branches, Math.max(3, Math.min(7, Math.round(height / 4))), 2, 8)
        const gap = tiers > 1 ? (height * 0.66) / (tiers - 1) : height
        /*
         * Half the gap, plus one. An ellipsoid is a single voxel at `|dy| = ry`, so a tier only
         * *reads* to `ry - 1` — sized at half the gap exactly, a pine comes out with a bald ring
         * between every pair of tiers and the trunk showing through it.
         */
        const thick = Math.max(1, Math.ceil(gap / 2) + 1)
        // A tier may lean off the axis, but never further than the trunk is wide: the ball has to
        // keep containing a painted trunk cell, which is the whole of why the canopy is attached.
        const lean = Math.min(1, Math.floor(trunk / 2))
        for (let i = 0; i < tiers; i += 1) {
            const along = tiers === 1 ? 0 : i / (tiers - 1)
            const roll = jitter(seed, i * 3 + 1)
            const drift = jitter(seed, i * 3 + 2)
            const y = clampInt(height * (0.3 + 0.66 * along), 1, height - 1)
            const wide = Math.max(1, Math.round(spread * (1 - 0.78 * along) * (0.85 + 0.3 * roll)))
            const dx =
                roll < 0.33 ? -lean
                : roll > 0.66 ? lean
                : 0
            const dz =
                drift < 0.33 ? -lean
                : drift > 0.66 ? lean
                : 0
            addBall(ops, cap, [cx + dx, y, cz + dz], [wide, thick, wide], leaf)
        }
        return ops
    }

    const count = whole(opts.branches, Math.max(3, Math.min(6, Math.round(height / 5))), 0, 8)
    const blob = Math.max(1, Math.round(height * 0.13))
    const crown = Math.max(1, Math.round(height * 0.17))
    const thick = Math.max(1, Math.round(trunk * 0.35))
    const twig = Math.max(1, Math.round(thick * 0.6))

    const limb = (from: Vec3, dir: Vec3, length: number, size: number): readonly Vec3[] => {
        const path = walk(from, dir, length)
        const off = Math.floor((size - 1) / 2)
        for (const [x, y, z] of path) {
            addBox(
                ops,
                cap,
                [x - off, y - off, z - off],
                [x - off + size - 1, y - off + size - 1, z - off + size - 1],
                bark
            )
        }
        return path
    }

    for (let i = 0; i < count; i += 1) {
        const r1 = jitter(seed, i * 5 + 1)
        const r2 = jitter(seed, i * 5 + 2)
        const r3 = jitter(seed, i * 5 + 3)
        const along = 0.45 + 0.5 * (count === 1 ? 0.5 : i / (count - 1))
        const azimuth = i * GOLDEN + (r1 - 0.5) * 0.8
        const rise = 0.55 + 0.5 * r2
        const length = Math.max(2, Math.round(spread * (0.7 + 0.5 * r3)))
        const start: Vec3 = [cx, Math.round(trunkTop * along), cz]
        const path = limb(start, heading(azimuth, rise), length, thick)
        const tip = path[path.length - 1] ?? start
        addBall(ops, cap, tip, [blob, blob, blob], leaf)

        // One rewrite: the child leaves a *recorded* cell of the parent, never a re-derived one.
        const joint = path[Math.floor(path.length * 0.55)] ?? start
        const childDir = heading(azimuth + (r1 > 0.5 ? 0.7 : -0.7), Math.min(1.3, rise + 0.25))
        const childPath = limb(joint, childDir, Math.max(2, Math.round(length * 0.55)), twig)
        const childTip = childPath[childPath.length - 1] ?? joint
        addBall(ops, cap, childTip, [blob - 1, blob - 1, blob - 1], leaf)
    }

    addBall(
        ops,
        cap,
        [cx, trunkTop, cz],
        [crown, Math.max(1, Math.round(crown * 0.8)), crown],
        leaf
    )
    return ops
}

export interface TowerOptions {
    readonly seed?: number
    readonly canvas?: number
    /** Total height in voxels, plinth on the floor. */
    readonly height?: number
    /** The shaft across, before the corners are chamfered. */
    readonly width?: number
    /** Banded courses up the shaft. */
    readonly courses?: number
    /** Windows per face. Some are skipped by the seed, because four identical faces read as a prop. */
    readonly windows?: number
    readonly battlements?: boolean
    readonly stone?: string
    readonly trim?: string
    /** The colour of a window and of the shadow inside the door. */
    readonly dark?: string
}

/**
 * A tower, as a grammar rather than as an L-system: plinth, shaft, courses, chamfer, parapet.
 *
 * It is the one generator here whose shape comes mostly from `erase`, and that is the point —
 * `builtin.ts`'s hand-typed tower is battlemented and not a box for exactly the same reason. A
 * parapet is a ring with its middle taken out and its top notched; a door is a hole; the round shaft
 * is a square one with its four corners cut away in a stepped chamfer. Everything carved is carved
 * *after* the thing it cuts, and the chamfer is deliberately kept off the plinth and the parapet, so
 * a round shaft stands on a square base and carries a square crown, which is what a real one does.
 *
 * The seed moves the course heights, the window heights, and which windows exist at all. It moves
 * nothing structural: a tower whose parapet came and went with the seed would not be a family of
 * towers, it would be two generators sharing a name.
 *
 * **Bound:** 1 shaft + 1 plinth + at most 12 courses + at most 4 × `width / 5` chamfer strips +
 * 1 parapet + 1 hollow + at most 12 crenel cuts + 1 door + at most 16 windows. Under 250 ops at any
 * canvas, and about 60 at 32.
 */
export const tower = (opts: TowerOptions = {}): readonly VoxOp[] => {
    const canvas = canvasOf(opts.canvas)
    const cap = canvas - 1
    const seed = seedOf(opts.seed)
    const height = whole(opts.height, Math.round(canvas * 0.82), 8, cap)
    const width = whole(opts.width, Math.max(5, Math.round(canvas * 0.32)), 5, canvas - 2)
    const courses = whole(opts.courses, Math.max(1, Math.round(height / 9)), 0, 12)
    const windows = whole(opts.windows, 2, 0, 4)
    const battlements = opts.battlements !== false
    const stone = hexOf(opts.stone, '#8a8a86')
    const trim = hexOf(opts.trim, '#6f6f6b')
    const dark = hexOf(opts.dark, '#2b2b28')

    const cx = Math.floor(canvas / 2)
    const cz = Math.floor(canvas / 2)
    const x0 = cx - Math.floor(width / 2)
    const x1 = x0 + width - 1
    const z0 = cz - Math.floor(width / 2)
    const z1 = z0 + width - 1
    /*
     * The plinth and the parapet overhang the shaft, and the overhang is a fraction of the width
     * rather than the one voxel a 32-canvas tower wants. It reads as a corbel either way; what it
     * decides is the bounding box, and a fixed one voxel means a 128-canvas tower fills 84 % of its
     * own box against 65 % at 32 — the same tower scoring as a brick because it got bigger.
     */
    const over = Math.max(1, Math.round(width / 9))
    // A parapet is three courses at 32 and proportionally more on a taller tower: the slab it stands
    // on, the merlons, and the notched top.
    const crest = clampInt(height * 0.12, 3, 10)
    const shaftTop = height - crest - 1
    const plinth = clampInt(height * 0.1, 1, Math.max(1, shaftTop - 2))
    const ops: VoxOp[] = []

    addBox(ops, cap, [x0, 0, z0], [x1, shaftTop, z1], stone)
    addBox(ops, cap, [x0 - over, 0, z0 - over], [x1 + over, plinth, z1 + over], trim)

    for (let k = 1; k <= courses; k += 1) {
        const at = clampInt(
            plinth + ((shaftTop - plinth) * k) / (courses + 1) + (jitter(seed, k * 11) - 0.5) * 2,
            plinth + 1,
            Math.max(plinth + 1, shaftTop - 1)
        )
        addBox(ops, cap, [x0, at, z0], [x1, at, z1], trim)
    }

    // The chamfer: cut the triangle `dx + dz < c` out of each corner of the shaft only.
    const chamfer =
        width >= 7 ? clampInt(width / 4, 1, Math.max(1, Math.floor((width - 3) / 2))) : 0
    for (let d = 0; d < chamfer; d += 1) {
        const deep = chamfer - 1 - d
        addErase(ops, cap, [x0 + d, plinth + 1, z0], [x0 + d, shaftTop, z0 + deep])
        addErase(ops, cap, [x0 + d, plinth + 1, z1 - deep], [x0 + d, shaftTop, z1])
        addErase(ops, cap, [x1 - d, plinth + 1, z0], [x1 - d, shaftTop, z0 + deep])
        addErase(ops, cap, [x1 - d, plinth + 1, z1 - deep], [x1 - d, shaftTop, z1])
    }

    addBox(
        ops,
        cap,
        [x0 - over, shaftTop + 1, z0 - over],
        [x1 + over, height - 1, z1 + over],
        stone
    )
    if (battlements) {
        // Hollow the ring, then notch its top. The wall left standing is the overhang thick, which
        // is what makes the parapet read as a parapet from a sprite-sized camera. The notch stops
        // two courses short of the floor of the ring, so every merlon is still joined to the tower.
        addErase(ops, cap, [x0, shaftTop + 2, z0], [x1, height - 1, z1])
        const gaps = clampInt(width / 3, 1, 6)
        const notch = Math.max(1, Math.round(width / 8))
        const deep = clampInt(crest / 3, 1, Math.max(1, crest - 2))
        for (let g = 0; g < gaps; g += 1) {
            const at = x0 + Math.floor((width * (g + 0.5)) / gaps) - Math.floor(notch / 2)
            const off = at - x0
            addErase(
                ops,
                cap,
                [at, height - deep, z0 - over],
                [at + notch - 1, height - 1, z1 + over]
            )
            addErase(
                ops,
                cap,
                [x0 - over, height - deep, z0 + off],
                [x1 + over, height - 1, z0 + off + notch - 1]
            )
        }
    }

    const doorTop = clampInt(height * 0.16 + 1, 2, Math.max(2, shaftTop - 2))
    addErase(ops, cap, [cx - 1, 0, Math.max(0, z0 - over)], [cx, doorTop, z0])

    for (let face = 0; face < 4; face += 1) {
        for (let k = 0; k < windows; k += 1) {
            if (jitter(seed, face * 17 + k * 3 + 5) < 0.18) continue
            const at = clampInt(
                plinth
                    + ((shaftTop - plinth - 2) * (k + 1)) / (windows + 1)
                    + (jitter(seed, face * 17 + k * 3 + 6) - 0.5) * 3,
                plinth + 1,
                Math.max(plinth + 1, shaftTop - 2)
            )
            if (face === 0) addBox(ops, cap, [cx - 1, at, z0], [cx, at + 1, z0], dark)
            else if (face === 1) addBox(ops, cap, [cx - 1, at, z1], [cx, at + 1, z1], dark)
            else if (face === 2) addBox(ops, cap, [x0, at, cz - 1], [x0, at + 1, cz], dark)
            else addBox(ops, cap, [x1, at, cz - 1], [x1, at + 1, cz], dark)
        }
    }

    return ops
}

/**
 * The most columns a rock may be built from, and therefore its op count.
 *
 * A rock is the one generator whose natural expression is per-voxel, and per-voxel does not fit: a
 * 128³ boulder is 300 000 cells against a budget of 4096 ops. So it is built from **one box per
 * column** — a lattice column, not a voxel column — and the lattice is coarsened until the count
 * fits. 900 leaves room for the moss pass and still lands a 32-canvas rock at one voxel per cell,
 * which is the canvas the findings were walked on.
 */
const ROCK_COLUMNS = 900

const smooth = (t: number): number => t * t * (3 - 2 * t)

/** Value noise: one hash per lattice corner, smoothstepped trilinear between them. */
const valueNoise = (seed: number, x: number, y: number, z: number, period: number): number => {
    const px = x / period
    const py = y / period
    const pz = z / period
    const ix = Math.floor(px)
    const iy = Math.floor(py)
    const iz = Math.floor(pz)
    const fx = smooth(px - ix)
    const fy = smooth(py - iy)
    const fz = smooth(pz - iz)
    let total = 0
    for (let dx = 0; dx <= 1; dx += 1) {
        for (let dy = 0; dy <= 1; dy += 1) {
            for (let dz = 0; dz <= 1; dz += 1) {
                const weight =
                    (dx === 1 ? fx : 1 - fx) * (dy === 1 ? fy : 1 - fy) * (dz === 1 ? fz : 1 - fz)
                total += weight * hash(seed, ix + dx, iy + dy, iz + dz)
            }
        }
    }
    return total
}

export interface RockOptions {
    readonly seed?: number
    readonly canvas?: number
    readonly width?: number
    /** Height in voxels. A boulder is wider than it is tall; the default is 0.42 of the canvas. */
    readonly height?: number
    readonly depth?: number
    /** 0 is a smooth dome, 1 is rubble. */
    readonly bumpiness?: number
    readonly stone?: string
    /** Crusted onto the cells with sky above them. Set it to the stone colour for a bare rock. */
    readonly moss?: string
}

/**
 * A rock: value noise over a half-ellipsoid, thresholded.
 *
 * The falloff is a dome rather than a ball — `u² + w² + t²` with `t` running 0…1 up the height — so
 * the widest slice is the one on the floor. That is finding 5's "feet at y = 0" taken seriously: a
 * full ellipsoid tapers at the bottom and gives a boulder balanced on a point.
 *
 * **Two constructions buy connectivity outright, and they are worth stating because noise cannot be
 * argued into being connected.** First, every surviving column is painted as a single span from its
 * lowest filled cell to its highest, widened if necessary to include the mid-depth plane — so any two
 * columns that are neighbours in the lattice share a cell on that plane. Second, the columns
 * themselves are flood-filled from the centre of the base, and anything the flood does not reach is
 * dropped. A 4-connected column mask where every column crosses one shared plane is a 6-connected
 * solid, which is the property `score.ts` measures.
 *
 * One span per column also means the rock has no unseen interior caves. Nothing renders them, `finish`
 * would shade their walls, and every one of them costs an op.
 *
 * **Bound:** at most `ROCK_COLUMNS` stone boxes plus one moss box per column that has sky above it,
 * so under 1000 ops at every canvas. The lattice step grows to hold that — 1 at canvas 32, 3 at 128.
 */
export const rock = (opts: RockOptions = {}): readonly VoxOp[] => {
    const canvas = canvasOf(opts.canvas)
    const cap = canvas - 1
    const seed = seedOf(opts.seed)
    const width = whole(opts.width, Math.round(canvas * 0.7), 3, canvas)
    const height = whole(opts.height, Math.max(3, Math.round(canvas * 0.42)), 2, canvas)
    const depth = whole(opts.depth, width, 3, canvas)
    const amp = 0.3 + 0.85 * unit(opts.bumpiness, 0.5)
    const stone = hexOf(opts.stone, '#7a736b')
    const moss = hexOf(opts.moss, '#4d6b3a')

    let step = 1
    while (Math.ceil(width / step) * Math.ceil(height / step) > ROCK_COLUMNS) step += 1
    const nx = Math.ceil(width / step)
    const ny = Math.ceil(height / step)
    const nz = Math.ceil(depth / step)
    const x0 = Math.max(0, Math.floor(canvas / 2) - Math.floor(width / 2))
    const z0 = Math.max(0, Math.floor(canvas / 2) - Math.floor(depth / 2))
    const period = Math.max(2, Math.round(Math.max(nx, nz) / 3))
    const middle = Math.floor((nz - 1) / 2)

    const field = (i: number, j: number, k: number): number => {
        const u = nx > 1 ? (i - (nx - 1) / 2) / ((nx - 1) / 2) : 0
        const w = nz > 1 ? (k - (nz - 1) / 2) / ((nz - 1) / 2) : 0
        const t = ny > 1 ? j / (ny - 1) : 0
        const noise =
            0.65 * valueNoise(seed, i, j, k, period)
            + 0.35 * valueNoise(seed + 101, i, j, k, Math.max(1, period / 2))
        return 1 - (u * u + w * w + t * t) + amp * (noise - 0.5)
    }

    const solid = new Uint8Array(nx * ny)
    const low = new Int32Array(nx * ny)
    const high = new Int32Array(nx * ny)
    for (let j = 0; j < ny; j += 1) {
        for (let i = 0; i < nx; i += 1) {
            let lo = -1
            let hi = -1
            for (let k = 0; k < nz; k += 1) {
                if (field(i, j, k) <= 0) continue
                if (lo < 0) lo = k
                hi = k
            }
            if (lo < 0) continue
            const at = j * nx + i
            solid[at] = 1
            low[at] = Math.min(lo, middle)
            high[at] = Math.max(hi, middle)
        }
    }

    // Flood from the centre of the base, which the falloff guarantees is solid, and keep only what
    // it reaches. Debris that floats off a boulder is the failure this generator exists not to have.
    const kept = new Uint8Array(nx * ny)
    const stack: number[] = [Math.floor((nx - 1) / 2)]
    while (stack.length > 0) {
        const at = stack.pop() ?? 0
        if (kept[at] === 1 || solid[at] !== 1) continue
        kept[at] = 1
        const i = at % nx
        const j = Math.floor(at / nx)
        if (i > 0) stack.push(at - 1)
        if (i < nx - 1) stack.push(at + 1)
        if (j > 0) stack.push(at - nx)
        if (j < ny - 1) stack.push(at + nx)
    }

    const ops: VoxOp[] = []
    for (let j = 0; j < ny; j += 1) {
        for (let i = 0; i < nx; i += 1) {
            const at = j * nx + i
            if (kept[at] !== 1) continue
            const bx0 = x0 + i * step
            const bx1 = Math.min(x0 + width - 1, bx0 + step - 1)
            const by0 = j * step
            const by1 = Math.min(height - 1, by0 + step - 1)
            const bz0 = z0 + (low[at] ?? 0) * step
            const bz1 = Math.min(z0 + depth - 1, z0 + ((high[at] ?? 0) + 1) * step - 1)
            addBox(ops, cap, [bx0, by0, bz0], [bx1, by1, bz1], stone)
            const above = j + 1 < ny && kept[at + nx] === 1
            if (!above && jitter(seed, at * 13 + 3) < 0.62) {
                addBox(ops, cap, [bx0, by1, bz0], [bx1, by1, bz1], moss)
            }
        }
    }
    return ops
}

/**
 * One worked example per generator, in the reply's own code style.
 *
 * Finding 7: a schema-constrained reply starts emitting on its first token, so it has nowhere to
 * think, and rules written in prose do not survive that — one example took "a cat" from 0
 * recognisable of 12 to 4 of 4. These are what teaches the model that `tree` takes an options object
 * and that most of it can be left out, and they are here rather than in `builtin.ts` because they
 * are only true while `procedural` is on: the bank has to keep teaching the op language for every
 * subject that has no generator, which is most of them.
 */
export const GROW_EXAMPLES: Readonly<Record<'tree' | 'tower' | 'rock', string>> = {
    tree: `// a pine tree: one trunk to the top, needles in tiers that widen downward
tree({shape: 'pine', height: 26, trunk: 3, branches: 6, leaf: '#2f6b33', bark: '#5a3d24', seed: 7})`,

    tower: `// a stone tower: square plinth, chamfered shaft with courses and windows, battlements
tower({height: 28, width: 11, courses: 3, windows: 2, stone: '#8a8a86', trim: '#6f6f6b', seed: 3})`,

    rock: `// a mossy boulder: wider than it is tall, lumpy, green only where the sky reaches it
rock({width: 22, height: 13, bumpiness: 0.6, stone: '#7a736b', moss: '#4d6b3a', seed: 11})`
}
