import {MAX_SIZE, type Vec3, type VoxOp} from './ops'

/**
 * A language of sizes and attachments, for a model that cannot be trusted with coordinates.
 *
 * `docs/GEN_IDEAS.md` §2. The diagnosis on that page is that this project's three standing complaints
 * — boxy silhouettes, proportions that drift with the seed, nothing above ~20 primitives holding
 * together — are one failure, and it is not a prompting failure: `box(5,0,5, 7,9,7, pants)` makes the
 * model responsible for twelve absolute integers per limb, every one of which has to agree with
 * twelve others for the parts to touch. The outside evidence is blunt about that being the wall.
 * 3DCodeBench's two named failure modes are "disconnected parts and incorrect structural
 * alignments", which it calls a gap in geometric reasoning rather than in code knowledge; the
 * spatial-language paper measures precise coordinate output as *near-zero across every
 * configuration*, and measures up to 5.7× swings in reconstruction quality from the choice of scene
 * language alone, for one model and one image.
 *
 * So the coordinates move into code and the model keeps the part it is good at: which parts exist,
 * how big each is next to the last, what colour. Three of today's failure modes stop being rare and
 * become **unrepresentable**:
 *
 * 1. **An attached part cannot float.** `attach` takes a face, not a position. The offset along that
 *    face's own axis is not a parameter — it is read off the parent — and the two offsets that *are*
 *    parameters are clamped so the child's cross-section still overlaps the parent's. There is no
 *    number the model can write that separates them.
 * 2. **A leg cannot fail to reach the floor.** `legs` names a length, not a bottom. The floor is the
 *    lowest thing in the whole rig and legs are cut to it at emit, so the answer to "the legs do not
 *    reach the bottom" — a real critique the dead revision loop produced, verbatim, and could not
 *    then act on — is arithmetic rather than a retry.
 * 3. **A mirrored pair cannot come out uneven.** One side is computed and the other is
 *    `x0 + x1 - x` of it. Both halves are one expression, so there is no second set of numbers to
 *    disagree with the first.
 *
 * **It emits `VoxOp[]` and nothing downstream learns a new word.** `rasterise → finish` still
 * reproduces the asset from the record exactly, which is the property the whole generation path is
 * built on; `score.ts`, `finish.ts`, `palette.ts` and the `.gpix` are untouched.
 *
 * Two things are deliberately *not* in the language:
 *
 * - **No `ball`, and no tapered part.** Every guarantee above is a statement about boxes: these two
 *   ranges overlap, therefore these two solids share a face. An ellipsoid's bottom layer is one cell
 *   wide at the centre column, so legs placed at the edges of its footprint would hang in air — and
 *   a guarantee that holds for boxes and quietly fails for balls is not a guarantee. Shrinking tiers
 *   are chained `attach` calls instead, which keeps the overlap clamp doing the work. Roundness is
 *   §3's problem (two silhouettes, intersected), not this module's.
 * - **No `mirrorX()`.** The op language's global mirror folds the grid about its own centre, and a
 *   rig is already built about its root. Symmetry here is per-pair and local, for the reason spelled
 *   out on `mirrored` below.
 *
 * `box` and `erase` stay as an escape hatch, in the rig's own frame, for windows, doors, spots and
 * carving. §2 records the failure mode to watch: **if the replies come back as nothing but `box`,
 * the idea is dead** — so the prompt says what the hatch is for, in the same breath as why a mass
 * placed with `box` can miss the body while one placed with `attach` cannot.
 *
 * Nothing here knows about the flag that turns it on, about `llama.ts`, or about the bank. It is
 * arithmetic over a list.
 */

/** Which face of a part something hangs off. */
export type Face = '+x' | '-x' | '+y' | '-y' | '+z' | '-z'

/**
 * A placed mass, in the rig's own frame, with its box spelled out.
 *
 * Scalar fields rather than two `Vec3`s, for the reply's sake: `erase(top.x0 + 1, top.y1, …)` reads
 * as a sentence about the crown and `erase(top.lo[0] + 1, top.hi[1], …)` reads as array indexing.
 * The examples are the ceiling (finding 7), so what they look like is a feature and not a taste.
 *
 * They are also the only honest way to reach the escape hatch. A detail whose numbers are read off a
 * part it can see is still relational; a literal coordinate is the thing this module exists to take
 * away.
 */
export interface Part {
    readonly name: string
    readonly color: string
    readonly x0: number
    readonly y0: number
    readonly z0: number
    readonly x1: number
    readonly y1: number
    readonly z1: number
    readonly w: number
    readonly h: number
    readonly d: number
}

