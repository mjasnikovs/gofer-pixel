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
    emissive?: number[]
}

let raycaster: Raycaster | undefined
let loaded = ''

const gpuRender = async (
    wire: WireVolume,
    basis: Basis,
    mode: number,
    width: number,
    height: number,
    // Last and optional, so every parity call is a call with the lattice off. That default is the
    // whole reason the shader is allowed to carry something the CPU raycaster does not.
    edges = false
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
            palette: new Uint8Array(wire.palette),
            emissive: Uint8Array.from(wire.emissive ?? new Array<number>(256).fill(0)),
            // The shader never reads ownership; it exists so the document can name its objects.
            owner: new Uint8Array(wire.data.length)
        }
        raycaster.setVolume(volume)
        loaded = key
    }
    raycaster.resize(width, height)
    await raycaster.renderNow(basis, mode, edges)
    return Array.from(raycaster.readPixels())
}

/** How long one draw of this size actually takes, averaged, with the readback excluded. */
const gpuFrameMs = async (basis: Basis, mode: number, count: number): Promise<number> => {
    if (!raycaster) throw new Error('render once first')
    const started = performance.now()
    for (let i = 0; i < count; i += 1) await raycaster.renderNow(basis, mode)
    return (performance.now() - started) / count
}

/**
 * What actually rendered, for a failure message only.
 *
 * Never branch on this — WebKit masks the string and reports "Apple GPU" on an NVIDIA box, which
 * is why the suite decides hardware-versus-software by timing a draw. But when that timing
 * assertion fails, the first question is always "what was it running on", and answering it in the
 * message beats another round of bisecting.
 */
const gpuInfo = (): string => {
    const canvas = document.getElementById('gl')
    if (!(canvas instanceof HTMLCanvasElement)) return 'no canvas'
    const gl = canvas.getContext('webgl2')
    if (!gl) return 'no context'
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    return debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : 'renderer not exposed'
}

declare global {
    interface Window {
        gofer: {gpuRender: typeof gpuRender; gpuFrameMs: typeof gpuFrameMs; gpuInfo: typeof gpuInfo}
    }
}

window.gofer = {gpuRender, gpuFrameMs, gpuInfo}
