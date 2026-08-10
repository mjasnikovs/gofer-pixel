/**
 * A WebGL2 context that records instead of drawing.
 *
 * `src/render/gl.ts` is a hundred lines of "what gets uploaded, in what order, under which name",
 * and that is not the same question as "does the shader produce the right pixels". The second one
 * needs a GPU and is answered by `browser/parity.spec.ts`. The first one is plumbing — an internal
 * format typed `RGBA8` where the shader samples `R8UI`, a `readPixels` that stopped following the
 * draw, a basis component wired to the wrong uniform — and every one of those is invisible to a
 * pixel test that only ever runs on a machine where it happens to work.
 *
 * So this stands in for the context and remembers the calls. It is deliberately not a WebGL
 * emulator: nothing here validates state, and no test may assert anything it would take a real
 * driver to know.
 */

export interface GlCall {
    readonly name: string
    readonly args: readonly unknown[]
}

export interface FakeGl {
    readonly calls: readonly GlCall[]
    /** Every call to `name`, in order. */
    of: (name: string) => readonly GlCall[]
    /** The arguments of the one call to `name`, or a throw if it did not happen exactly once. */
    once: (name: string) => readonly unknown[]
    /** The index of the first call to `name`, or `-1`. */
    first: (name: string) => number
    /** What was uploaded to a uniform, by its GLSL name. */
    uniform: (name: string) => readonly unknown[] | undefined
    readonly context: WebGL2RenderingContext
}

/** Only the constants `gl.ts` reaches for. Values are arbitrary but distinct. */
const CONSTANTS = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    TRIANGLES: 0x0004,
    TEXTURE_2D: 0x0de1,
    TEXTURE_3D: 0x806f,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE2: 0x84c2,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TEXTURE_WRAP_R: 0x8072,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    R8: 0x8229,
    R8UI: 0x8232,
    RED: 0x1903,
    RED_INTEGER: 0x8d94,
    RGBA: 0x1908,
    RGBA8: 0x8058,
    UNSIGNED_BYTE: 0x1401,
    UNPACK_ALIGNMENT: 0x0cf5,
    COLOR_BUFFER_BIT: 0x4000
}

export interface FakeGlOptions {
    /** Fail the shader compile, with this info log. */
    readonly compileError?: string
    /** Fail the program link, with this info log. */
    readonly linkError?: string
    /** `createShader` returns null — the one failure that is not an info log. */
    readonly noShader?: boolean
    /** What `readPixels` should paint into the buffer it is handed. */
    readonly pixel?: readonly number[]
}

export const fakeGl = (options: FakeGlOptions = {}): FakeGl => {
    const calls: GlCall[] = []
    const record =
        (name: string) =>
        (...args: unknown[]): void => {
            calls.push({name, args})
        }

    const context = {
        ...CONSTANTS,

        createShader: (type: number) => {
            calls.push({name: 'createShader', args: [type]})
            return options.noShader ? null : {shader: type}
        },
        shaderSource: record('shaderSource'),
        compileShader: record('compileShader'),
        getShaderParameter: () => options.compileError === undefined,
        getShaderInfoLog: () => options.compileError ?? null,

        createProgram: () => ({program: true}),
        attachShader: record('attachShader'),
        linkProgram: record('linkProgram'),
        getProgramParameter: () => options.linkError === undefined,
        getProgramInfoLog: () => options.linkError ?? null,
        useProgram: record('useProgram'),

        // The name is the handle, so a test can ask which uniform a value went to.
        getUniformLocation: (_program: unknown, name: string) => name,
        getAttribLocation: (_program: unknown, name: string) => {
            calls.push({name: 'getAttribLocation', args: [name]})
            return 0
        },

        createBuffer: () => ({buffer: true}),
        bindBuffer: record('bindBuffer'),
        bufferData: record('bufferData'),
        enableVertexAttribArray: record('enableVertexAttribArray'),
        vertexAttribPointer: record('vertexAttribPointer'),

        createTexture: () => ({texture: calls.length}),
        activeTexture: record('activeTexture'),
        bindTexture: record('bindTexture'),
        texParameteri: record('texParameteri'),
        texImage2D: record('texImage2D'),
        texImage3D: record('texImage3D'),
        pixelStorei: record('pixelStorei'),

        uniform1i: record('uniform1i'),
        uniform1f: record('uniform1f'),
        uniform3f: record('uniform3f'),
        /** The six-face light table — one array uniform per frame. See `render/light.ts`. */
        uniform1fv: record('uniform1fv'),

        viewport: record('viewport'),
        clearColor: record('clearColor'),
        clear: record('clear'),
        drawArrays: record('drawArrays'),

        readPixels: (
            x: number,
            y: number,
            width: number,
            height: number,
            format: number,
            type: number,
            into: Uint8Array<ArrayBuffer>
        ) => {
            calls.push({name: 'readPixels', args: [x, y, width, height, format, type]})
            const pixel = options.pixel ?? [0, 0, 0, 0]
            for (let i = 0; i < into.length; i += 1) into[i] = pixel[i % 4] ?? 0
        },

        getExtension: (name: string) => {
            calls.push({name: 'getExtension', args: [name]})
            return name === 'WEBGL_lose_context' ? {loseContext: record('loseContext')} : null
        }
    } as unknown as WebGL2RenderingContext

    const of = (name: string): GlCall[] => calls.filter(call => call.name === name)

    return {
        calls,
        context,
        of,
        once: (name: string) => {
            const found = of(name)
            const [only] = found
            if (!only || found.length !== 1)
                throw new Error(`${name} was called ${String(found.length)} times, not once`)
            return only.args
        },
        first: (name: string) => calls.findIndex(call => call.name === name),
        uniform: (name: string) =>
            calls
                .find(call => call.name.startsWith('uniform') && call.args[0] === name)
                ?.args.slice(1)
    }
}

/**
 * Put `context` behind `canvas.getContext('webgl2')` for the duration of `run`.
 *
 * The whole prototype rather than one element, because `createRaycaster` builds a second canvas of
 * its own to ask whether WebGL1 comes up, and that one has to be answerable too.
 */
export const withFakeGl = async (
    contexts: {webgl2?: WebGL2RenderingContext | null; webgl?: unknown},
    run: () => Promise<void> | void
): Promise<void> => {
    const real = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = ((kind: string) =>
        kind === 'webgl2' ? (contexts.webgl2 ?? null)
        : kind === 'webgl' ? (contexts.webgl ?? null)
        : null) as unknown as typeof HTMLCanvasElement.prototype.getContext
    try {
        await run()
    } finally {
        HTMLCanvasElement.prototype.getContext = real
    }
}