/**
 * What `attach` and `pair` take.
 *
 * `dx`/`dy`/`dz` slide the mass across the face it sits on. The one that names the face's own axis is
 * **read and discarded**, and that is the first guarantee: there is no way to spell a gap. `sink`
 * pushes the mass *into* the parent, which can only ever increase the overlap, and at `sink` equal to
 * the mass's own size along the face it is a recolour of a band of the parent rather than a new lump.
 */
export interface Attached {
    readonly w?: number
    readonly h?: number
    readonly d?: number
    readonly color?: string
    readonly dx?: number
    readonly dy?: number
    readonly dz?: number
    readonly sink?: number
}

export interface Legs {
    /** 2 or 4. Anything else lands on one of those, because the pair is the unit. */
    readonly count?: number
    readonly length?: number
    readonly thick?: number
    /** Front to back. Defaults to `thick`, so a leg is square in plan unless asked otherwise. */
    readonly deep?: number
    /** In from the parent's own edges, in cells. Clamped so a pair cannot cross the middle. */
    readonly inset?: number
    /** Front-to-back nudge for a two-legged bird, whose feet sit under the belly and not the middle. */
    readonly dz?: number
    readonly color?: string
    /** Recolours the bottom of each leg, which is how a hoof or a boot is spelled. */
    readonly foot?: string
}

export interface Arms {
    readonly length?: number
    readonly thick?: number
    readonly deep?: number
    /** How far below the top of the parent the shoulder sits. Clamped to inside the parent. */
    readonly drop?: number
    readonly color?: string
    /** Recolours the bottom of each arm. */
    readonly hand?: string
}

/**
 * The builder.
 *
 * `ops` is computed on read, because the floor is not known until the last call has landed: a leg's
 * length is a request, and what it is finally cut to is a property of the whole rig rather than of
 * the call that asked for it.
 */
