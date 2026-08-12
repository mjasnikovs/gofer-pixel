/*
 * Four deterministic ways to make a model worse, so that "which of these two is better" has an
 * answer nobody had to judge.
 *
 * This is the only honest way to put a number on ranking. Asking the model to choose between two
 * real candidates needs somebody to say which was better, and that somebody is an opinion; asking it
 * to choose between a model and the same model with a hole through it does not. If it cannot see
 * *obvious* damage it certainly cannot see the difference between two seeds, so this is an upper
 * bound and a cheap one.
 *
 * Every damage is a pure function of the volume and a seed, so a run reproduces. `Math.random` is
 * not used anywhere.
 */
import {createVolume, filledBounds, setVoxel, voxelAt, type Volume} from '../../../src/render/volume'

/** A small deterministic generator. Numerical Recipes' LCG constants; any would do. */
const lcg = (seed: number): (() => number) => {
    let state = seed >>> 0
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return state / 0x100000000
    }
}

const like = (volume: Volume): Volume => {
    const out = createVolume(volume.sx, volume.sy, volume.sz, volume.palette)
    out.emissive.set(volume.emissive)
    return out
}

export type DamageId = 'debris' | 'hole' | 'float' | 'squash'

export interface Damage {
    readonly id: DamageId
    /** What is wrong with the result, in the words the write-up uses. */
    readonly what: string
    readonly apply: (volume: Volume, seed: number) => Volume
}

export const DAMAGES: readonly Damage[] = [
    {
        id: 'debris',
        what: 'one voxel in twelve thrown off into the air around it',
        apply: (volume, seed) => {
            const next = lcg(seed)
            const out = like(volume)
            const {sx, sy, sz} = volume
            for (let z = 0; z < sz; z += 1) {
                for (let y = 0; y < sy; y += 1) {
                    for (let x = 0; x < sx; x += 1) {
                        const value = voxelAt(volume, x, y, z)
                        if (value === 0) continue
                        if (next() < 1 / 12) {
                            const nx = Math.min(sx - 1, Math.max(0, x + Math.round((next() - 0.5) * 14)))
                            const ny = Math.min(sy - 1, Math.max(0, y + Math.round((next() - 0.5) * 14)))
                            const nz = Math.min(sz - 1, Math.max(0, z + Math.round((next() - 0.5) * 14)))
                            setVoxel(out, nx, ny, nz, value)
                        } else {
                            setVoxel(out, x, y, z, value)
                        }
                    }
                }
            }
            return out
        }
    },
    {
        id: 'hole',
        what: 'a square shaft erased straight through the middle',
        apply: volume => {
            const out = like(volume)
            const bounds = filledBounds(volume)
            out.data.set(volume.data)
            if (!bounds) return out
            const cx = Math.round((bounds.min[0] + bounds.max[0]) / 2)
            const cz = Math.round((bounds.min[2] + bounds.max[2]) / 2)
            const r = Math.max(1, Math.round((bounds.max[0] - bounds.min[0]) / 5))
            for (let z = cz - r; z <= cz + r; z += 1) {
                for (let y = 0; y < volume.sy; y += 1) {
                    for (let x = cx - r; x <= cx + r; x += 1) setVoxel(out, x, y, z, 0)
                }
            }
            return out
        }
    },
    {
        id: 'float',
        what: 'the top half lifted five cells clear of the bottom half',
        apply: volume => {
            const out = like(volume)
            const bounds = filledBounds(volume)
            if (!bounds) return out
            const cut = Math.round((bounds.min[2] + bounds.max[2]) / 2)
            const {sx, sy, sz} = volume
            for (let z = 0; z < sz; z += 1) {
                for (let y = 0; y < sy; y += 1) {
                    for (let x = 0; x < sx; x += 1) {
                        const value = voxelAt(volume, x, y, z)
                        if (value === 0) continue
                        setVoxel(out, x, y, z < cut ? z : Math.min(sz - 1, z + 5), value)
                    }
                }
            }
            return out
        }
    },
    {
        id: 'squash',
        what: 'every other layer dropped, so it is half as tall as it should be',
        apply: volume => {
            const out = like(volume)
            const {sx, sy, sz} = volume
            for (let z = 0; z < sz; z += 1) {
                for (let y = 0; y < sy; y += 1) {
                    for (let x = 0; x < sx; x += 1) {
                        const value = voxelAt(volume, x, y, z * 2)
                        if (value !== 0 && z * 2 < sz) setVoxel(out, x, y, z, value)
                    }
                }
            }
            return out
        }
    }
]
