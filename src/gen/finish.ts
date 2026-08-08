import {createVolume, voxelAt, type Volume} from '../render/volume'

/**
 * The shading pass that turns a flat-coloured rasterisation into something with surface craft.
 *
 * Chosen by eye on 2026-08-08, over the code-format cat: the raw model reads as painted plastic,
 * the finished one as fur. Three tones per source colour — sun-lit tops, the base, and darkened
 * crevices — plus a deterministic per-voxel jitter that demotes a fifth of each tone one step, which
 * is what breaks the large flat faces the primitives leave behind.
 *
 * It is geometry-driven and deterministic, so it belongs to the pipeline, not to the model: the ops
 * in a `.gpix` record stay unshaded, and rasterise-then-finish reproduces the asset exactly.
 */
export const SHADE_LIT = 1.16
export const SHADE_DARK = 0.72

const clampChannel = (value: number): number => Math.max(0, Math.min(255, Math.round(value)))

/** Deterministic per-voxel hash on the half-open unit interval. */
const hash = (x: number, y: number, z: number): number => {
    let h = (x * 374761393 + y * 668265263 + z * 2147483647) >>> 0
    h = (h ^ (h >> 13)) >>> 0
    h = (h * 1274126177) >>> 0
    return ((h ^ (h >> 16)) >>> 0) / 4294967295
}

/**
 * A new volume with the same voxels and a palette of shade variants.
 *
 * Variants are allocated in first-need order, three at most per source colour, so the 255 palette
 * slots run out only past 85 distinct source colours — a generated model carries 4 to 8. Past the
 * cap, colours share slot 255 rather than wrapping to 0, which would erase voxels. Emissive travels
 * with the variant: a glowing colour glows in all three tones.
 */
export const finish = (volume: Volume): Volume => {
    const out = createVolume(volume.sx, volume.sy, volume.sz)
    out.owner.set(volume.owner)
    const slots = new Map<string, number>()
    let next = 1
    const variant = (base: number, kind: number): number => {
        const key = `${String(base)}:${String(kind)}`
        const found = slots.get(key)
        if (found !== undefined) return found
        const factor =
            kind === 0 ? SHADE_LIT
            : kind === 2 ? SHADE_DARK
            : 1
        const index = Math.min(255, next)
        next += 1
        out.palette.set(
            [
                clampChannel((volume.palette[base * 4] ?? 0) * factor),
                clampChannel((volume.palette[base * 4 + 1] ?? 0) * factor),
                clampChannel((volume.palette[base * 4 + 2] ?? 0) * factor),
                255
            ],
            index * 4
        )
        out.emissive[index] = volume.emissive[base] ?? 0
        slots.set(key, index)
        return index
    }
    for (let z = 0; z < volume.sz; z += 1) {
        for (let y = 0; y < volume.sy; y += 1) {
            for (let x = 0; x < volume.sx; x += 1) {
                const value = voxelAt(volume, x, y, z)
                if (value === 0) continue
                const openTop = voxelAt(volume, x, y, z + 1) === 0
                const openSides =
                    Number(voxelAt(volume, x + 1, y, z) === 0)
                    + Number(voxelAt(volume, x - 1, y, z) === 0)
                    + Number(voxelAt(volume, x, y + 1, z) === 0)
                    + Number(voxelAt(volume, x, y - 1, z) === 0)
                let kind = 1
                if (openTop) kind = 0
                else if (openSides <= 1) kind = 2
                const roll = hash(x, y, z)
                if (kind === 0 && roll < 0.2) kind = 1
                else if (kind === 1 && roll > 0.8) kind = 2
                out.data[(z * volume.sy + y) * volume.sx + x] = variant(value, kind)
            }
        }
    }
    return out
}
