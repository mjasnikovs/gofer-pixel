import {expect, test} from 'bun:test'
import {fakeGl, withFakeGl} from '../../test/fake-gl'
import {basisFor, createCamera} from './camera'
import {createRaycaster, type Raycaster} from './gl'
import {MODE_NORMAL} from './raycast.glsl'
import {createVolume, setVoxel} from './volume'

/**
 * The GPU backend's *plumbing*, which is a different question from its pixels.
 *
 * The pixels are held by `browser/parity.spec.ts`, against a real driver, and nothing here tries to
 * repeat that. What is checked here is everything that would be wrong on every machine equally: an
 * internal format the shader does not sample, a basis component wired to the wrong uniform name, a
 * `readPixels` that stopped following the draw and so stopped meaning "the frame landed".
 *
 * See `test/fake-gl.ts` for what stands in for the context.
 */
const palette = new Uint8Array(256 * 4)
palette.set([200, 40, 40, 255], 4)
const volume = createVolume(4, 5, 6, palette)
setVoxel(volume, 1, 1, 1, 1)

const canvas = (): HTMLCanvasElement => document.createElement('canvas')

test('a context that will not come up says which of the two causes it is', async () => {
    let said = ''
    await withFakeGl({webgl2: null, webgl: {}}, () => {
        try {
            createRaycaster(canvas())
        } catch (error) {
            said = error instanceof Error ? error.message : ''
        }
    })
    // WebGL1 came up, so the browser has a pipeline and something is refusing *this* context.
    expect(said).toContain('WebGL1 but refuses WebGL2')
    expect(said).toContain('privacy shield')

    await withFakeGl({webgl2: null, webgl: null}, () => {
        try {
            createRaycaster(canvas())
        } catch (error) {
            said = error instanceof Error ? error.message : ''
        }
    })
    expect(said).toContain('No WebGL at all')
})

test('a shader that will not compile throws its own info log, not a generic failure', async () => {
    const gl = fakeGl({compileError: '0:12: undefined variable uDim'})
    await withFakeGl({webgl2: gl.context}, () => {
        expect(() => createRaycaster(canvas())).toThrow('0:12: undefined variable uDim')
    })
})

test('a program that will not link throws its own info log', async () => {
    const gl = fakeGl({linkError: 'varying count exceeds limit'})
    await withFakeGl({webgl2: gl.context}, () => {
        expect(() => createRaycaster(canvas())).toThrow('varying count exceeds limit')
    })
})

test('a driver that hands back no shader at all still fails loudly', async () => {
    const gl = fakeGl({noShader: true})
    await withFakeGl({webgl2: gl.context}, () => {
        expect(() => createRaycaster(canvas())).toThrow('could not create shader')
    })
})

test('the program is one full-screen triangle and the three samplers it needs', async () => {
    const gl = fakeGl()
    await withFakeGl({webgl2: gl.context}, () => {
        createRaycaster(canvas())
    })

    // A raycaster has no geometry. Three vertices covering the clip cube, not two triangles: one
    // triangle has no seam down the diagonal for a per-pixel shader to disagree across.
    expect(gl.once('bufferData')[1]).toEqual(new Float32Array([-1, -1, 3, -1, -1, 3]))
    expect(gl.once('getAttribLocation')[0]).toBe('aCorner')
    expect(gl.once('vertexAttribPointer')).toEqual([0, 2, gl.context.FLOAT, false, 0, 0])

    // Texture units, in the order the samplers are bound to below.
    expect(gl.uniform('uVolume')).toEqual([0])
    expect(gl.uniform('uPalette')).toEqual([1])
    expect(gl.uniform('uEmissive')).toEqual([2])

    // Rows of a 3D texture are one byte per voxel, so the default four-byte row alignment would
    // shear every grid whose width is not a multiple of four.
    expect(gl.once('pixelStorei')).toEqual([gl.context.UNPACK_ALIGNMENT, 1])
})

test('the volume goes up as an integer texture and the palettes as colour and grey', async () => {
    const gl = fakeGl()
    await withFakeGl({webgl2: gl.context}, () => {
        createRaycaster(canvas()).setVolume(volume)
    })

    const {context} = gl
    // `R8UI` and `RED_INTEGER`: a palette index is a number the shader looks up, not a shade it
    // filters. Normalised, index 1 would arrive as 1/255 and every voxel would be colour zero.
    expect(gl.once('texImage3D')).toEqual([
        context.TEXTURE_3D,
        0,
        context.R8UI,
        4,
        5,
        6,
        0,
        context.RED_INTEGER,
        context.UNSIGNED_BYTE,
        volume.data
    ])

    const [colour, emissive] = gl.of('texImage2D')
    expect(colour?.args).toEqual([
        context.TEXTURE_2D,
        0,
        context.RGBA8,
        256,
        1,
        0,
        context.RGBA,
        context.UNSIGNED_BYTE,
        volume.palette
    ])
    // Emission is its own single-channel texture, not the palette's spare alpha: a `.vox` palette's
    // alpha already means transparency.
    expect(emissive?.args).toEqual([
        context.TEXTURE_2D,
        0,
        context.R8,
        256,
        1,
        0,
        context.RED,
        context.UNSIGNED_BYTE,
        volume.emissive
    ])

    expect(gl.uniform('uDim')).toEqual([4, 5, 6])
})

