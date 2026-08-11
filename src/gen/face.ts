import type {Vec3, VoxOp} from './ops'

/**
 * The face language: one side of the model, addressed in 2D.
 *
 * It exists because of a measurement, 2026-08-11, on "a Mario brick block". The model writes
 * perfectly sensible code for a block — mortar lines, a top highlight, a side shadow — and three
 * separate parts of this pipeline threw it away. Two of them are scoring (`overallScore` ranks by
 * `1 - bboxFill`; `gate.ts` calls anything over 80 % solid a brick, and the runs came back at 83 %
 * and 95 %). The third is this one, and it is the one that could not be fixed by relaxing a number:
 *
 * **A block is all surface.** Its silhouette is a square, and every bit of information in it is the
 * pattern on its faces. The op language paints *solids*, so the model painted its mortar lines
 * straight through the middle of the cube, where nothing can ever see them. Half of what a sprite
 * sheet needs — blocks, tiles, crates, props — is that subject, and nothing in `src/gen/` could
 * address a face.
 *
 * Three rules are the design:
 *
 * 1. **A face is a side of the box of what has already been painted.** The scope is handed the live
 *    op list, so `face('+z', …)` measures the solid the lines above it painted. That makes "block it
 *    out first, then paint the faces" a real rule rather than a style note, and it is the rule the
 *    prompt has to state. With nothing painted there is no box, so `face` does nothing.
 * 2. **`(u, v)` is 2D, and that is the whole point.** SpatialBabel measures precise 3D coordinate
 *    output from an LLM as near-zero; a face takes one dimension away. `v` is *up* on all four side
 *    faces, which is what makes `bevel`'s "light on top" mean anything. On the top and bottom faces
 *    up has no meaning and `v` is depth, so a bevel there is a border ring. That asymmetry is real
 *    and is not worth hiding.
 * 3. **Marks are arithmetic, never a grid of characters.** `bevel`, `courses`, `studs` and `rect`
 *    take numbers. VGBench finds open-weight models weakest at exactly the low-level 2D output an
 *    ASCII grid would need, and alignment is the thing that fails — the same call `shape.ts` made
 *    when it took row spans instead of an outline picture.
 *
 * Everything emits ordinary `box` ops, so nothing downstream learns a new word and
 * `rasterise → finish` still reproduces the asset from the record.
 */
export type FaceName = '+x' | '-x' | '+y' | '-y' | '+z' | '-z'

const FACES: readonly FaceName[] = ['+x', '-x', '+y', '-y', '+z', '-z']

/** How deep a face paints by default. One voxel: a surface is a surface. */
export const FACE_DEPTH = 1

/** The most cells one `line` may walk, so a diagonal on a bad number cannot run away. */
const LINE_CELLS = 512

const GREY = '#808080'

const isHex = (value: unknown): value is string =>
    typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)

const whole = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback

/**
 * The box of what the painting ops cover so far.
 *
 * Deliberately a second derivation of `ops.ts`'s `paintedBounds`, which is private to that module.
 * `erase` is excluded here for the same reason it is excluded there: it removes, so it must not be
 * able to grow the box — a reply that carves the whole canvas to "start empty" would otherwise give
 * every face the size of the grid.
 */
const paintedBox = (ops: readonly VoxOp[]): {lo: Vec3; hi: Vec3} | undefined => {
    let lo: Vec3 | undefined
    let hi: Vec3 | undefined
    for (const op of ops) {
        if (op.op === 'erase') continue
        const [ax, ay, az] = op.op === 'box' ? op.from : op.at
        const [bx, by, bz] = op.op === 'box' ? op.to : op.at
        const [rx, ry, rz] = op.op === 'ball' ? op.r : ([0, 0, 0] as Vec3)
        const low: Vec3 = [Math.min(ax, bx) - rx, Math.min(ay, by) - ry, Math.min(az, bz) - rz]
        const high: Vec3 = [Math.max(ax, bx) + rx, Math.max(ay, by) + ry, Math.max(az, bz) + rz]
        if (!lo || !hi) {
            lo = low
            hi = high
            continue
        }
        lo = [Math.min(lo[0], low[0]), Math.min(lo[1], low[1]), Math.min(lo[2], low[2])]
        hi = [Math.max(hi[0], high[0]), Math.max(hi[1], high[1]), Math.max(hi[2], high[2])]
    }
    if (!lo || !hi) return undefined
    return {
        lo: [Math.round(lo[0]), Math.round(lo[1]), Math.round(lo[2])],
        hi: [Math.round(hi[0]), Math.round(hi[1]), Math.round(hi[2])]
    }
}

/**
 * What the reply may do inside a `face` call.
 *
 * `width` and `height` are handed over because the reply has to be able to loop to them: the face is
 * as big as the solid it is on, and the model does not otherwise know how big that came out.
 */
