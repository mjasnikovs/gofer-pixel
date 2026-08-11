import {createVolume, setVoxel, voxelIndex, type Volume} from '../render/volume'

/**
 * The primitive language the model generates in, and its rasteriser.
 *
 * The model never draws pixels. That is settled dead and it is not a prompting problem — grammar
 * constraints fixed the formatting completely and it still produced 0 of 12 sprites that depicted
 * their subject (`legacy/docs/DESIGN_PROGRESS.md`, finding 1). What it *can* do is emit a short list
 * of solid primitives, which code turns into voxels. Everything downstream is then exact: the model
 * is on integer coordinates because nothing else was ever available to it.
 *
 * Carried over from `legacy/src/gen/ops.ts`, re-derived against the dense `Volume` rather than the
 * old sparse `Map`. The legacy version was pinned byte-for-byte against `legacy/py/voxgen.py`
 * because Python rasterised the same specs to score them. Nothing rasterises them twice any more,
 * and since 2026-08-11 nothing scores them with a model either, so that parity requirement is gone
 * with the second rasteriser.
 */
export type Vec3 = [number, number, number]

export interface BoxOp {
    op: 'box'
    from: Vec3
    to: Vec3
    color: string
}

export interface BallOp {
    op: 'ball'
    at: Vec3
    r: Vec3
    color: string
}

export interface EraseOp {
    op: 'erase'
    from: Vec3
    to: Vec3
}

export type VoxOp = BoxOp | BallOp | EraseOp

export interface VoxSpec {
    readonly name: string
    readonly size: Vec3
    readonly mirror_x: boolean
    readonly ops: readonly VoxOp[]
    /**
     * Whether the reply painted a *surface* — see `gen/face.ts`, and `docs/GEN_RESEARCH.md`'s brick
     * measurement for why it has to be recorded rather than guessed at.
     *
     * A block, a tile or a crate is all surface: its silhouette is a square and every bit of
     * information is the pattern on its faces. Two things downstream are built for the opposite kind
     * of subject and are wrong for this one — `overallScore` ranks by `1 - bboxFill`, and `gate.ts`
     * calls anything over 80 % solid a brick and throws it away. Measured live on "a Mario brick
     * block": the model wrote sensible code and the gate rejected it at 83 % and at 95 %.
     *
     * A reply that called `face` has *said* its information is on its surface, so this is the
     * declaration and not a switch the artist has to remember. Absent means what it has always
     * meant: judge this by its silhouette.
     *
     * It does not reach the `.gpix`, because a spec does not — `doc/save.ts` stores the
     * `GenerationRecord`, and `rasterise` needs none of this.
     */
    readonly surface?: boolean
}

/**
 * The largest grid a generated model may claim.
 *
 * 32 is the number the system prompt asks for and the number the subjects that work were validated
 * at. It is enforced here as well as asked for, because the grid a spec declares is the grid the
 * document gets — a model that answered 512 would allocate 134 million cells before anything looked
 * at it.
 */
export const MAX_SIZE = 32

const clampAxis = (value: unknown, cap: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 1
    return Math.min(cap, Math.max(1, Math.floor(value)))
}

const isTriple = (value: unknown): value is Vec3 =>
    Array.isArray(value) && value.length === 3 && value.every(entry => typeof entry === 'number')

const isHex = (value: unknown): value is string =>
    typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)

const readOp = (value: unknown): VoxOp | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const {op, from, to, at, r, color} = value as Record<string, unknown>
    if (op === 'box' && isTriple(from) && isTriple(to) && isHex(color)) return {op, from, to, color}
    if (op === 'erase' && isTriple(from) && isTriple(to)) return {op, from, to}
    if (op === 'ball' && isTriple(at) && isTriple(r) && isHex(color)) return {op, at, r, color}
    return undefined
}

/**
 * A reply narrowed into a spec, or `undefined` for anything that is not one.
 *
 * The grammar makes a malformed reply unproducible *by a server that honours it*, and this build
 * does not get to assume that: a schema the server silently ignored, a proxy in front of it, or a
 * different model behind it all arrive here as ordinary JSON. Ops that will not read are dropped
 * rather than fatal — 39 good primitives and one typo is a model, and refusing it would throw away
 * eight seconds of generation over a coordinate.
 */