export interface Rig {
    readonly ops: readonly VoxOp[]
    /** A mass standing on the floor, centred on the rig's own axis. The first one defines that axis. */
    readonly part: (name: string, w: number, h: number, d: number, color: string) => Part
    /** A mass flush against one face of `parent`, centred on it unless slid. */
    readonly attach: (name: string, parent: Part, face: Face, opts: Attached) => Part
    /** Two of those, reflected about the parent's own middle in x. */
    readonly pair: (name: string, parent: Part, face: Face, opts: Attached) => readonly [Part, Part]
    /** A mirrored pair, or two pairs, under `parent` — cut to reach the floor. */
    readonly legs: (parent: Part, opts: Legs) => void
    /** A mirrored pair hanging off the parent's left and right faces. */
    readonly arms: (parent: Part, opts: Arms) => void
    /** The escape hatch, in the rig's frame. Detail, not masses. */
    readonly box: (
        x0: number,
        y0: number,
        z0: number,
        x1: number,
        y1: number,
        z1: number,
        color: string
    ) => void
    readonly erase: (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => void
}

/**
 * The names the reply's functions are bound to, in the order `scopeFor` hands the values over.
 *
 * One list, so a caller building a `new Function` cannot pair the names with the values in a
 * different order. What that failure produces is a rig that runs, paints, and is the wrong model.
 */
export const RIG_NAMES = ['part', 'attach', 'pair', 'legs', 'arms', 'box', 'erase'] as const

export const scopeFor = (built: Rig): readonly unknown[] => [
    built.part,
    built.attach,
    built.pair,
    built.legs,
    built.arms,
    built.box,
    built.erase
]

/**
 * The biggest a single mass may be, and the most masses one reply may place.
 *
 * 128 is the largest canvas the app offers, so anything past it is off the grid whatever it is. It is
 * a clamp and not a throw because this runs on a 27B model's output, and a mistyped width should cost
 * a proportion rather than a candidate — `readSpec` makes the same trade one layer down.
 */
const MAX_EXTENT = 128
const MAX_PARTS = 256
/** Matches `code.ts`'s op budget, for the same reason: a runaway loop has to end in a model. */
const MAX_SOLIDS = 4096
/** Past this a raw coordinate is a typo rather than a place, and the op is dropped. */
const COORD_LIMIT = 512

const FALLBACK_COLOR = '#808080'

/**
 * A number, clamped into a range — and **the fallback is clamped too**.
 *
 * A default that skips the bound is a bound with a hole in it: `deep` defaults to `thick`, and a leg
 * two cells thick under a body one cell deep would otherwise come back two cells deep on the strength
 * of never having been asked for.
 */
const whole = (value: unknown, lo: number, hi: number, fallback: number): number => {
    const raw = typeof value === 'number' && Number.isFinite(value) ? value : fallback
    return Math.min(hi, Math.max(lo, Math.round(raw)))
}

const HEX6 = /^#[0-9a-f]{6}$/i
const HEX3 = /^#[0-9a-f]{3}$/i

/**
 * A colour, or the fallback — never a dropped part.
 *
 * `readSpec` drops an op whose colour will not read, which is right one layer down where the op *is*
 * the colour. Here the op is a shape the model got right, and throwing a shape away over a typo in a
 * hex string loses exactly the thing this module was built to protect.
 */
const colour = (value: unknown, fallback: string): string => {
    if (typeof value !== 'string') return fallback
    const text = value.trim()
    if (HEX6.test(text)) return text.toLowerCase()
    if (HEX3.test(text)) {
        const r = text.charAt(1)
        const g = text.charAt(2)
        const b = text.charAt(3)
        return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
    }
    return fallback
}

interface Axis {
    readonly axis: 0 | 1 | 2
    readonly sign: 1 | -1
}

const FACES: Readonly<Record<Face, Axis>> = {
    '+x': {axis: 0, sign: 1},
    '-x': {axis: 0, sign: -1},
    '+y': {axis: 1, sign: 1},
    '-y': {axis: 1, sign: -1},
    '+z': {axis: 2, sign: 1},
    '-z': {axis: 2, sign: -1}
}

/** An unreadable face is the top of the parent, which is the one face nothing can end up under. */
const faceOf = (value: unknown): Axis => {
    if (typeof value === 'string' && Object.hasOwn(FACES, value)) return FACES[value as Face]
    return FACES['+y']
}

/** Where a run of `len` starts when it is centred on a run of `plen` starting at `plo`. */
const centreStart = (plo: number, plen: number, len: number): number =>
    plo + Math.floor((plen - len) / 2)

/**
 * `start`, moved the least distance that leaves `[start, start + len - 1]` sharing a cell with
 * `[plo, phi]`.
 *
 * This is the whole of "a part cannot float", and it is one line because it is one question. A slide
 * along a face is honest right up to the point where it slides off, and past that the model has said
 * something it cannot have meant.
 */
const clampStart = (start: number, len: number, plo: number, phi: number): number =>
    Math.min(phi, Math.max(plo - len + 1, start))

const partAt = (name: string, color: string, lo: Vec3, hi: Vec3): Part => ({
    name,
    color,
    x0: lo[0],
    y0: lo[1],
    z0: lo[2],
    x1: hi[0],
    y1: hi[1],
    z1: hi[2],
    w: hi[0] - lo[0] + 1,
    h: hi[1] - lo[1] + 1,
    d: hi[2] - lo[2] + 1
})

/** One box in the rig's frame. A `color` of `undefined` is a carve. */
interface Solid {
    readonly lo: Vec3
    readonly hi: Vec3
    readonly color: string | undefined
}

/** What `legs` asked for. Held rather than resolved, because the floor is not known yet. */
interface LegPlan {
    readonly parent: Part
    readonly count: number
    readonly length: number
    readonly thick: number
    readonly deep: number
    readonly inset: number
    readonly dz: number
    readonly color: string
    readonly foot: string | undefined
}

type Step = {readonly solid: Solid} | {readonly plan: LegPlan}

const isPlan = (step: Step): step is {readonly plan: LegPlan} => 'plan' in step

/**
 * A raw corner, or `undefined` for one that is not a place.
 *
 * Dropped rather than clamped, which is `ops.ts`'s rule and its reasoning: clamping smears a
 * mistyped coordinate along a wall, and a smear looks like geometry where a hole looks like an
 * error. The relational calls clamp instead, because there the number is a *size* and the shape
 * survives being clamped; the hatch drops, because there the number is a *place* and there is
 * nothing to salvage.
 */
const corner = (x: unknown, y: unknown, z: unknown): Vec3 | undefined => {
    const out: Vec3 = [0, 0, 0]
    const given: readonly unknown[] = [x, y, z]
    for (const [at, value] of given.entries()) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
        const rounded = Math.round(value)
        if (Math.abs(rounded) > COORD_LIMIT) return undefined
        out[at] = rounded
    }
    return out
}

/**
 * The floor: the lowest cell anything in the rig would paint, legs included.
 *
 * Legs count by what they *asked for*, so a long leg lowers the floor; everything else counts by
 * where it already is. Whichever is lower wins, and that is what makes the leg reach it.
 */
const floorOf = (steps: readonly Step[]): number => {
    let low = Infinity
    for (const step of steps) {
        if (isPlan(step)) low = Math.min(low, step.plan.parent.y0 - step.plan.length)
        else if (step.solid.color !== undefined) low = Math.min(low, step.solid.lo[1])
    }
    return Number.isFinite(low) ? low : 0
}

