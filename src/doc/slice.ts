import type {Axis} from './brush'
import type {Volume} from '../render/volume'

/**
 * Slice mode — `FEATURESET.md` §6, and the decision `docs/techstack.md` §4.3 left open.
 *
 * It is built, and it is built as a **clip rather than a ghost**. §6 asks for the current slice
 * solid and the surrounding ones ghosted; what it asks for it *for* is drawing complex interiors
 * without fighting the camera, and the thing that achieves that is the layers in front going away.
 *
 * Ghosting would mean alpha in the raycaster. That is a change to the one algorithm two backends
 * are held to agreeing on byte for byte, in exchange for a presentation difference — the artist
 * still cannot click through a ghost, so the ghost is scenery. Clipping is exact, is a masked grid
 * like a hidden object, and costs the renderer nothing.
 *
 * It is also not a second editing mode. The plane lock (§5) already answers "which plane am I
 * drawing on"; this answers "which layer of it, and can I see it". Everything else — the brush, the
 * figures, symmetry, undo — is what it already was.
 */
export interface Slice {
    readonly axis: Axis
    readonly layer: number
}

/** How many layers deep the grid is along one axis. */
export const layerCount = (volume: Volume, axis: Axis): number =>
    [volume.sx, volume.sy, volume.sz][axis] ?? 1

/** Clamped, so stepping past either end stops there rather than wrapping to the other side. */
export const clampLayer = (volume: Volume, axis: Axis, layer: number): number =>
    Math.max(0, Math.min(layerCount(volume, axis) - 1, Math.round(layer)))

/**
 * The grid with everything in front of the slice taken away.
 *
 * "In front" is decided by which way the camera is looking along the slice's own axis, so turning
 * the model round keeps the cut between the artist and the layer they are working on rather than
 * behind it. `forward` is the camera basis's, and a camera looking exactly along the plane leaves
 * the grid alone — there is no front to cut when the slice is edge-on.
 */
export const slicedVolume = (
    volume: Volume,
    slice: Slice,
    forward: readonly [number, number, number]
): Volume => {
    const along = forward[slice.axis]
    if (along === 0) return volume

    const {sx, sy} = volume
    const data = new Uint8Array(volume.data)
    // Looking down the axis means the layers *above* the slice are the near ones.
    const near = along < 0
    for (let i = 0; i < data.length; i += 1) {
        if (data[i] === 0) continue
        const z = Math.floor(i / (sx * sy))
        const rest = i - z * sx * sy
        const at = [rest % sx, Math.floor(rest / sx), z][slice.axis] ?? 0
        if (near ? at > slice.layer : at < slice.layer) data[i] = 0
    }
    return {...volume, data}
}
