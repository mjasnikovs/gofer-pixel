import {useEffect, useRef, useState, type PointerEvent as ReactPointerEvent} from 'react'
import type {Camera} from '../render/camera'
import {basisFor} from '../render/camera'
import {createRaycaster, type Raycaster} from '../render/gl'
import type {Volume} from '../render/volume'
import type {OrbitEvent, ViewportPointer} from './orbit'

/**
 * The interactive view: the raycast shader, one canvas, and no render loop of its own.
 *
 * Nothing here schedules a frame. A camera change draws exactly one, synchronously, and pointer
 * moves arrive at the browser's own rate — so the viewport is already paced by the display without
 * `requestAnimationFrame` owning it, and `onReady` hands the drivable renderer out so a test can
 * ask for a frame and know when it landed.
 */
/**
 * Element-relative, because a pick is a ray through a pixel of *this* canvas and `clientX` is a
 * position on the page. The size comes from the same element in the same unit, so the basis the
 * reducer builds at `height` describes the picture the pointer is over.
 */
const report = (
    type: ViewportPointer['type'],
    event: ReactPointerEvent<HTMLDivElement>
): ViewportPointer => {
    const host = event.currentTarget
    const box = host.getBoundingClientRect()
    return {
        type,
        x: event.clientX - box.left,
        y: event.clientY - box.top,
        width: host.clientWidth,
        height: host.clientHeight,
        button: event.button,
        shift: event.shiftKey,
        alt: event.altKey,
        clicks: event.detail
    }
}

export const Viewport = ({
    volume,
    camera,
    map,
    cursor,
    isMovingCamera = false,
    onOrbit,
    onPointer,
    onReady,
    onFrame
}: {
    volume: Volume
    camera: Camera
    map: number
    /**
     * The pointer, as a CSS `cursor` value — see `app/cursors.ts`. It comes in rather than being
     * decided here because which tool is armed is application state, and this component deliberately
     * knows nothing about tools.
     */
    cursor?: string | undefined
    /** A camera drag is in progress, which outranks the tool: the hand is what the artist is doing. */
    isMovingCamera?: boolean
    /** The wheel only. Where a *drag* goes is decided in `reduce`, not here. */
    onOrbit: (event: OrbitEvent, height: number) => void
    onPointer: (event: ViewportPointer) => void
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

    // A stroke hands down a new volume object over the same buffer, so identity is the signal that
    // the grid changed and the 3D texture has to go up again. `texImage3D` of a 128³ grid is 2 MB;
    // at pointer-move rates that is well inside what the bus does, and it keeps the viewport
    // showing the document rather than the document as it was when the canvas was created.
    useEffect(() => {
        glRef.current?.raycaster.setVolume(volume)
    }, [volume])

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
            style={cursor === undefined ? undefined : {cursor}}
            data-moving={isMovingCamera || undefined}
            onContextMenu={event => {
                // The right button orbits, so it must not also open a menu over the model.
                event.preventDefault()
            }}
            onPointerDown={event => {
                event.currentTarget.setPointerCapture(event.pointerId)
                onPointer(report('down', event))
            }}
            onPointerMove={event => {
                onPointer(report('move', event))
            }}
            onPointerUp={event => {
                event.currentTarget.releasePointerCapture(event.pointerId)
                onPointer(report('up', event))
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
