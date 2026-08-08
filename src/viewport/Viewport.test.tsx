import {expect, test} from 'bun:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {fakeGl, withFakeGl} from '../../test/fake-gl'
import {basisFor, createCamera} from '../render/camera'
import type {Raycaster} from '../render/gl'
import {MODE_NORMAL} from '../render/raycast.glsl'
import {createVolume, setVoxel} from '../render/volume'
import type {OrbitEvent, ViewportPointer} from './orbit'
import {Viewport} from './Viewport'

/**
 * The viewport, with a recording context behind the canvas — see `test/fake-gl.ts`.
 *
 * Nothing here is about pixels; `browser/parity.spec.ts` owns those. What is held down here is the
 * layer between a mouse and the renderer: where a press says it landed, whether a second press is
 * the second of a pair, that the wheel can still stop the page scrolling, and that a context which
 * refuses to come up says so on screen instead of leaving an empty box.
 */
const volume = createVolume(8, 8, 8, new Uint8Array(256 * 4))
setVoxel(volume, 3, 3, 3, 1)

const camera = createCamera(volume, 0.5, 0.3)

/**
 * A `ResizeObserver` that fires when the test says so, with the box the test names.
 *
 * happy-dom has the class but nothing lays anything out, so a real one would never fire and every
 * assertion below would be waiting on a size that is not coming. The alternative — polling for one
 * — is the sort of duration this suite does not have.
 */
const withSizedHost = async (
    box: {width: number; height: number} | undefined,
    run: (resizeTo: (next: {width: number; height: number}) => void) => Promise<void>
): Promise<void> => {
    const real = globalThis.ResizeObserver
    let fire: ((entry: {contentRect: {width: number; height: number}}) => void) | undefined
    globalThis.ResizeObserver = class {
        constructor(callback: (entries: {contentRect: {width: number; height: number}}[]) => void) {
            fire = entry => {
                callback([entry])
            }
        }
        observe(): void {
            if (box) fire?.({contentRect: box})
        }
        unobserve(): void {
            /* nothing to stop */
        }
        disconnect(): void {
            fire = undefined
        }
    } as unknown as typeof ResizeObserver

    try {
        await run(next => {
            fire?.({contentRect: next})
        })
    } finally {
        globalThis.ResizeObserver = real
    }
}

type ViewportProps = Parameters<typeof Viewport>[0]

interface Mounted {
    readonly host: HTMLElement
    readonly stage: HTMLElement
    readonly pointers: ViewportPointer[]
    readonly orbits: {event: OrbitEvent; height: number}[]
    readonly frames: number[]
    readonly leaves: number[]
    ready: Raycaster | undefined
    rerender: (next: Partial<ViewportProps>) => Promise<void>
    done: () => Promise<void>
}

const show = async (props: Partial<ViewportProps> = {}): Promise<Mounted> => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const state = {
        host,
        pointers: [] as ViewportPointer[],
        orbits: [] as {event: OrbitEvent; height: number}[],
        frames: [] as number[],
        leaves: [] as number[],
        ready: undefined as Raycaster | undefined
    }

    const draw = async (extra: Partial<ViewportProps>): Promise<void> => {
        await act(async () => {
            root.render(
                <Viewport
                    volume={volume}
                    camera={camera}
                    map={0}
                    onOrbit={(event, height) => {
                        state.orbits.push({event, height})
                    }}
                    onPointer={event => {
                        state.pointers.push(event)
                    }}
                    onLeave={() => {
                        state.leaves.push(1)
                    }}
                    onReady={raycaster => {
                        state.ready = raycaster
                    }}
                    onFrame={frames => {
                        state.frames.push(frames)
                    }}
                    {...props}
                    {...extra}
                />
            )
        })
    }

    await draw({})
    const stage = host.querySelector<HTMLElement>('[data-testid="viewport"]')
    if (!stage) throw new Error('no viewport')

    return {
        ...state,
        get ready() {
            return state.ready
        },
        stage,
        rerender: draw,
        done: async () => {
            await act(async () => {
                root.unmount()
            })
            host.remove()
        }
    }
}

/** A press or a move, positioned on the page. The element sits at the origin under happy-dom. */
const pointerAt = (
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    x: number,
    y: number,
    extra: Partial<PointerEventInit> = {}
): PointerEvent =>
    new PointerEvent(type, {bubbles: true, pointerId: 1, clientX: x, clientY: y, ...extra})