export interface Painter {
    readonly width: number
    readonly height: number
    readonly rect: (u0: unknown, v0: unknown, u1: unknown, v1: unknown, color: unknown) => void
    readonly line: (u0: unknown, v0: unknown, u1: unknown, v1: unknown, color: unknown) => void
    readonly dot: (u: unknown, v: unknown, color: unknown) => void
    /** Lighter along the high-`v` and low-`u` edges, darker along the other two. */
    readonly bevel: (depth: unknown, light: unknown, dark: unknown) => void
    /** Staggered mortar lines — the thing that makes a surface read as brickwork rather than a grid. */
    readonly courses: (rows: unknown, cols: unknown, color: unknown) => void
    /** Four marks inset from the corners. A Mario block is a bevel plus these. */
    readonly studs: (inset: unknown, color: unknown) => void
}

/**
 * The `face` function the reply is given, and whether it ever painted anything.
 *
 * `used()` is how the rest of the pipeline learns this candidate is a prop — `gen/llama.ts` puts it
 * on the spec as `surface`, which turns off the gate's brick rule and switches `overallScore` away
 * from silhouette. So it is true if and only if a mark actually landed: a `face` call on a model
 * with no solid under it has not declared anything.
 */
export const faceScope = (
    painted: readonly VoxOp[],
    emit: (op: VoxOp) => void,
    depth: number = FACE_DEPTH
): {readonly face: (name: unknown, draw: unknown) => void; readonly used: () => boolean} => {
    let used = false

    const face = (name: unknown, draw: unknown): void => {
        if (typeof draw !== 'function') return
        const side = FACES.find(known => known === name)
        if (side === undefined) return
        const box = paintedBox(painted)
        // No solid, no side of it. The rule this keeps is "block it out first, then paint".
        if (!box) return

        const {lo, hi} = box
        const axis =
            side[1] === 'x' ? 0
            : side[1] === 'y' ? 1
            : 2
        const outer = side.startsWith('+')
        // The two axes of the plane. `v` is y on the four sides — that is what makes "light on top"
        // mean anything — and z on the top and bottom, where up has no meaning.
        const uAxis = axis === 2 ? 0 : 2
        const vAxis = axis === 1 ? 2 : 1
        const width = hi[uAxis] - lo[uAxis] + 1
        const height = hi[vAxis] - lo[vAxis] + 1
        if (width <= 0 || height <= 0) return

        // Never through the far side: a face on a model one voxel thin is one voxel deep.
        const thick = Math.max(1, Math.min(Math.round(depth), hi[axis] - lo[axis] + 1))
        const near = outer ? hi[axis] - thick + 1 : lo[axis]
        const far = outer ? hi[axis] : lo[axis] + thick - 1

        const clampU = (value: number): number => Math.min(width - 1, Math.max(0, value))
        const clampV = (value: number): number => Math.min(height - 1, Math.max(0, value))

        /** One rectangle of the plane, as a single op. Clipped to the face, never wrapped. */
        const paint = (u0: number, v0: number, u1: number, v1: number, color: string): void => {
            const uLow = clampU(Math.min(u0, u1))
            const uHigh = clampU(Math.max(u0, u1))
            const vLow = clampV(Math.min(v0, v1))
            const vHigh = clampV(Math.max(v0, v1))
            if (Math.max(u0, u1) < 0 || Math.min(u0, u1) > width - 1) return
            if (Math.max(v0, v1) < 0 || Math.min(v0, v1) > height - 1) return
            const from: Vec3 = [0, 0, 0]
            const to: Vec3 = [0, 0, 0]
            from[axis] = near
            to[axis] = far
            from[uAxis] = lo[uAxis] + uLow
            to[uAxis] = lo[uAxis] + uHigh
            from[vAxis] = lo[vAxis] + vLow
            to[vAxis] = lo[vAxis] + vHigh
            used = true
            emit({op: 'box', from, to, color})
        }

        const rect = (u0: unknown, v0: unknown, u1: unknown, v1: unknown, color: unknown): void => {
            paint(
                whole(u0, 0),
                whole(v0, 0),
                whole(u1, 0),
                whole(v1, 0),
                isHex(color) ? color : GREY
            )
        }

        const dot = (u: unknown, v: unknown, color: unknown): void => {
            const at: [number, number] = [whole(u, 0), whole(v, 0)]
            paint(at[0], at[1], at[0], at[1], isHex(color) ? color : GREY)
        }

        const line = (u0: unknown, v0: unknown, u1: unknown, v1: unknown, color: unknown): void => {
            const ax = whole(u0, 0)
            const ay = whole(v0, 0)
            const bx = whole(u1, 0)
            const by = whole(v1, 0)
            const paintWith = isHex(color) ? color : GREY
            // Axis-aligned is the common case and is one op rather than N.
            if (ax === bx || ay === by) {
                paint(ax, ay, bx, by, paintWith)
                return
            }
            const steps = Math.min(LINE_CELLS, Math.max(Math.abs(bx - ax), Math.abs(by - ay)))
            for (let i = 0; i <= steps; i += 1) {
                const t = i / steps
                const x = Math.round(ax + (bx - ax) * t)
                const y = Math.round(ay + (by - ay) * t)
                paint(x, y, x, y, paintWith)
            }
        }

        const bevel = (thickness: unknown, light: unknown, dark: unknown): void => {
            const edge = Math.max(
                1,
                Math.min(whole(thickness, 1), Math.floor(Math.min(width, height) / 2) || 1)
            )
            const lit = isHex(light) ? light : GREY
            const shade = isHex(dark) ? dark : GREY
            // Top and left lit, bottom and right shaded: one light, high and to the left, which is
            // the convention every hand-drawn tileset uses and the one `render/light.ts` defaults to.
            paint(0, height - edge, width - 1, height - 1, lit)
            paint(0, 0, edge - 1, height - 1, lit)
            paint(0, 0, width - 1, edge - 1, shade)
            paint(width - edge, 0, width - 1, height - 1, shade)
        }

        const courses = (rows: unknown, cols: unknown, color: unknown): void => {
            const down = Math.max(1, Math.min(whole(rows, 4), Math.floor(height / 2) || 1))
            const across = Math.max(1, Math.min(whole(cols, 2), Math.floor(width / 2) || 1))
            const mortar = isHex(color) ? color : GREY
            const step = height / down
            for (let r = 1; r < down; r += 1) {
                const v = Math.round(r * step)
                paint(0, v, width - 1, v, mortar)
            }
            /*
             * Staggered, not a plain grid: alternate rows are offset half a cell, which is what a
             * running bond looks like and the difference between "brickwork" and "graph paper".
             */
            const wide = width / across
            for (let r = 0; r < down; r += 1) {
                const v0 = Math.round(r * step)
                const v1 = Math.round((r + 1) * step) - 1
                const shift = r % 2 === 0 ? 0 : wide / 2
                for (let c = 0; c < across; c += 1) {
                    const u = Math.round(c * wide + shift)
                    if (u <= 0 || u >= width - 1) continue
                    paint(u, v0, u, v1, mortar)
                }
            }
        }

        const studs = (inset: unknown, color: unknown): void => {
            const gap = Math.max(
                0,
                Math.min(whole(inset, 1), Math.floor(Math.min(width, height) / 2))
            )
            const mark = isHex(color) ? color : GREY
            for (const u of [gap, width - 1 - gap]) {
                for (const v of [gap, height - 1 - gap]) paint(u, v, u, v, mark)
            }
        }

        const painter: Painter = {width, height, rect, line, dot, bevel, courses, studs}
        ;(draw as (surface: Painter) => void)(painter)
    }

    return {face, used: () => used}
}

