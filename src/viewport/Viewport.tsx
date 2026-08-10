import {useEffect, useRef, useState, type PointerEvent as ReactPointerEvent} from 'react'
import type {Camera} from '../render/camera'
import {basisFor} from '../render/camera'
import {FACE_LIGHT} from '../render/faces'
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
    event: ReactPointerEvent<HTMLDivElement>,
    clicks = 1
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
        // Command as well as Control, so the shortcut is the one the artist's other apps use.
        ctrl: event.ctrlKey || event.metaKey,
        clicks
    }
}

/**
 * How near and how soon a second press has to land to be a double-click.
 *
 * Counted here rather than read off the event, because `PointerEvent.detail` is 0 on `pointerdown`
 * by specification — the browser's own click counter lives on `click` and `dblclick`, and this
 * viewport cannot use those: a selection has to be taken on the press, so that the same gesture can
 * carry on into a drag. Reading `detail` silently made every double-click a single one, and no test
 * outside a browser could see it, because happy-dom and the reducer's own tests both hand the
 * count in.
 *
 * 500 ms is the platform default on every desktop this runs on, and four pixels is the slack a hand
 * needs to press twice without the mouse having moved on purpose.
 */
const DOUBLE_MS = 500
const DOUBLE_PX = 4

export const Viewport = ({
    volume,
    camera,
    map,
    edges = false,
    light = FACE_LIGHT,
    cursor,
    isMovingCamera = false,
    onOrbit,
    onPointer,
    onLeave,
    onReady,
    onFrame
}: {
    volume: Volume
    camera: Camera
    map: number
    /** Draw the voxel lattice over the colour map. Viewport only — no sprite ever carries it. */
    edges?: boolean
    /**
     * The six-face light table — see `render/light.ts`. Unlike `edges`, this one *is* what the
     * sprite carries: the viewport and the exporter multiply by the same seven integers.
     *
     * Its identity is a render dependency, so it must be stable between renders. `lightFor` keeps
     * it so.
     */
    light?: Uint16Array
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
    /**
     * The pointer has left the canvas. Its own callback rather than a fourth `ViewportPointer` type,
     * because there is no position to report: the one fact is that there is no longer one.
     */
    onLeave?: (() => void) | undefined
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
    /** The last press, so the next one can tell whether it is the second of a pair. */
    const clicksRef = useRef({time: 0, x: 0, y: 0, clicks: 0})
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
        void raycaster
            .renderNow(basisFor(camera, volume, size.height), map, edges, light)
            .then(onFrame)
    }, [camera, map, edges, light, size, volume, onFrame])

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
                const last = clicksRef.current
                const repeated =
                    event.timeStamp - last.time <= DOUBLE_MS
                    && Math.abs(event.clientX - last.x) <= DOUBLE_PX
                    && Math.abs(event.clientY - last.y) <= DOUBLE_PX
                const clicks = repeated ? last.clicks + 1 : 1
                clicksRef.current = {
                    time: event.timeStamp,
                    x: event.clientX,
                    y: event.clientY,
                    clicks
                }
                onPointer(report('down', event, clicks))
            }}
            onPointerMove={event => {
                onPointer(report('move', event))
            }}
            onPointerUp={event => {
                event.currentTarget.releasePointerCapture(event.pointerId)
                onPointer(report('up', event))
            }}
            onPointerLeave={() => {
                onLeave?.()
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