test('the canvas comes up and hands its renderer out', async () => {
    const gl = fakeGl()
    await withFakeGl({webgl2: gl.context}, async () => {
        await withSizedHost(undefined, async () => {
            const shown = await show()

            expect(shown.ready).toBeDefined()
            expect(shown.host.querySelector('[data-testid="viewport-canvas"]')).not.toBeNull()
            // The volume goes up with the context, not on the first draw — the viewport is never
            // one frame behind the document it was handed.
            expect(gl.of('texImage3D').at(0)?.args.at(-1)).toBe(volume.data)
            expect(
                shown.host.querySelector<HTMLElement>('[data-testid="viewport-failure"]')?.hidden
            ).toBe(true)

            await shown.done()
        })
    })
})

/*
 * A context that fails cannot recover, so the message is written to the DOM rather than to state.
 * The thing that matters is that it is *written*: an artist looking at an empty black rectangle has
 * no way to tell a broken driver from a model with nothing in it.
 */
test('a context that refuses to come up says why, on screen', async () => {
    await withFakeGl({webgl2: null, webgl: null}, async () => {
        await withSizedHost(undefined, async () => {
            const shown = await show()

            const failure = shown.host.querySelector<HTMLElement>(
                '[data-testid="viewport-failure"]'
            )
            expect(failure?.hidden).toBe(false)
            expect(failure?.textContent).toContain('No WebGL at all')
            expect(shown.ready).toBeUndefined()

            await shown.done()
        })
    })
})

test('the canvas is sized in device pixels and the frame follows the size', async () => {
    const gl = fakeGl()
    await withFakeGl({webgl2: gl.context}, async () => {
        await withSizedHost({width: 300, height: 200}, async resizeTo => {
            const shown = await show()

            // `devicePixelRatio` is 1 here, so the numbers pass straight through. What is being
            // held is that a size arriving draws exactly one frame, and that the frame is counted.
            expect(gl.of('viewport').at(-1)?.args).toEqual([0, 0, 300, 200])
            expect(shown.frames).toEqual([1])

            await act(async () => {
                resizeTo({width: 512, height: 512})
            })
            expect(gl.of('viewport').at(-1)?.args).toEqual([0, 0, 512, 512])
            expect(shown.frames).toEqual([1, 2])

            await shown.done()
        })
    })
})

test('the basis the shader gets is built at the canvas height the pointer is measured in', async () => {
    const gl = fakeGl()
    await withFakeGl({webgl2: gl.context}, async () => {
        await withSizedHost({width: 300, height: 200}, async () => {
            const shown = await show({map: MODE_NORMAL, edges: true})

            const expected = basisFor(camera, volume, 200)
            expect(gl.uniform('uRight')).toEqual([...expected.right])
            expect(gl.uniform('uScale')).toEqual([expected.scale])
            expect(gl.uniform('uMode')).toEqual([MODE_NORMAL])
            expect(gl.uniform('uEdges')).toEqual([1])

            await shown.done()
        })
    })
})

/*
 * A stroke hands down a new volume object over the same buffer, so identity is the only signal the
 * grid changed. Without this the viewport would keep showing the model as it was when the canvas
 * was made, and every edit would look like it did nothing.
 */
test('a new volume object goes back up as a texture', async () => {
    const gl = fakeGl()
    await withFakeGl({webgl2: gl.context}, async () => {
        await withSizedHost({width: 64, height: 64}, async () => {
            const shown = await show()
            const uploads = gl.of('texImage3D').length

            const edited = createVolume(8, 8, 8, volume.palette)
            setVoxel(edited, 2, 2, 2, 1)
            await act(async () => {
                await shown.rerender({volume: edited})
            })
            expect(gl.of('texImage3D').at(-1)?.args.at(-1)).toBe(edited.data)
            expect(gl.of('texImage3D').length).toBeGreaterThan(uploads)

            // The same object again is not a change, and must not cost a 2 MB upload per frame.
            const settled = gl.of('texImage3D').length
            await act(async () => {
                await shown.rerender({volume: edited, map: MODE_NORMAL})
            })
            expect(gl.of('texImage3D')).toHaveLength(settled)

            await shown.done()
        })
    })
})