/**
 * A leg plan, cut to the floor.
 *
 * The top is flush under the parent and the bottom *is* the floor — not the requested length, the
 * floor. If some other part of the rig hangs lower than the legs were told to be, the legs grow to
 * meet it rather than the figure being lifted onto stilts of air. That trade is the right way round:
 * a long tail makes a tall dog, where the alternative makes a floating one.
 */
const legSolids = (plan: LegPlan, ground: number): readonly Solid[] => {
    const {parent} = plan
    const top = parent.y0 - 1
    const bottom = Math.min(ground, top)
    const plane = parent.x0 + parent.x1
    const near = parent.x0 + plan.inset
    const far = near + plan.thick - 1
    const across: readonly (readonly [number, number])[] = [
        [near, far],
        [plane - far, plane - near]
    ]
    const centred = clampStart(
        centreStart(parent.z0, parent.d, plan.deep) + plan.dz,
        plan.deep,
        parent.z0,
        parent.z1
    )
    const along: readonly (readonly [number, number])[] =
        plan.count >= 4 ?
            [
                [parent.z0 + plan.inset, parent.z0 + plan.inset + plan.deep - 1],
                [parent.z1 - plan.inset - plan.deep + 1, parent.z1 - plan.inset]
            ]
        :   [[centred, centred + plan.deep - 1]]
    const out: Solid[] = []
    for (const [x0, x1] of across) {
        for (const [z0, z1] of along) {
            out.push({lo: [x0, bottom, z0], hi: [x1, top, z1], color: plan.color})
            if (plan.foot !== undefined) {
                const cap = Math.min(2, top - bottom + 1)
                out.push({lo: [x0, bottom, z0], hi: [x1, bottom + cap - 1, z1], color: plan.foot})
            }
        }
    }
    return out
}

/**
 * Steps to ops, in one pass, translated so the model stands at the origin with its feet at `y = 0`.
 *
 * The translation is what makes "feet at y=0" true rather than merely asked for. `gridFor` fits the
 * grid to the ops anyway, so it changes no pixel — it changes what the numbers in the *record* mean,
 * and it is what lets a test read the invariant straight off `rig().ops` instead of off a rasterised
 * volume.
 *
 * Carves do not move the origin, matching `paintedBounds`: an `erase` reaching outside the model says
 * nothing about how big the model is.
 */
const emit = (steps: readonly Step[]): readonly VoxOp[] => {
    const ground = floorOf(steps)
    const solids: Solid[] = []
    for (const step of steps) {
        if (isPlan(step)) solids.push(...legSolids(step.plan, ground))
        else solids.push(step.solid)
    }
    const low: Vec3 = [Infinity, Infinity, Infinity]
    for (const solid of solids) {
        if (solid.color === undefined) continue
        for (const a of [0, 1, 2] as const) low[a] = Math.min(low[a], solid.lo[a])
    }
    const shift: Vec3 = [0, 0, 0]
    for (const a of [0, 1, 2] as const) shift[a] = Number.isFinite(low[a]) ? -low[a] : 0
    return solids.map(solid => {
        const from: Vec3 = [solid.lo[0] + shift[0], solid.lo[1] + shift[1], solid.lo[2] + shift[2]]
        const to: Vec3 = [solid.hi[0] + shift[0], solid.hi[1] + shift[1], solid.hi[2] + shift[2]]
        return solid.color === undefined ?
                {op: 'erase' as const, from, to}
            :   {op: 'box' as const, from, to, color: solid.color}
    })
}