export const readSpec = (value: unknown, cap: number = MAX_SIZE): VoxSpec | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const {name, size, mirror_x: mirror, ops, surface} = value as Record<string, unknown>
    if (!Array.isArray(size) || size.length !== 3 || !Array.isArray(ops)) return undefined
    const read = ops.map(readOp).filter((entry): entry is VoxOp => entry !== undefined)
    if (read.length === 0) return undefined
    return {
        name: typeof name === 'string' && name !== '' ? name : 'Generated',
        size: [clampAxis(size[0], cap), clampAxis(size[1], cap), clampAxis(size[2], cap)],
        mirror_x: mirror === true,
        ops: read,
        // Absent rather than `false`, so a spec that never mentioned a surface reads as one that
        // never mentioned it — `exactOptionalPropertyTypes` is on and the two are not the same.
        ...(surface === true ? {surface: true} : {})
    }
}

const channel = (hex: string, at: number): number => parseInt(hex.slice(at, at + 2), 16)

/**
 * The box the painting ops actually cover, in op coordinates. `undefined` when nothing paints.
 *
 * `erase` is excluded on purpose: it removes, so it must not be able to grow the grid. A model that
 * carves `[0,0,0]…[31,31,31]` to mean "start empty" would otherwise allocate the whole 32³ around a
 * model the size of a die.
 */
const paintedBounds = (ops: readonly VoxOp[]): {lo: Vec3; hi: Vec3} | undefined => {
    const lo: Vec3 = [Infinity, Infinity, Infinity]
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
    let any = false
    for (const op of ops) {
        if (op.op === 'erase') continue
        const corners: readonly Vec3[] =
            op.op === 'ball' ?
                [
                    [op.at[0] - op.r[0], op.at[1] - op.r[1], op.at[2] - op.r[2]],
                    [op.at[0] + op.r[0], op.at[1] + op.r[1], op.at[2] + op.r[2]]
                ]
            :   [op.from, op.to]
        any = true
        for (const [cx, cy, cz] of corners) {
            lo[0] = Math.min(lo[0], cx)
            lo[1] = Math.min(lo[1], cy)
            lo[2] = Math.min(lo[2], cz)
            hi[0] = Math.max(hi[0], cx)
            hi[1] = Math.max(hi[1], cy)
            hi[2] = Math.max(hi[2], cz)
        }
    }
    return any ? {lo, hi} : undefined
}

const extent = (low: number, high: number, cap: number): number =>
    Math.max(1, Math.min(cap, Math.floor(high) - Math.ceil(low) + 1))

/**
 * The grid a spec gets, which is the box its ops paint rather than the `size` it declared.
 *
 * **Unless a canvas is named, in which case the grid is that cube and the content is placed in it.**
 * That is the "Enforce canvas size" switch, and the two halves of it are separate: the model is
 * *asked* for a cube of that size by `systemFor`, and the document it becomes *is* that cube whether
 * or not the model obliged. Fitting the grid to the ops is still what decides where the content
 * lands — finding 6 stands, a reply still paints outside whatever it declared — so the content is
 * measured exactly as before and then centred in x and y with its feet on the floor. Air above a
 * short model is the point: the canvas is the room left to draw in.
 *
 * Measured against the live Qwen3.6-27B on 2026-08-08 over six "a cat" replies: **every one wrote
 * outside the size it had just declared** — `[20,16,14]` with ops reaching `y = 18`, `[16,20,16]`
 * with ops reaching `z = 23`. Writes off the grid are dropped, so what vanished was always the
 * detail: the ears, the tail, the far side of a head. The declared size is the one number in the
 * reply the model has no picture of, and there is no reason to trust it over the ops themselves.
 *
 * `size` is still read and still clamped — it travels with the spec into the saved record — it just
 * no longer decides how much of the model survives.
 *
 * With `mirror_x` the width is doubled about the model's own far edge rather than about the
 * declared centre, because a half whose declared plane was wrong is a half joined to itself in the
 * wrong place: a seam, or a body with a hollow down the middle.
 */
export const gridFor = (
    spec: VoxSpec,
    canvas?: number
): {readonly size: Vec3; readonly origin: Vec3} => {
    // Both are in *op* space, so `size` reads [width, height, depth]. `rasterise` swaps.
    const cap = canvas ?? MAX_SIZE
    const bounds = paintedBounds(spec.ops)
    if (!bounds) {
        return canvas === undefined ?
                {size: [1, 1, 1], origin: [0, 0, 0]}
            :   {size: [canvas, canvas, canvas], origin: [0, 0, 0]}
    }
    const {lo, hi} = bounds
    const half = extent(lo[0], hi[0], cap)
    const width = spec.mirror_x ? Math.min(cap, half * 2) : half
    const height = extent(lo[1], hi[1], cap)
    const depth = extent(lo[2], hi[2], cap)
    if (canvas === undefined) {
        return {
            size: [width, height, depth],
            origin: [Math.ceil(lo[0]), Math.ceil(lo[1]), Math.ceil(lo[2])]
        }
    }
    /*
     * Centred across, and against the floor up. `y` is up in op space and the system prompt has
     * always said "feet at y=0", so lifting the content off the floor to centre it would put every
     * model in the air over a ground lattice drawn at z = 0.
     *
     * With `mirror_x` the drawn half is laid against the middle rather than centred, because the
     * mirror reflects about the grid's own centre: centring the half would fold it back over itself.
     * A half wider than the canvas allows keeps its inner edge and loses its outer one.
     */
    const across =
        spec.mirror_x ?
            Math.max(0, Math.floor(canvas / 2) - half)
        :   Math.max(0, Math.floor((canvas - width) / 2))
    return {
        size: [canvas, canvas, canvas],
        origin: [
            Math.ceil(lo[0]) - across,
            Math.ceil(lo[1]),
            Math.ceil(lo[2]) - Math.max(0, Math.floor((canvas - depth) / 2))
        ]
    }
}

