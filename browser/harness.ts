import type {Basis} from '../src/render/camera'
import {createRaycaster, type Raycaster} from '../src/render/gl'
import type {Volume} from '../src/render/volume'

/**
 * A page whose only job is to run the shader on demand.
 *
 * `page.evaluate` serialises its arguments as JSON, so the volume crosses as plain arrays. That is
 * the point rather than a nuisance: the basis is computed once in Bun and handed over as numbers,
 * so no trigonometry runs on both sides and the only thing left to disagree about is the DDA.
 */
interface WireVolume {
    sx: number
    sy: number
    sz: number
    data: number[]
    palette: number[]
}

let raycaster: Raycaster | undefined
let loaded = ''

const gpuRender = async (
    wire: WireVolume,
    basis: Basis,
    mode: number,
    width: number,
    height: number
): Promise<number[]> => {
    const canvas = document.getElementById('gl')
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('no canvas')
    raycaster ??= createRaycaster(canvas)

    const key = `${String(wire.sx)}x${String(wire.sy)}x${String(wire.sz)}:${String(wire.data.length)}`
    if (key !== loaded) {
        const volume: Volume = {
            sx: wire.sx,
            sy: wire.sy,
            sz: wire.sz,
            data: new Uint8Array(wire.data),
            palette: new Uint8Array(wire.palette)
        }
        raycaster.setVolume(volume)
        loaded = key
    }
    raycaster.resize(width, height)
    await raycaster.renderNow(basis, mode)
    return Array.from(raycaster.readPixels())
}

/** How long one draw of this size actually takes, averaged, with the readback excluded. */
const gpuFrameMs = async (basis: Basis, mode: number, count: number): Promise<number> => {
    if (!raycaster) throw new Error('render once first')
    const started = performance.now()
    for (let i = 0; i < count; i += 1) await raycaster.renderNow(basis, mode)
    return (performance.now() - started) / count
}

declare global {
    interface Window {
        gofer: {gpuRender: typeof gpuRender; gpuFrameMs: typeof gpuFrameMs}
    }
}

window.gofer = {gpuRender, gpuFrameMs}