/**
 * The worked examples, which matter more than the code above.
 *
 * Finding 7: one worked example took "a cat" from 0 recognisable of 12 to 4 of 4, and no rule in
 * prose has ever done anything of the sort. There are two rather than one because a block and a crate
 * teach different halves — the block teaches that the solid comes first and the faces come after, and
 * the crate teaches that **different faces get different treatment**, which is the mistake a single
 * example would leave open.
 */
export const FACE_EXAMPLES: Readonly<Record<string, string | undefined>> = {
    block: `// brick block: a 16 cube, block it out first, then paint the four sides and the top
const brick = '#c2703c', light = '#e09a63', dark = '#8a4a24', mortar = '#5c2f16'
box(0,0,0, 15,15,15, brick)
for (const side of ['+z','-z','+x','-x']) {
    face(side, s => {
        s.courses(4, 2, mortar)      // running bond across the whole face
        s.bevel(1, light, dark)      // lit top-left edge, shaded bottom-right
        s.studs(1, light)            // the four corner marks
    })
}
face('+y', s => {
    s.rect(0,0, s.width-1, s.height-1, light)   // the top catches the light
    s.bevel(1, light, dark)
})`,

    crate: `// wooden crate: a 16 cube, planks down the sides, boards across the lid
const wood = '#a9743f', pale = '#c9955c', shadow = '#6f4522', iron = '#4a4a4a'
box(0,0,0, 15,15,15, wood)
for (const side of ['+z','-z','+x','-x']) {
    face(side, s => {
        for (let u = 2; u < s.width - 1; u += 3) s.line(u, 0, u, s.height-1, shadow)  // plank gaps
        s.rect(0, s.height-3, s.width-1, s.height-1, pale)   // top rail
        s.rect(0, 0, s.width-1, 2, pale)                     // bottom rail
        s.bevel(1, pale, shadow)
        s.dot(1, 1, iron)                                    // nails
        s.dot(s.width-2, 1, iron)
    })
}
face('+y', s => {
    for (let v = 1; v < s.height - 1; v += 3) s.line(0, v, s.width-1, v, shadow)  // boards, crossways
    s.bevel(1, pale, shadow)
})`
}