test('every texture is nearest-filtered and clamped, on all three axes for the grid', async () => {
    const gl = fakeGl()
    await withFakeGl({webgl2: gl.context}, () => {
        createRaycaster(canvas()).setVolume(volume)
    })

    const {context} = gl
    const params = gl.of('texParameteri').map(call => call.args)
    // Every filter is NEAREST. A voxel that gets interpolated is a voxel with a wrong index.
    for (const [, name, value] of params)
        if (name === context.TEXTURE_MIN_FILTER || name === context.TEXTURE_MAG_FILTER)
            expect(value).toBe(context.NEAREST)

    // R as well as S and T: a ray leaving the grid along z must clamp like one leaving along x.
    const wraps = params
        .filter(([target]) => target === context.TEXTURE_3D)
        .filter(([, name]) =>
            (
                [
                    context.TEXTURE_WRAP_S,
                    context.TEXTURE_WRAP_T,
                    context.TEXTURE_WRAP_R
                ] as unknown[]
            ).includes(name)
        )
    expect(wraps).toHaveLength(3)
    for (const [, , value] of wraps) expect(value).toBe(context.CLAMP_TO_EDGE)
})

test('resizing sizes the canvas in real pixels and tells the shader the same numbers', async () => {
    const gl = fakeGl()
    const element = canvas()
    await withFakeGl({webgl2: gl.context}, () => {
        createRaycaster(element).resize(640, 480)
    })

    expect([element.width, element.height]).toEqual([640, 480])
    expect(gl.once('viewport')).toEqual([0, 0, 640, 480])
    expect(gl.uniform('uWidth')).toEqual([640])
    expect(gl.uniform('uHeight')).toEqual([480])
})

/*
 * The basis is the whole contract between the two backends: `docs/techstack.md` §2 holds them to
 * producing the same pixels, and they can only do that if the CPU's `right` is the GPU's `uRight`.
 * A pair of these swapped is a picture that is wrong in a way no single-backend test can see.
 */
test('every basis component reaches the uniform of its own name', async () => {
    const gl = fakeGl()
    const basis = basisFor(createCamera(volume, 0.7, 0.3), volume, 128)
    await withFakeGl({webgl2: gl.context}, async () => {
        await createRaycaster(canvas()).renderNow(basis, MODE_NORMAL, true)
    })

    expect(gl.uniform('uForward')).toEqual([...basis.forward])
    expect(gl.uniform('uRight')).toEqual([...basis.right])
    expect(gl.uniform('uUp')).toEqual([...basis.up])
    expect(gl.uniform('uCenter')).toEqual([...basis.center])
    expect(gl.uniform('uScale')).toEqual([basis.scale])
    expect(gl.uniform('uDist')).toEqual([basis.dist])
    expect(gl.uniform('uDepthRange')).toEqual([basis.depthRange])
    expect(gl.uniform('uMode')).toEqual([MODE_NORMAL])
    expect(gl.uniform('uEdges')).toEqual([1])
})

test('colour and no lattice are what a render defaults to', async () => {
    const gl = fakeGl()
    await withFakeGl({webgl2: gl.context}, async () => {
        await createRaycaster(canvas()).renderNow(basisFor(createCamera(volume, 0, 0), volume, 64))
    })

    expect(gl.uniform('uMode')).toEqual([0])
    expect(gl.uniform('uEdges')).toEqual([0])
})

/*
 * The frame counter is the only thing a test outside the browser suite has to hang a render on, so
 * it has to mean "the frame landed" rather than "a draw was issued". `gl.finish()` does not give
 * that — Chrome's command buffer returns from it long before the GPU is done. Reading one pixel
 * back really blocks, so the order here is the property: clear, draw, read, *then* count.
 */
test('a frame is counted only after one pixel has been read back', async () => {
    const gl = fakeGl()
    const basis = basisFor(createCamera(volume, 0, 0), volume, 64)
    let counted: number[] = []

    await withFakeGl({webgl2: gl.context}, async () => {
        const raycaster = createRaycaster(canvas())
        expect(raycaster.frames).toBe(0)
        counted = [await raycaster.renderNow(basis), await raycaster.renderNow(basis)]
        expect(raycaster.frames).toBe(2)
    })

    expect(counted).toEqual([1, 2])
    expect(gl.first('clear')).toBeLessThan(gl.first('drawArrays'))
    expect(gl.first('drawArrays')).toBeLessThan(gl.first('readPixels'))
    expect(gl.of('drawArrays')[0]?.args).toEqual([gl.context.TRIANGLES, 0, 3])
    // One pixel, not the buffer: the stall is the point, the data is not.
    expect(gl.of('readPixels')[0]?.args.slice(0, 4)).toEqual([0, 0, 1, 1])
    // Cleared to fully transparent, so the page shows through where the ray missed.
    expect(gl.of('clearColor')[0]?.args).toEqual([0, 0, 0, 0])
})

test('reading the frame back gives one RGBA quad per canvas pixel', async () => {
    const gl = fakeGl({pixel: [9, 8, 7, 255]})
    const element = canvas()
    let pixels: ReturnType<Raycaster['readPixels']> = new Uint8Array(0)

    await withFakeGl({webgl2: gl.context}, () => {
        const raycaster = createRaycaster(element)
        raycaster.resize(8, 4)
        pixels = raycaster.readPixels()
    })

    expect(pixels.length).toBe(8 * 4 * 4)
    expect([...pixels.slice(0, 4)]).toEqual([9, 8, 7, 255])
    const full = gl.of('readPixels').at(-1)?.args
    expect(full?.slice(0, 4)).toEqual([0, 0, 8, 4])
})

test('disposing loses the context through the extension that exists for it', async () => {
    const gl = fakeGl()
    await withFakeGl({webgl2: gl.context}, () => {
        createRaycaster(canvas()).dispose()
    })

    expect(gl.once('getExtension')).toEqual(['WEBGL_lose_context'])
    expect(gl.of('loseContext')).toHaveLength(1)
})
