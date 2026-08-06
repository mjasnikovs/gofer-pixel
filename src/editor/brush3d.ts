import {EMPTY} from '../vox/palette'
import type {GridSize} from '../vox/grid'
import type {Volume} from '../doc/volume'
import {pickAttach, pickSurface, type Axis, type OrthoView, type Voxel, VIEWS} from './view3d'

/**
 * MagicaVoxel's brush vocabulary — the one voxel artists already have
 * (`PRODUCTION_PLAN.md` §6) — over a `Volume`.
 *
 * Shape and mode are independent: the shape decides which voxels a gesture names, the mode decides
 * what happens to them. That is why erase does not need its own five brushes.
 *
 * Everything here mutates the volume it is handed, which is only safe inside `editCel`, and
 * returns the number of voxels it changed so a gesture that did nothing never reaches the undo
 * stack. Same contract as `src/doc/tools.ts`.
 */
export type BrushShape = 'voxel' | 'face' | 'box' | 'line' | 'centre'

export type BrushMode = 'attach' | 'erase' | 'paint'

export interface Brush3D {
    shape: BrushShape
    mode: BrushMode
    color: number
    mirrorX?: boolean
    mirrorY?: boolean
    /** Slice lock: no operation may leave this z. */
    lockZ?: number
    /** Axis lock: a drag may only travel along this volume axis. */
    axisLock?: Axis | null
}

const inside = ({sx, sy, sz}: GridSize, [x, y, z]: Voxel): boolean =>
    x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz

/** A voxel and its mirror images, de-duplicated. */
const withMirrors = (voxel: Voxel, size: GridSize, brush: Brush3D): Voxel[] => {
    const [x, y, z] = voxel
    const xs = brush.mirrorX === true ? [...new Set([x, size.sx - 1 - x])] : [x]
    const ys = brush.mirrorY === true ? [...new Set([y, size.sy - 1 - y])] : [y]
    return xs.flatMap(px => ys.map((py): Voxel => [px, py, z]))
}

/**
 * Write one named voxel according to the mode.
 *
 * `paint` deliberately refuses to create: recolouring is for voxels that exist, and a paint stroke
 * that quietly adds geometry is the kind of thing you only notice three edits later.
 */
const write = (volume: Volume, size: GridSize, brush: Brush3D, voxel: Voxel): number => {
    let changed = 0
    for (const [x, y, z] of withMirrors(voxel, size, brush)) {
        if (!inside(size, [x, y, z]) || (brush.lockZ !== undefined && z !== brush.lockZ)) {
            continue
        }
        const occupied = volume.get(x, y, z) !== EMPTY
        if (brush.mode === 'erase') {
            if (occupied && volume.set(x, y, z, EMPTY)) {
                changed += 1
            }
        } else if (brush.mode === 'paint') {
            if (occupied && volume.set(x, y, z, brush.color)) {
                changed += 1
            }
        } else if (volume.set(x, y, z, brush.color)) {
            changed += 1
        }
    }
    return changed
}

/** Where a click lands, given the mode: attach builds in front of a surface, the rest hit it. */
export const brushTarget = (
    volume: Volume,
    view: OrthoView,
    h: number,
    v: number,
    size: GridSize,
    brush: Brush3D
): Voxel | null => {
    const options = brush.lockZ === undefined ? {} : {lockZ: brush.lockZ}
    return brush.mode === 'attach' ?
            pickAttach(volume, view, h, v, size, options)
        :   pickSurface(volume, view, h, v, size, options)
}

/** 3D Bresenham. A drag between two picked voxels leaves no gaps. */
export const line3d = (from: Voxel, to: Voxel): Voxel[] => {
    const delta = [to[0] - from[0], to[1] - from[1], to[2] - from[2]]
    const step = delta.map(d => (d < 0 ? -1 : 1))
    const abs = delta.map(Math.abs)
    const steps = Math.max(abs[0] ?? 0, abs[1] ?? 0, abs[2] ?? 0)
    if (steps === 0) {
        return [from]
    }
    const out: Voxel[] = []
    const error = [0, 0, 0]
    let current: Voxel = [...from]
    out.push(current)
    for (let i = 0; i < steps; i += 1) {
        const next: Voxel = [...current]
        for (let axis = 0; axis < 3; axis += 1) {
            error[axis] = (error[axis] ?? 0) + (abs[axis] ?? 0)
            if ((error[axis] ?? 0) >= steps) {
                error[axis] = (error[axis] ?? 0) - steps
                next[axis] = (next[axis] ?? 0) + (step[axis] ?? 1)
            }
        }
        current = next
        out.push(current)
    }
    return out
}

const boxBetween = (from: Voxel, to: Voxel): Voxel[] => {
    const out: Voxel[] = []
    for (let x = Math.min(from[0], to[0]); x <= Math.max(from[0], to[0]); x += 1) {
        for (let y = Math.min(from[1], to[1]); y <= Math.max(from[1], to[1]); y += 1) {
            for (let z = Math.min(from[2], to[2]); z <= Math.max(from[2], to[2]); z += 1) {
                out.push([x, y, z])
            }
        }
    }
    return out
}

