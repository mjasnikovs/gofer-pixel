import {EMPTY} from '../vox/palette'
import type {Volume} from '../doc/volume'
import type {GridSize} from '../vox/grid'
import type {Box3} from '../editor/select3d'
import {compile, type Scope} from './expr'

/**
 * `voxel(x, y, z) -> palette index`, the procedural surface of `PRODUCTION_PLAN.md` §8.
 *
 * A script is one expression evaluated once per voxel in a box. It sees the coordinates, the
 * canvas size, the voxel already there, and nothing else — no loops, no state, no way to reach the
 * page. Returning 0 means empty; anything else is a 1-based palette index.
 *
 * This is the feature the plan calls the highest-value one, because it is the same surface the
 * model can drive: a generator that emits an expression is emitting something we can check and
 * run, rather than pixels it cannot draw.
 */
export interface ScriptOptions {
    /** Where the script runs. Defaults to the whole canvas. */
    box?: Box3
    /**
     * What happens to the result:
     * - `set` writes it, empty included, so a script can carve
     * - `add` only writes where the voxel is empty
     * - `paint` only writes where a voxel already exists
     */
    mode?: 'set' | 'add' | 'paint'
    /** Free variable, for animating a script across frames. */
    t?: number
}

export interface ScriptResult {
    changed: number
    /** Voxels the script visited, whether or not they changed. */
    visited: number
}

const fullBox = ({sx, sy, sz}: GridSize): Box3 => ({
    x0: 0,
    y0: 0,
    z0: 0,
    x1: sx - 1,
    y1: sy - 1,
    z1: sz - 1
})

/**
 * Run a script over a volume. Mutates the volume, so it belongs inside `editCel` like every other
 * voxel operation, and returns the number of voxels it actually changed.
 */
export const runVoxelScript = (
    volume: Volume,
    size: GridSize,
    source: string,
    {box, mode = 'set', t = 0}: ScriptOptions = {}
): ScriptResult => {
    const program = compile(source)
    const region = box ?? fullBox(size)
    const scope: Scope = {
        sx: size.sx,
        sy: size.sy,
        sz: size.sz,
        // the box, so a script can work in local coordinates without being told them twice
        bx: region.x0,
        by: region.y0,
        bz: region.z0,
        bw: region.x1 - region.x0 + 1,
        bh: region.y1 - region.y0 + 1,
        bd: region.z1 - region.z0 + 1,
        t,
        x: 0,
        y: 0,
        z: 0,
        v: 0
    }

    let changed = 0
    let visited = 0
    for (let z = Math.max(0, region.z0); z <= Math.min(size.sz - 1, region.z1); z += 1) {
        for (let y = Math.max(0, region.y0); y <= Math.min(size.sy - 1, region.y1); y += 1) {
            for (let x = Math.max(0, region.x0); x <= Math.min(size.sx - 1, region.x1); x += 1) {
                const existing = volume.get(x, y, z)
                if (
                    (mode === 'add' && existing !== EMPTY)
                    || (mode === 'paint' && existing === EMPTY)
                ) {
                    continue
                }
                scope['x'] = x
                scope['y'] = y
                scope['z'] = z
                scope['v'] = existing
                visited += 1
                const raw = program(scope)
                const color = Math.max(0, Math.min(255, Math.round(raw)))
                if (volume.set(x, y, z, color)) {
                    changed += 1
                }
            }
        }
    }
    return {changed, visited}
}

/**
 * The examples from §8's list of what `xs` scripts are used for, written in this language.
 *
 * They are here rather than in the UI because they are the readable specification of what the
 * language can express — if one of these stops working, the language regressed.
 */
export const SCRIPT_PRESETS: {
    name: string
    mode: NonNullable<ScriptOptions['mode']>
    source: string
}[] = [
    {
        name: 'bricks',
        mode: 'paint',
        source: 'mod(z, 2) == 0 ? (mod(x, 4) < 3 ? 2 : 3) : (mod(x + 2, 4) < 3 ? 2 : 3)'
    },
    {
        name: 'noise speckle',
        mode: 'paint',
        source: 'rand(x, y, z) > 0.75 ? 3 : v'
    },
    {
        name: 'terrain',
        mode: 'set',
        source: 'z < floor(noise(x / 6, y / 6, 0) * bd) ? 2 : 0'
    },
    {
        name: 'stairs',
        mode: 'set',
        source: 'z <= floor(x / 2) ? 4 : 0'
    },
    {
        name: 'greebles',
        mode: 'add',
        source: 'rand(floor(x / 2), floor(y / 2), z) > 0.85 ? 5 : 0'
    },
    {
        name: 'hollow',
        mode: 'set',
        source: 'x > bx && x < bx + bw - 1 && y > by && y < by + bh - 1 && z > bz && z < bz + bd - 1 ? 0 : v'
    }
]
