import {createVolume, setVoxel, type Volume} from '../render/volume'

/**
 * MagicaVoxel's built-in palette, generated procedurally, for files that carry no `RGBA` chunk.
 * Entry 1 is white; the rest walk a 6×6×3-ish RGB cube in the order the format defines.
 *
 * Exported because `doc/palette.ts` needs to *recognise* it. Almost every `.vox` file in the world
 * carries this ramp in the slots its artist never touched, and a swatch grid full of `#030300`,
 * `#270300`, `#4b0300` is a grid of nothing. Knowing exactly what the untouched ramp looks like is
 * what lets those slots be replaced without ever overwriting a colour somebody chose.
 */
export const magicaPalette = (): Uint8Array => {
    const palette = new Uint8Array(256 * 4)
    palette.set([255, 255, 255, 255], 4)
    for (let i = 0; i < 254; i += 1) {
        palette.set(
            [((i >> 0) & 7) * 36 + 3, ((i >> 3) & 7) * 36 + 3, ((i >> 6) & 3) * 85, 255],
            (i + 2) * 4
        )
    }
    return palette
}

const tagAt = (view: DataView, offset: number): string =>
    String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
    )

/**
 * Read a MagicaVoxel `.vox` file into a `Volume`.
 *
 * Walks `MAIN`'s children linearly and ignores the scene-graph chunks: a single-model file needs
 * none of them, and the rotation bit-field in `nTRN` was never verified against the raw spec.
 *
 * Two format details that are easy to get wrong and are the whole reason this is not three lines:
 * colour indices are **1-based** into the `RGBA` chunk, so the chunk's entry `i` is the colour of
 * voxel value `i + 1`; and `.vox` is z-up, which is what the raycaster already assumes.
 *
 * Derived from `legacy/src/vox/vox-file.ts`, which is correct format code, but writing into a dense
 * grid rather than a sparse map — the raycaster reads one cell per DDA step and the GPU wants the
 * same bytes as a 3D texture.
 */
export const readVox = (bytes: Uint8Array): Volume => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (tagAt(view, 0) !== 'VOX ') throw new Error('not a .vox file')

    let size: [number, number, number] | undefined
    let palette = magicaPalette()
    const voxels: [number, number, number, number][] = []

    let pos = 8 + 12 // magic and version, then the MAIN chunk header
    while (pos + 12 <= bytes.length) {
        const id = tagAt(view, pos)
        const contentBytes = view.getInt32(pos + 4, true)
        const childBytes = view.getInt32(pos + 8, true)
        const body = pos + 12

        if (id === 'SIZE') {
            size = [
                view.getInt32(body, true),
                view.getInt32(body + 4, true),
                view.getInt32(body + 8, true)
            ]
        } else if (id === 'XYZI') {
            const count = view.getInt32(body, true)
            for (let i = 0; i < count; i += 1) {
                const at = body + 4 + i * 4
                voxels.push([
                    view.getUint8(at),
                    view.getUint8(at + 1),
                    view.getUint8(at + 2),
                    view.getUint8(at + 3)
                ])
            }
        } else if (id === 'RGBA') {
            palette = new Uint8Array(256 * 4)
            // The chunk's entry `i` is the colour of voxel value `i + 1`; value 0 is empty.
            for (let i = 0; i < 255; i += 1) {
                palette.set(bytes.subarray(body + i * 4, body + i * 4 + 4), (i + 1) * 4)
            }
        }
        pos = body + contentBytes + childBytes
    }

    if (!size) throw new Error('no SIZE chunk')
    const volume = createVolume(size[0], size[1], size[2], palette)
    for (const [x, y, z, value] of voxels) setVoxel(volume, x, y, z, value)
    return volume
}

export const countVoxels = ({data}: Volume): number => {
    let count = 0
    for (const value of data) if (value !== 0) count += 1
    return count
}
