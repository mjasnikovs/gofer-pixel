import type {Basis} from './camera'
import {FRAGMENT_SHADER, MODE_COLOR, VERTEX_SHADER} from './raycast.glsl'
import type {Volume} from './volume'

/**
 * The viewport's renderer: the same raycast, on the GPU.
 *
 * The loop is deliberately not `requestAnimationFrame`-owned. Nothing here schedules itself —
 * a caller draws, and `renderNow` resolves once the frame has actually landed. That is what lets a
 * test await *a frame* instead of a number of milliseconds, and it is a requirement on this API
 * rather than a convenience (`docs/techstack.md` §3).
 */
export interface Raycaster {
    /** Monotonic, one per landed frame. */
    readonly frames: number
    setVolume: (volume: Volume) => void
    resize: (width: number, height: number) => void
    /** Draw, block until the frame is really on the drawing buffer, resolve with the new count. */
    renderNow: (basis: Basis, mode?: number) => Promise<number>
    /** RGBA8 of the last frame, framebuffer order — row 0 is the *bottom*. */
    readPixels: () => Uint8Array
    dispose: () => void
}

const compile = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type)
    if (!shader) throw new Error('could not create shader')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) ?? 'shader failed to compile')
    }
    return shader
}

const link = (gl: WebGL2RenderingContext): WebGLProgram => {
    const program = gl.createProgram()
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER))
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) ?? 'program failed to link')
    }
    return program
}

export const createRaycaster = (canvas: HTMLCanvasElement): Raycaster => {
    // `preserveDrawingBuffer` so a screenshot or a `readPixels` after the fact sees the frame.
    const gl = canvas.getContext('webgl2', {
        antialias: false,
        preserveDrawingBuffer: true,
        premultipliedAlpha: false
    })
    if (!gl) {
        // "WebGL2 is not available" on its own sends the reader to their driver, which is almost
        // never where the problem is. The two questions that actually separate the causes are
        // whether WebGL1 comes up (so the browser has a GPU pipeline and something is refusing
        // *this* context) and whether the page is being fingerprint-shielded.
        const fallback = document.createElement('canvas').getContext('webgl')
        throw new Error(
            fallback ?
                'This browser has WebGL1 but refuses WebGL2. Usually a privacy shield blocking '
                    + 'canvas access for this site, or a browser flag — check the shield icon in '
                    + 'the address bar first.'
            :   'No WebGL at all. Hardware acceleration is switched off in this browser, or a '
                    + 'privacy shield is blocking canvas access for this site.'
        )
    }

    const program = link(gl)
    gl.useProgram(program)
    const at = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name)

    // One triangle covering the clip cube; there is no geometry in a raycaster.
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const corner = gl.getAttribLocation(program, 'aCorner')
    gl.enableVertexAttribArray(corner)
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0)

    const volumeTexture = gl.createTexture()
    const paletteTexture = gl.createTexture()
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.uniform1i(at('uVolume'), 0)
    gl.uniform1i(at('uPalette'), 1)

    let frames = 0
    const landed = new Uint8Array(4)

    const setVolume = (volume: Volume): void => {
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_3D, volumeTexture)
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
        gl.texImage3D(
            gl.TEXTURE_3D,
            0,
            gl.R8UI,
            volume.sx,
            volume.sy,
            volume.sz,
            0,
            gl.RED_INTEGER,
            gl.UNSIGNED_BYTE,
            volume.data
        )

        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, paletteTexture)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA8,
            256,
            1,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            volume.palette
        )

        gl.uniform3f(at('uDim'), volume.sx, volume.sy, volume.sz)
    }

    const resize = (width: number, height: number): void => {
        canvas.width = width
        canvas.height = height
        gl.viewport(0, 0, width, height)
        gl.uniform1f(at('uWidth'), width)
        gl.uniform1f(at('uHeight'), height)
    }

    const renderNow = async (basis: Basis, mode = MODE_COLOR): Promise<number> => {
        const [fx, fy, fz] = basis.forward
        const [rx, ry, rz] = basis.right
        const [ux, uy, uz] = basis.up
        const [cx, cy, cz] = basis.center
        gl.uniform3f(at('uForward'), fx, fy, fz)
        gl.uniform3f(at('uRight'), rx, ry, rz)
        gl.uniform3f(at('uUp'), ux, uy, uz)
        gl.uniform3f(at('uCenter'), cx, cy, cz)
        gl.uniform1f(at('uScale'), basis.scale)
        gl.uniform1f(at('uDist'), basis.dist)
        gl.uniform1f(at('uDepthRange'), basis.depthRange)
        gl.uniform1i(at('uMode'), mode)

        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        // Reading one pixel back is what actually blocks until the frame is on the drawing buffer.
        // `gl.finish()` alone does not: Chrome's command buffer returns from it long before the
        // GPU is done, which makes a benchmark built on it report a frame time of 0.006 ms on
        // software rendering. The stall costs about a fifth of a millisecond and buys an honest
        // frame counter — a test that awaits "a frame" has to be awaiting something real.
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, landed)
        frames += 1
        return frames
    }

    const readPixels = (): Uint8Array => {
        const pixels = new Uint8Array(canvas.width * canvas.height * 4)
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        return pixels
    }

    return {
        get frames() {
            return frames
        },
        setVolume,
        resize,
        renderNow,
        readPixels,
        dispose: () => {
            gl.getExtension('WEBGL_lose_context')?.loseContext()
        }
    }
}