/** A fresh builder. Every call on it is total: nothing here throws, whatever the reply passes. */
export const rig = (): Rig => {
    const steps: Step[] = []
    let root: Part | undefined
    let parts = 0

    const room = (): boolean => steps.length < MAX_SOLIDS && parts < MAX_PARTS
    const paint = (lo: Vec3, hi: Vec3, color: string | undefined): void => {
        if (steps.length < MAX_SOLIDS) steps.push({solid: {lo, hi, color}})
    }

    /**
     * The mirror of a run of x, about the parent's own middle rather than about the rig's.
     *
     * `plo + phi - x` maps integers to integers whatever the parent's width is, odd or even, which is
     * why the plane is carried as a sum and never as a centre. It is local rather than global because
     * a pair has to stay *on the part it hangs from*: reflecting a wing about the body's axis when
     * the shoulder it grows from is off-centre would put the second wing in the air, and touching is
     * worth more than a figure being symmetric about one plane end to end.
     */
    const mirrored = (parent: Part, lo: Vec3, hi: Vec3): {lo: Vec3; hi: Vec3} => {
        const plane = parent.x0 + parent.x1
        return {lo: [plane - hi[0], lo[1], lo[2]], hi: [plane - lo[0], hi[1], hi[2]]}
    }

    const boxFor = (parent: Part, face: Face, opts: Attached): {lo: Vec3; hi: Vec3} => {
        const {axis, sign} = faceOf(face)
        const size: Vec3 = [
            whole(opts.w, 1, MAX_EXTENT, 1),
            whole(opts.h, 1, MAX_EXTENT, 1),
            whole(opts.d, 1, MAX_EXTENT, 1)
        ]
        const slide: Vec3 = [
            whole(opts.dx, -MAX_EXTENT, MAX_EXTENT, 0),
            whole(opts.dy, -MAX_EXTENT, MAX_EXTENT, 0),
            whole(opts.dz, -MAX_EXTENT, MAX_EXTENT, 0)
        ]
        const plo: Vec3 = [parent.x0, parent.y0, parent.z0]
        const phi: Vec3 = [parent.x1, parent.y1, parent.z1]
        const plen: Vec3 = [parent.w, parent.h, parent.d]
        // Sunk by at most its own size along the face: past that it would come out of the far side,
        // which is the one way "pushed further in" could turn back into "floating".
        const sink = whole(opts.sink, 0, size[axis], 0)
        const lo: Vec3 = [0, 0, 0]
        const hi: Vec3 = [0, 0, 0]
        for (const a of [0, 1, 2] as const) {
            // The face's own axis is not a parameter. That is the guarantee, and it is stated once.
            lo[a] =
                a === axis ?
                    sign > 0 ?
                        phi[a] + 1 - sink
                    :   plo[a] - size[a] + sink
                :   clampStart(
                        centreStart(plo[a], plen[a], size[a]) + slide[a],
                        size[a],
                        plo[a],
                        phi[a]
                    )
            hi[a] = lo[a] + size[a] - 1
        }
        return {lo, hi}
    }

    const named = (name: unknown): string =>
        typeof name === 'string' && name !== '' ? name : 'part'

    return {
        get ops(): readonly VoxOp[] {
            return emit(steps)
        },

        part: (name, w, h, d, color) => {
            const size: Vec3 = [
                whole(w, 1, MAX_EXTENT, 1),
                whole(h, 1, MAX_EXTENT, 1),
                whole(d, 1, MAX_EXTENT, 1)
            ]
            const skin = colour(color, FALLBACK_COLOR)
            /*
             * The first mass defines the rig's frame: it starts at the origin, and the prompt says so
             * in as many words, because that is what makes the `box`/`erase` hatch usable without the
             * model inventing absolute numbers.
             *
             * A later `part` is centred on the first and stands on the same floor, so a second
             * free-standing mass is on the axis rather than wherever it happened to land.
             */
            const lo: Vec3 =
                root === undefined ?
                    [0, 0, 0]
                :   [
                        centreStart(root.x0, root.w, size[0]),
                        0,
                        centreStart(root.z0, root.d, size[2])
                    ]
            const made = partAt(named(name), skin, lo, [
                lo[0] + size[0] - 1,
                lo[1] + size[1] - 1,
                lo[2] + size[2] - 1
            ])
            if (!room()) return made
            parts += 1
            root ??= made
            paint([made.x0, made.y0, made.z0], [made.x1, made.y1, made.z1], skin)
            return made
        },

        attach: (name, parent, face, opts) => {
            const skin = colour(opts.color, parent.color)
            const {lo, hi} = boxFor(parent, face, opts)
            const made = partAt(named(name), skin, lo, hi)
            if (!room()) return made
            parts += 1
            paint(lo, hi, skin)
            return made
        },

        pair: (name, parent, face, opts) => {
            const skin = colour(opts.color, parent.color)
            const one = boxFor(parent, face, opts)
            const other = mirrored(parent, one.lo, one.hi)
            const made: readonly [Part, Part] = [
                partAt(named(name), skin, one.lo, one.hi),
                partAt(named(name), skin, other.lo, other.hi)
            ]
            if (!room()) return made
            parts += 2
            paint(one.lo, one.hi, skin)
            paint(other.lo, other.hi, skin)
            return made
        },

        legs: (parent, opts) => {
            const count = whole(opts.count, 2, 4, 2) >= 3 ? 4 : 2
            // Half the parent's width is the cap, so a "pair" is always two legs and never one slab.
            const thick = whole(opts.thick, 1, Math.max(1, Math.floor(parent.w / 2)), 2)
            const deep = whole(opts.deep, 1, parent.d, thick)
            /*
             * The inset is bounded by the half-width, so the two legs of a pair cannot cross the
             * middle and become one block. Depth only bounds it when there are two pairs — with one
             * pair the legs are centred front-to-back and the parent's depth has no say.
             */
            const acrossCap = Math.max(0, Math.floor(parent.w / 2) - thick)
            const alongCap = count >= 4 ? Math.max(0, Math.floor(parent.d / 2) - deep) : acrossCap
            const inset = whole(opts.inset, 0, Math.min(acrossCap, alongCap), 0)
            if (!room()) return
            parts += count
            steps.push({
                plan: {
                    parent,
                    count,
                    length: whole(opts.length, 1, MAX_EXTENT, 4),
                    thick,
                    deep,
                    inset,
                    dz: whole(opts.dz, -MAX_EXTENT, MAX_EXTENT, 0),
                    color: colour(opts.color, parent.color),
                    foot: opts.foot === undefined ? undefined : colour(opts.foot, parent.color)
                }
            })
        },

        arms: (parent, opts) => {
            const thick = whole(opts.thick, 1, MAX_EXTENT, 2)
            const deep = whole(opts.deep, 1, parent.d, Math.min(2, parent.d))
            const length = whole(opts.length, 1, MAX_EXTENT, 4)
            // The shoulder is inside the parent by construction, so an arm is joined at the top
            // whatever it is told to hang past at the bottom.
            const top = parent.y1 - whole(opts.drop, 0, parent.h - 1, 0)
            const bottom = top - length + 1
            const skin = colour(opts.color, parent.color)
            const hand = opts.hand === undefined ? undefined : colour(opts.hand, skin)
            const z0 = clampStart(
                centreStart(parent.z0, parent.d, deep),
                deep,
                parent.z0,
                parent.z1
            )
            const z1 = z0 + deep - 1
            const sides: readonly (readonly [number, number])[] = [
                [parent.x1 + 1, parent.x1 + thick],
                [parent.x0 - thick, parent.x0 - 1]
            ]
            if (!room()) return
            parts += 2
            for (const [x0, x1] of sides) {
                paint([x0, bottom, z0], [x1, top, z1], skin)
                if (hand !== undefined) {
                    paint([x0, bottom, z0], [x1, bottom + Math.min(2, length) - 1, z1], hand)
                }
            }
        },

        box: (x0, y0, z0, x1, y1, z1, color) => {
            const lo = corner(x0, y0, z0)
            const hi = corner(x1, y1, z1)
            if (lo === undefined || hi === undefined) return
            paint(
                [Math.min(lo[0], hi[0]), Math.min(lo[1], hi[1]), Math.min(lo[2], hi[2])],
                [Math.max(lo[0], hi[0]), Math.max(lo[1], hi[1]), Math.max(lo[2], hi[2])],
                colour(color, FALLBACK_COLOR)
            )
        },

        erase: (x0, y0, z0, x1, y1, z1) => {
            const lo = corner(x0, y0, z0)
            const hi = corner(x1, y1, z1)
            if (lo === undefined || hi === undefined) return
            paint(
                [Math.min(lo[0], hi[0]), Math.min(lo[1], hi[1]), Math.min(lo[2], hi[2])],
                [Math.max(lo[0], hi[0]), Math.max(lo[1], hi[1]), Math.max(lo[2], hi[2])],
                undefined
            )
        }
    }
}