test('a press reports where it landed inside the canvas, with the modifiers held', async () => {
    const gl = fakeGl()
    await withFakeGl({webgl2: gl.context}, async () => {
        await withSizedHost({width: 300, height: 200}, async () => {
            const shown = await show()

            await act(async () => {
                shown.stage.dispatchEvent(
                    pointerAt('pointerdown', 40, 25, {button: 2, shiftKey: true, metaKey: true})
                )
            })
            await act(async () => {
                shown.stage.dispatchEvent(pointerAt('pointermove', 41, 26, {altKey: true}))
            })
            await act(async () => {
                shown.stage.dispatchEvent(pointerAt('pointerup', 41, 26))
            })

            expect(shown.pointers.map(entry => entry.type)).toEqual(['down', 'move', 'up'])
            expect(shown.pointers[0]).toMatchObject({
                x: 40,
                y: 25,
                button: 2,
                shift: true,
                // Command counts as Control, so the shortcut is the one the artist's other apps use.
                ctrl: true,
                alt: false,
                clicks: 1
            })
            expect(shown.pointers[1]).toMatchObject({alt: true, ctrl: false, clicks: 1})

            await act(async () => {
                shown.stage.dispatchEvent(new PointerEvent('pointerout', {bubbles: true}))
            })
            expect(shown.leaves).toHaveLength(1)

            await shown.done()
        })
    })
})

/*
 * `PointerEvent.detail` is 0 on `pointerdown` by specification, so the browser's own click counter
 * is no help: this viewport takes a selection on the press so the same gesture can carry into a
 * drag, and `click` fires far too late for that. Counting here is the fix, and it is the sort of
 * thing that reads as working right up until someone double-clicks.
 */
test('a second press close in time and space is the second of a pair', async () => {
    const gl = fakeGl()
    await withFakeGl({webgl2: gl.context}, async () => {
        await withSizedHost({width: 300, height: 200}, async () => {
            const shown = await show()
            const pressAt = async (x: number, y: number, at: number): Promise<void> => {
                const event = pointerAt('pointerdown', x, y)
                // `timeStamp` is read-only on a real event, and the count is a function of it.
                Object.defineProperty(event, 'timeStamp', {value: at})
                await act(async () => {
                    shown.stage.dispatchEvent(event)
                })
            }

            await pressAt(100, 100, 1000)
            await pressAt(102, 101, 1200)
            await pressAt(103, 100, 1400)
            expect(shown.pointers.map(entry => entry.clicks)).toEqual([1, 2, 3])

            // Too far away is a new press, and so is too long after.
            await pressAt(160, 100, 1500)
            await pressAt(160, 100, 2200)
            expect(shown.pointers.map(entry => entry.clicks).slice(3)).toEqual([1, 1])

            await shown.done()
        })
    })
})

/*
 * React's own wheel listener is passive, so it cannot call `preventDefault` — the page would scroll
 * under the zoom. The listener is attached by hand for that one reason, which makes "it was
 * prevented" the assertion rather than an implementation detail.
 */
test('the wheel zooms and stops the page scrolling under it', async () => {
    const gl = fakeGl()
    await withFakeGl({webgl2: gl.context}, async () => {
        await withSizedHost({width: 300, height: 200}, async () => {
            const shown = await show()

            const wheel = new WheelEvent('wheel', {bubbles: true, cancelable: true, deltaY: -120})
            await act(async () => {
                shown.stage.dispatchEvent(wheel)
            })

            expect(wheel.defaultPrevented).toBe(true)
            expect(shown.orbits).toHaveLength(1)
            expect(shown.orbits[0]?.event).toEqual({type: 'wheel', delta: -120})

            await shown.done()
        })
    })
})

test('the right button orbits, so it must not also open a menu over the model', async () => {
    const gl = fakeGl()
    await withFakeGl({webgl2: gl.context}, async () => {
        await withSizedHost({width: 300, height: 200}, async () => {
            const shown = await show()

            const menu = new MouseEvent('contextmenu', {bubbles: true, cancelable: true})
            await act(async () => {
                shown.stage.dispatchEvent(menu)
            })
            expect(menu.defaultPrevented).toBe(true)

            await shown.done()
        })
    })
})

test('the cursor and the moving flag are the caller’s to set', async () => {
    const gl = fakeGl()
    await withFakeGl({webgl2: gl.context}, async () => {
        await withSizedHost({width: 300, height: 200}, async () => {
            const plain = await show()
            expect(plain.stage.getAttribute('style')).toBeNull()
            expect(plain.stage.getAttribute('data-moving')).toBeNull()
            await plain.done()

            const armed = await show({cursor: 'crosshair', isMovingCamera: true})
            expect(armed.stage.getAttribute('style')).toContain('crosshair')
            expect(armed.stage.getAttribute('data-moving')).toBe('true')
            await armed.done()
        })
    })
})