/**
 * Ops to voxels.
 *
 * **Op coordinates are y-up; a `Volume` is z-up.** The swap happens here, and it is not a taste
 * call. The prompt used to say "z = up" and the model ignored it every time — measured on
 * 2026-08-08, four legs came back at the four corners of the x–z plane with the head at high `y`,
 * which is y-up whatever the system prompt asked for. Asking a 27B model to work against the
 * convention its training data is written in bought lying-down cats; asking for y-up and swapping
 * one line here buys cats that stand.
 *
 * Palette entries are appended in first-seen order and indices are 1-based, matching `.vox` and the
 * rest of this app. Writes outside the fitted grid are dropped rather than clamped — clamping would
 * smear a mistyped coordinate along a wall, which looks like geometry instead of like an error.
 */
export const rasterise = (spec: VoxSpec, canvas?: number): Volume => {
    const {size, origin} = gridFor(spec, canvas)
    const [width, height, depth] = size
    const [ox, oy, oz] = origin
    const palette = new Uint8Array(256 * 4)
    const slots = new Map<string, number>()
    // The swap: the grid is as deep as the ops are in z, and as tall as they are in y.
    const volume = createVolume(width, depth, height, palette)

    /** One op-space cell, in y-up op coordinates, into the z-up grid. */
    const put = (x: number, y: number, z: number, value: number): void => {
        setVoxel(volume, x - ox, z - oz, y - oy, value)
    }

    const slot = (css: string): number => {
        const key = css.toLowerCase().replace(/^#/, '')
        const found = slots.get(key)
        if (found !== undefined) return found
        // 255 entries, 1-based. Past that the colour is dropped onto the last one rather than
        // wrapping to 0, which would erase the voxel it was meant to paint.
        const index = Math.min(255, slots.size + 1)
        slots.set(key, index)
        palette.set([channel(key, 0), channel(key, 2), channel(key, 4), 255], index * 4)
        return index
    }

    for (const op of spec.ops) {
        if (op.op === 'box' || op.op === 'erase') {
            const value = op.op === 'erase' ? 0 : slot(op.color)
            const [x0, y0, z0] = op.from
            const [x1, y1, z1] = op.to
            for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += 1) {
                for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += 1) {
                    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z += 1) {
                        put(x, y, z, value)
                    }
                }
            }
        } else {
            const value = slot(op.color)
            const [cx, cy, cz] = op.at
            const [rx, ry, rz] = op.r
            for (let x = cx - rx; x <= cx + rx; x += 1) {
                for (let y = cy - ry; y <= cy + ry; y += 1) {
                    for (let z = cz - rz; z <= cz + rz; z += 1) {
                        const dx = (x - cx) / Math.max(rx, 0.5)
                        const dy = (y - cy) / Math.max(ry, 0.5)
                        const dz = (z - cz) / Math.max(rz, 0.5)
                        if (dx * dx + dy * dy + dz * dz <= 1) put(x, y, z, value)
                    }
                }
            }
        }
    }

    if (spec.mirror_x) {
        // Over a copy, so the reflection is of the finished model rather than of itself — mirroring
        // in place would fold the half it had just written back over the other side.
        const before = Uint8Array.from(volume.data)
        for (let z = 0; z < volume.sz; z += 1) {
            for (let y = 0; y < volume.sy; y += 1) {
                for (let x = 0; x < volume.sx; x += 1) {
                    const value = before[voxelIndex(volume, x, y, z)] ?? 0
                    if (value !== 0) setVoxel(volume, volume.sx - 1 - x, y, z, value)
                }
            }
        }
    }

    return volume
}

export const countFilled = ({data}: Volume): number => {
    let count = 0
    for (const value of data) if (value !== 0) count += 1
    return count
}