/**
 * The system prompt for this language, with the cube it asks for.
 *
 * Structurally `llama.ts`'s `systemFor`: the same canvas parameter, the same two lines carrying it,
 * the same words about axes, ordering, colour contrast and planning in a comment first. What is
 * different is the function list and the two paragraphs saying why the calls exist — because a model
 * that reverts to `box` has thrown the whole idea away, and the one thing in a prompt that can stop
 * it is being told, next to the hatch, what the hatch is *for*.
 *
 * The guarantees are written as promises ("worked out for you", "cut to reach the floor") rather than
 * as instructions, on finding 7's reasoning: rules in prose do not survive a reply that starts
 * emitting on its first token, and the only rule worth the tokens is one that describes what the code
 * is going to do anyway.
 */
export const rigSystemFor = (canvas: number): string => {
    const cube = `${String(canvas)}x${String(canvas)}x${String(canvas)}`
    return `You write JavaScript that builds a voxel model. You give sizes and attachments; the
coordinates are worked out for you. These functions exist already:
  part(name, w, h, d, "#rrggbb")     a mass standing on the floor, centred left to right
  attach(name, parent, face, opts)   a mass flush against one face of a part you already made
  pair(name, parent, face, opts)     two of them, mirrored left/right - eyes, ears, wings, horns
  legs(parent, opts)                 {count: 2 or 4, length, thick, deep, inset, dz, color, foot}
  arms(parent, opts)                 {length, thick, deep, drop, color, hand}
  box(x0,y0,z0, x1,y1,z1, "#rrggbb") solid box, for detail the calls above cannot place
  erase(x0,y0,z0, x1,y1,z1)          carve empty space

face is one of "+x" "-x" "+y" "-y" "+z" "-z". attach and pair take
  {w, h, d, color, dx, dy, dz, sink}
w/h/d are the size. dx/dy/dz slide it along the face; the one naming the face's own axis is ignored,
which is what keeps the part touching. sink pushes it into the parent - a sink equal to its own size
recolours a band of the parent, which is how you draw a base course or a collar.

part, attach and pair return the part, so build a chain: the brim on the head, then the crown on the
brim, then a spot on the crown. legs and arms return nothing - they are cut to reach the floor and to
hang from the shoulder, and each comes out as a mirrored pair of equal limbs.

Axes: x = left/right, y = up/down (bigger y is higher), z = front/back. Feet at y=0.
box and erase work in the first part's own frame: it starts at x=0, y=0, z=0 and is w-1, h-1, d-1
across. Read their numbers off a part you already made - erase(top.x0+1, top.y1, top.z0, top.x1-1,
top.y1, top.z1) - and use them for windows, doors, spots and carving. Do not build the masses with
box: a mass placed with box can miss the body, and a mass placed with attach cannot.
Keep everything inside ${cube}. The finished model should be close to ${String(canvas)} tall and fill
most of that box - scale the proportions up to it rather than drawing a small model in a corner.
Use variables and loops where they help symmetry and repetition.
Calls apply in order; later ones paint over earlier ones.
Block out the big masses first, then the limbs, then the small details.
Use 4-8 distinct colors with real value contrast, not near-identical shades.
Plan the proportions in a short comment first, then the code.
Answer with only JavaScript, no markdown fence.`
}

