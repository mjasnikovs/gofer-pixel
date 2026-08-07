import {useEffect, useRef, useState} from 'react'
import type {Camera} from '../render/camera'
import {basisFor} from '../render/camera'
import {createRaycaster, type Raycaster} from '../render/gl'
import type {Volume} from '../render/volume'
import type {OrbitEvent} from './orbit'

/**
 * The interactive view: the raycast shader, one canvas, and no render loop of its own.
 *
 * Nothing here schedules a frame. A camera change draws exactly one, synchronously, and pointer
 * moves arrive at the browser's own rate — so the viewport is already paced by the display without
 * `requestAnimationFrame` owning it, and `onReady` hands the drivable renderer out so a test can
 * ask for a frame and know when it landed.
 */
export const Viewport = ({
    volume,
    camera,
    map,
    onOrbit,
    onReady,
    onFrame
}: {
    volume: Volume
    camera: Camera
    map: number
    onOrbit: (event: OrbitEvent, height: number) => void
    onReady?: (raycaster: Raycaster) => void
    /** Fired after a frame has landed, not after a draw was issued. */
    onFrame?: (frames: number) => void
}) => {
    const hostRef = useRef<HTMLDivElement>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    // Keyed by the canvas it was built on, not held loose. A GL context belongs to one element for
    // that element's whole life: it cannot be handed to a new canvas, and it must not be thrown
    // away while the old one is still mounted.
    const glRef = useRef<{canvas: HTMLCanvasElement; raycaster: Raycaster} | undefined>(undefined)
    const failureRef = useRef<HTMLDivElement>(null)
    const [size, setSize] = useState<{width: number; height: number}>({width: 0, height: 0})

    // The canvas is sized in device pixels so a voxel edge lands on a pixel edge, capped at 2×
    // because a raycast costs one ray per pixel and a 3× display would triple the bill for nothing.
    useEffect(() => {
        const host = hostRef.current
        if (!host || typeof ResizeObserver === 'undefined') return
        const ratio = Math.min(globalThis.devicePixelRatio || 1, 2)
        const observer = new ResizeObserver(([entry]) => {
            const box = entry?.contentRect
            if (!box) return
            setSize({
                width: Math.max(1, Math.round(box.width * ratio)),
                height: Math.max(1, Math.round(box.height * ratio))
            })
        })
        observer.observe(host)
        return () => {
            observer.disconnect()
        }
    }, [])

    /*
     * Build the context once per canvas element, and do not tear it down on unmount.
     *
     * The obvious cleanup — `dispose()`, which calls `WEBGL_lose_context` — is a trap. In
     * development React mounts, unmounts and remounts every effect on the *same* DOM node, and a
     * canvas whose context has been force-lost hands back that same dead context for ever after.
     * Losing it in cleanup therefore leaves a permanently blank viewport in dev and a working one
     * in production, which is the worst way round.
     *
     * Nothing leaks by not disposing: the context dies with its canvas, and a hot reload that
     * replaces the element gets a new one because the key below no longer matches.
     */
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || glRef.current?.canvas === canvas) return
        try {
            const raycaster = createRaycaster(canvas)
            raycaster.setVolume(volume)
            glRef.current = {canvas, raycaster}
            onReady?.(raycaster)
        } catch (error) {
            // Written to the DOM rather than to state: a context that fails to come up cannot
            // recover, so there is nothing for React to re-render, and an effect that calls
            // setState synchronously is a cascading render for no reason.
            const node = failureRef.current
            if (node) {
                node.textContent = error instanceof Error ? error.message : String(error)
                node.hidden = false
            }
        }
    }, [volume, onReady])

    useEffect(() => {
        const raycaster = glRef.current?.raycaster
        if (!raycaster || size.width === 0) return
        raycaster.resize(size.width, size.height)
        void raycaster.renderNow(basisFor(camera, volume, size.height), map).then(onFrame)
    }, [camera, map, size, volume, onFrame])

    // React's wheel listener is passive, so it cannot stop the page scrolling under a zoom.
    useEffect(() => {
        const host = hostRef.current
        if (!host) return
        const onWheel = (event: WheelEvent): void => {
            event.preventDefault()
            onOrbit({type: 'wheel', delta: event.deltaY}, host.clientHeight)
        }
        host.addEventListener('wheel', onWheel, {passive: false})
        return () => {
            host.removeEventListener('wheel', onWheel)
        }
    }, [onOrbit])

    return (
        <div
            ref={hostRef}
            className='viewport'
            data-testid='viewport'
            onPointerDown={event => {
                event.currentTarget.setPointerCapture(event.pointerId)
                onOrbit(
                    {
                        type: 'pointerdown',
                        x: event.clientX,
                        y: event.clientY,
                        // Middle button or shift is a pan, which is what the mockup's hint bar says.
                        secondary: event.button === 1 || event.shiftKey
                    },
                    event.currentTarget.clientHeight
                )
            }}
            onPointerMove={event => {
                onOrbit(
                    {type: 'pointermove', x: event.clientX, y: event.clientY},
                    event.currentTarget.clientHeight
                )
            }}
            onPointerUp={event => {
                event.currentTarget.releasePointerCapture(event.pointerId)
                onOrbit({type: 'pointerup'}, event.currentTarget.clientHeight)
            }}
        >
            <canvas
                ref={canvasRef}
                className='viewport-canvas'
                data-testid='viewport-canvas'
            />
            <div
                ref={failureRef}
                className='viewport-failure'
                data-testid='viewport-failure'
                hidden
            />
        </div>
    )
}
