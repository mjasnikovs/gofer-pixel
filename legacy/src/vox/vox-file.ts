import {DEFAULT_PALETTE, packKey, unpackKey, type VoxModel} from './model'
import type {Rgba} from './palette'

const tagAt = (view: DataView, offset: number): string =>
    String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
    )

/** Parse a MagicaVoxel .vox file. Walks MAIN's children linearly; ignores scene-graph chunks. */
export const readVox = (bytes: Uint8Array): VoxModel => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    if (tagAt(view, 0) !== 'VOX ') {
        throw new Error('not a .vox file')
    }

    let size: [number, number, number] | null = null
    let palette = DEFAULT_PALETTE
    const voxels = new Map<number, number>()

    let pos = 8 + 12 // magic + version, then the MAIN chunk header

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
                voxels.set(
                    packKey(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2)),
                    view.getUint8(at + 3)
                )
            }
        } else if (id === 'RGBA') {
            const parsed: Rgba[] = []
            for (let i = 0; i < 256; i += 1) {
                const at = body + i * 4
                parsed.push({
                    r: view.getUint8(at),
                    g: view.getUint8(at + 1),
                    b: view.getUint8(at + 2),
                    a: view.getUint8(at + 3)
                })
            }
            palette = parsed
        }

        pos = body + contentBytes + childBytes
    }

    if (!size) {
        throw new Error('no SIZE chunk')
    }

    return {sx: size[0], sy: size[1], sz: size[2], voxels, palette}
}

const TRANSPARENT: Rgba = {r: 0, g: 0, b: 0, a: 0}

const chunk = (
    tag: string,
    content: Uint8Array,
    children: Uint8Array = new Uint8Array(0)
): Uint8Array => {
    const out = new Uint8Array(12 + content.length + children.length)
    const view = new DataView(out.buffer)
    for (let i = 0; i < 4; i += 1) {
        out[i] = tag.charCodeAt(i)
    }
    view.setInt32(4, content.length, true)
    view.setInt32(8, children.length, true)
    out.set(content, 12)
    out.set(children, 12 + content.length)
    return out
}

const concat = (parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
    let at = 0
    for (const part of parts) {
        out.set(part, at)
        at += part.length
    }
    return out
}

/**
 * Write a MagicaVoxel .vox file — `SIZE`, `XYZI`, `RGBA` under `MAIN`, byte-for-byte what
 * `voxgen.py:write_vox` produces for the same model.
 *
 * The extension chunks (`nTRN`/`nGRP`/`nSHP` scene graph, `LAYR`, `MATL`, `NOTE`) are
 * deliberately absent. A single-model export needs none of them, MagicaVoxel opens a file
 * without them, and the spec details for the rotation bit-field were never verified against the
 * raw specification — see `PRODUCTION_PLAN.md` §14. Multi-layer export is where they start to
 * matter, and that is where they should be added.
 *
 * Voxels are written in the model's own iteration order, so a read/write round-trip is exact.
 */
export const writeVox = ({sx, sy, sz, voxels, palette}: VoxModel): Uint8Array => {
    const size = new Uint8Array(12)
    const sizeView = new DataView(size.buffer)
    sizeView.setInt32(0, sx, true)
    sizeView.setInt32(4, sy, true)
    sizeView.setInt32(8, sz, true)

    const xyzi = new Uint8Array(4 + voxels.size * 4)
    new DataView(xyzi.buffer).setInt32(0, voxels.size, true)
    let at = 4
    for (const [key, color] of voxels) {
        const [x, y, z] = unpackKey(key)
        xyzi.set([x, y, z, color], at)
        at += 4
    }

    const rgba = new Uint8Array(256 * 4)
    for (let i = 0; i < 256; i += 1) {
        const {r, g, b, a} = palette[i] ?? TRANSPARENT
        rgba.set([r, g, b, a], i * 4)
    }

    const header = new Uint8Array(8)
    header.set([0x56, 0x4f, 0x58, 0x20]) // 'VOX '
    new DataView(header.buffer).setInt32(4, 150, true)

    const body = concat([chunk('SIZE', size), chunk('XYZI', xyzi), chunk('RGBA', rgba)])
    return concat([header, chunk('MAIN', new Uint8Array(0), body)])
}