/** What the model is asked for when nothing has enforced a canvas — the size everything was measured at. */
export const RIG_SYSTEM = rigSystemFor(MAX_SIZE)

/**
 * The five worked examples, in this language. The same five ids as `builtin.ts`.
 *
 * **These are the ceiling, and they are the most important thing in this file.** Finding 7 measured
 * one worked example as worth more than every rule in the system prompt — 0 recognisable of 12 became
 * 4 of 4 — and finding 8 measured the other direction, where the wrong single example dragged every
 * output into its own body plan. §2 says the same thing in one line: a new language starts life with
 * five badly written examples in it, so write the examples first and only then measure the language.
 *
 * Each demonstrates the language once, and nothing else:
 *
 * - **dog** — four legs, and a head chained off the body rather than placed near it.
 * - **chicken** — two legs and a neck, so the body plan the dog would otherwise teach is not the only
 *   one in the bank. This is finding 8 in a file: with only the dog, "a chicken" came back with four.
 * - **farmer** — `arms`, a hat built as a chain (head → brim → crown), and a `sink` collar.
 * - **mushroom** — no limbs at all, and shrinking tiers as chained `attach` calls, which is how this
 *   language draws a curve without a `ball` whose promises it cannot keep.
 * - **tower** — the escape hatch used the way the prompt describes it: every `box` and `erase` reads
 *   its numbers off a part, so even the carving is relational.
 *
 * **If you change one, render it.** `rig.test.ts` holds them to being one connected piece that is not
 * a solid brick, which is a floor and not a likeness — only eyes can say whether the dog looks like a
 * dog, and an example that does not look like what it claims teaches exactly that.
 */