const ballAround = (centre: Voxel, radius: number): Voxel[] => {
    const out: Voxel[] = []
    const r = Math.max(radius, 0)
    for (let x = centre[0] - r; x <= centre[0] + r; x += 1) {
        for (let y = centre[1] - r; y <= centre[1] + r; y += 1) {
            for (let z = centre[2] - r; z <= centre[2] + r; z += 1) {
                const dx = x - centre[0]
                const dy = y - centre[1]
                const dz = z - centre[2]
                if (dx * dx + dy * dy + dz * dz <= r * r + r) {
                    out.push([x, y, z])
                }
            }
        }
    }
    return out
}

/**
 * The connected run of same-coloured voxels sharing one flat face with the seed, as seen from this
 * view. Screen-space flood fill, because "the face I am looking at" is a screen-space idea.
 */
export const faceRegion = (
    volume: Volume,
    view: OrthoView,
    h: number,
    v: number,
    size: GridSize,
    lockZ?: number
): Voxel[] => {
    const options = lockZ === undefined ? {} : {lockZ}
    const seed = pickSurface(volume, view, h, v, size, options)
    if (!seed) {
        return []
    }
    const depthAxis = VIEWS[view].d
    const depthOf = ([x, y, z]: Voxel): number =>
        depthAxis === 'x' ? x
        : depthAxis === 'y' ? y
        : z
    const seedDepth = depthOf(seed)
    const seedColor = volume.get(seed[0], seed[1], seed[2])

    const out: Voxel[] = []
    const seen = new Set<string>()
    const queue: [number, number][] = [[h, v]]
    seen.add(`${String(h)},${String(v)}`)

    while (queue.length > 0) {
        const cell = queue.shift()
        if (!cell) {
            break
        }
        const hit = pickSurface(volume, view, cell[0], cell[1], size, options)
        if (
            !hit
            || depthOf(hit) !== seedDepth
            || volume.get(hit[0], hit[1], hit[2]) !== seedColor
        ) {
            continue
        }
        out.push(hit)
        for (const [dh, dv] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1]
        ]) {
            const next: [number, number] = [cell[0] + (dh ?? 0), cell[1] + (dv ?? 0)]
            const key = `${String(next[0])},${String(next[1])}`
            if (!seen.has(key)) {
                seen.add(key)
                queue.push(next)
            }
        }
    }
    return out
}

/** Constrain a drag to one volume axis — §6's axis lock. */
export const applyAxisLock = (from: Voxel, to: Voxel, axis: Axis | null | undefined): Voxel => {
    if (!axis) {
        return to
    }
    const index =
        axis === 'x' ? 0
        : axis === 'y' ? 1
        : 2
    const out: Voxel = [...from]
    out[index] = to[index]
    return out
}

export interface Gesture3D {
    view: OrthoView
    /** Screen cell where the gesture started. */
    from: [number, number]
    /** Screen cell it is at now. */
    to: [number, number]
}

/**
 * Everything a 3D gesture touches, before anything is written.
 *
 * Separate from `applyBrush3d` so the viewport can preview a drag by drawing this list, which is
 * the same list the commit will use — one code path, as in the 2D gesture replay.
 */
export const brushVoxels = (
    volume: Volume,
    size: GridSize,
    brush: Brush3D,
    {view, from, to}: Gesture3D
): Voxel[] => {
    const start = brushTarget(volume, view, from[0], from[1], size, brush)
    if (!start) {
        return []
    }
    if (brush.shape === 'face') {
        return faceRegion(volume, view, from[0], from[1], size, brush.lockZ)
    }
    const rawEnd = brushTarget(volume, view, to[0], to[1], size, brush) ?? start
    const end = applyAxisLock(start, rawEnd, brush.axisLock)

    if (brush.shape === 'voxel') {
        return [end]
    }
    if (brush.shape === 'line') {
        return line3d(start, end)
    }
    if (brush.shape === 'box') {
        return boxBetween(start, end)
    }
    const radius = Math.round(Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]))
    return ballAround(start, radius)
}

/**
 * Write a list of named voxels under one brush. The selection tools produce their own lists and
 * come through here, so mirror, slice lock and the mode rules apply to them identically.
 */
export const applyVoxels = (
    volume: Volume,
    size: GridSize,
    brush: Brush3D,
    voxels: readonly Voxel[]
): number => {
    let changed = 0
    for (const voxel of voxels) {
        changed += write(volume, size, brush, voxel)
    }
    return changed
}

/** Run a gesture into the volume. Returns how many voxels actually changed. */
export const applyBrush3d = (
    volume: Volume,
    size: GridSize,
    brush: Brush3D,
    gesture: Gesture3D
): number => applyVoxels(volume, size, brush, brushVoxels(volume, size, brush, gesture))
