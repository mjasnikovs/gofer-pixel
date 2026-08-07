/**
 * A second opinion on the normal map — `FEATURESET.md` §19.
 *
 * This file lights a normal map the way a 2D engine will, and it is written **without importing
 * anything from the renderer**. Not `FACE_NORMAL`, not `faces.ts`, not a shared constant. That is
 * the whole point: §19 says two things agreeing proves nothing unless one of them is independently
 * right, and the same trap is already documented for the raycaster and the shader in
 * `docs/techstack.md` §2. If this decoded the map with the exporter's own table, an inverted green
 * channel would be inverted in both and the preview would show it lighting perfectly.
 *
 * So the decode below is written from the *documented* encoding — a byte of `0` is `-1`, `128` is
 * `0`, `255` is `+1` — rather than from the table that produced it. That encoding is not symmetric
 * about 128: there are 127 steps above it and 128 below. The usual `(b / 255) * 2 - 1` is therefore
 * wrong at both ends, so this divides by the distance to the pole it is heading for, which is exact
 * at all three of the documented points.
 *
 * It is a diagnostic and nothing else. One light, fixed. Never baked, never exported, and there is
 * no second light, because a second light is a lighting model and `FEATURESET.md` §21 is postponed
 * precisely so that this editor does not grow one.
 */

/**
 * What the preview assumes, said out loud so the artist can check it against their engine rather
 * than against this app.
 */
export const LIGHT_CONVENTION =
    'Read as a 2D engine reads it: +X right, +Y up, +Z out of the screen.'

/**
 * The one light. Up and to the left, leaning towards the viewer — the direction almost every
 * hand-painted sprite is lit from, so a map that lights *backwards* under it is obvious.
 */
export const LIGHT_DIRECTION: readonly [number, number, number] = (() => {
    const raw = [-0.4, 0.6, 0.69]
    const length = Math.hypot(raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0)
    return [(raw[0] ?? 0) / length, (raw[1] ?? 0) / length, (raw[2] ?? 0) / length]
})()

/** Enough ambient that a surface facing away is still readable rather than a black hole. */
const AMBIENT = 0.25

/** One channel of the encoded normal, back to `-1 … 1`. See the note above about the asymmetry. */
const decode = (byte: number): number => (byte - 128) / (byte >= 128 ? 127 : 128)

/**
 * Light an encoded normal map and return RGBA grey.
 *
 * `normal` is RGBA8 as the exporter writes it, alpha marking the hits. Every miss stays clear, so
 * the preview keeps the sprite's silhouette and the artist can see that the map covers exactly the
 * pixels the colour sprite does.
 */
export const lightNormals = (normal: Uint8Array): Uint8Array => {
    const [lx, ly, lz] = LIGHT_DIRECTION
    const out = new Uint8Array(normal.length)
    for (let i = 0; i < normal.length; i += 4) {
        if (normal[i + 3] !== 255) continue
        const nx = decode(normal[i] ?? 128)
        const ny = decode(normal[i + 1] ?? 128)
        const nz = decode(normal[i + 2] ?? 128)
        const lambert = Math.max(0, nx * lx + ny * ly + nz * lz)
        const shade = Math.round(Math.min(1, AMBIENT + (1 - AMBIENT) * lambert) * 255)
        out[i] = shade
        out[i + 1] = shade
        out[i + 2] = shade
        out[i + 3] = 255
    }
    return out
}

/**
 * How many of the map's lit pixels face the light, as a fraction of the pixels that are there.
 *
 * The number the diagnostic is actually for. A map whose green channel is inverted lights from
 * below, and on a model with a top the share facing the light collapses — so this is the thing to
 * look at when the preview looks "sort of fine".
 */
export const facingShare = (normal: Uint8Array): number => {
    const [lx, ly, lz] = LIGHT_DIRECTION
    let lit = 0
    let total = 0
    for (let i = 0; i < normal.length; i += 4) {
        if (normal[i + 3] !== 255) continue
        total += 1
        const nx = decode(normal[i] ?? 128)
        const ny = decode(normal[i + 1] ?? 128)
        const nz = decode(normal[i + 2] ?? 128)
        if (nx * lx + ny * ly + nz * lz > 0) lit += 1
    }
    return total === 0 ? 0 : lit / total
}