export const RIG_REPLIES: Readonly<Record<string, string | undefined>> = {
    dog: `// dog: body 6 wide, 5 tall, 12 long; head chained off the front, four legs under it
const fur = '#8b5a2b', light = '#a0693a', dark = '#6f4520', eye = '#2b1a0d'
const body = part('body', 6, 5, 12, fur)
const head = attach('head', body, '+z', {w: 5, h: 5, d: 4, color: light, dy: 1})
attach('snout', head, '+z', {w: 3, h: 2, d: 2, color: light, dy: -1})
pair('ear', head, '+y', {w: 1, h: 2, d: 2, color: dark, dx: 2})
pair('eye', head, '+z', {w: 1, h: 1, d: 1, color: eye, dx: 1, dy: 1})
attach('tail', body, '-z', {w: 2, h: 2, d: 3, color: light, dy: 1})
legs(body, {count: 4, length: 5, thick: 2, color: fur, foot: dark})`,

    chicken: `// chicken: fat body 7x6x8, neck and head high at the front, two thin legs
const feather = '#f2e3c8', wing = '#d8c4a0', shank = '#e08a2c'
const comb = '#cc2b2b', eye = '#2b2b28'
const body = part('body', 7, 6, 8, feather)
const neck = attach('neck', body, '+y', {w: 3, h: 2, d: 3, color: feather, dz: 2})
const head = attach('head', neck, '+y', {w: 4, h: 3, d: 4, color: feather})
attach('comb', head, '+y', {w: 1, h: 2, d: 3, color: comb})
attach('beak', head, '+z', {w: 1, h: 1, d: 2, color: shank})
pair('eye', head, '+z', {w: 1, h: 1, d: 1, color: eye, dx: 2})
pair('wing', body, '+x', {w: 1, h: 4, d: 6, color: wing})
attach('tail', body, '-z', {w: 5, h: 3, d: 2, color: wing, dy: 2})
legs(body, {count: 2, length: 5, thick: 1, inset: 2, color: shank})`,

    farmer: `// farmer: torso 9x8x5, head on top, hat chained off the head, legs down to the floor
const skin = '#e0b088', shirt = '#4a7a3a', pants = '#5a4632'
const hat = '#d8b84a', eye = '#2b2b28'
const torso = part('torso', 9, 8, 5, shirt)
const head = attach('head', torso, '+y', {w: 5, h: 6, d: 5, color: skin})
const brim = attach('brim', head, '+y', {w: 7, h: 1, d: 7, color: hat})
attach('crown', brim, '+y', {w: 5, h: 2, d: 5, color: hat})
attach('collar', head, '-y', {w: 5, h: 1, d: 5, color: shirt, sink: 1})
pair('eye', head, '+z', {w: 1, h: 1, d: 1, color: eye, dx: 1, dy: 1})
arms(torso, {length: 7, thick: 2, color: shirt, hand: skin})
legs(torso, {count: 2, length: 10, thick: 3, inset: 1, color: pants})`,

    mushroom: `// mushroom: pale stalk 4x9x4, cap in three shrinking tiers, white spots on the rim
const pale = '#efe6d2', red = '#c0392b', dark = '#a5301f'
const gill = '#d8cbb0', spot = '#ffffff'
const stalk = part('stalk', 4, 9, 4, pale)
const gills = attach('gills', stalk, '+y', {w: 6, h: 1, d: 6, color: gill})
const brim = attach('cap', gills, '+y', {w: 11, h: 2, d: 9, color: red})
const mid = attach('cap', brim, '+y', {w: 9, h: 2, d: 7, color: red})
attach('top', mid, '+y', {w: 5, h: 1, d: 5, color: dark})
pair('spot', brim, '+z', {w: 2, h: 1, d: 1, color: spot, dx: 3})
pair('spot', brim, '-z', {w: 2, h: 1, d: 1, color: spot, dx: 2})
attach('spot', mid, '+z', {w: 2, h: 1, d: 1, color: spot})`,

    tower: `// tower: shaft 8x20x8, darker base course, battlemented crown, door and windows
const stone = '#8a8a86', base = '#6f6f6b', cap = '#77776f', dark = '#2b2b28'
const shaft = part('shaft', 8, 20, 8, stone)
attach('base course', shaft, '-y', {w: 8, h: 3, d: 8, color: base, sink: 3})
const top = attach('crown', shaft, '+y', {w: 10, h: 3, d: 10, color: cap})
erase(top.x0 + 1, top.y0 + 1, top.z0 + 1, top.x1 - 1, top.y1, top.z1 - 1)
for (const c of [2, 6]) {                       // battlement gaps, all four sides
    erase(top.x0 + c, top.y1, top.z0, top.x0 + c + 1, top.y1, top.z1)
    erase(top.x0, top.y1, top.z0 + c, top.x1, top.y1, top.z0 + c + 1)
}
erase(shaft.x0 + 3, shaft.y0, shaft.z0, shaft.x0 + 4, shaft.y0 + 4, shaft.z0)
box(shaft.x0 + 3, shaft.y0 + 8, shaft.z0, shaft.x0 + 4, shaft.y0 + 10, shaft.z0, dark)
box(shaft.x0, shaft.y0 + 13, shaft.z0 + 3, shaft.x0, shaft.y0 + 15, shaft.z0 + 4, dark)
box(shaft.x0 + 3, shaft.y0 + 16, shaft.z1, shaft.x0 + 4, shaft.y0 + 18, shaft.z1, dark)`
}
