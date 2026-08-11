import {useCallback, useMemo, type Dispatch} from 'react'
import {objectAt} from '../doc/objects'
import {selectionBounds} from '../doc/selection'
import type {Raycaster} from '../render/gl'
import {lightFor} from '../render/light'
import {isPerfect, pixelsPerVoxel} from '../render/perfect'
import type {Volume} from '../render/volume'
import {Viewport} from '../viewport/Viewport'
import type {OrbitEvent, ViewportPointer} from '../viewport/orbit'
import {TOOL_CURSORS} from './cursors'
import {markDrawn, publish} from './handle'
import {ReferenceLayer} from './ReferenceLayer'
import {SelectionBar} from './SelectionBar'
import {
    AxisGizmo,
    BrushGhost,
    GroundGrid,
    HintBar,
    SelectionBox,
    SpanTape,
    ViewCube
} from './ViewportOverlay'
import {previewVolume, type AppAction, type AppState} from './state'

/**
 * The middle of `docs/editor.png`: the picture, everything drawn over it, and the two bars that sit
 * on top of it.
 *
 * It exists for the reason the panels do. `App.tsx` used to hold nine children here and thread
 * `volume` and `camera` into each of them by hand — twenty-eight props of restated `AppState` — and
 * to compute two derivations that nothing else in the window read: the box round the selection, and
 * the name of the locked object standing between the cursor and the edit. Both are arithmetic about
 * what is on screen, so both belong on this side of the seam.
 *
 * The one thing that stays a prop is the picture drop, because it goes through the `Files` port and
 * comes back as an action somebody has to dispatch. Everything else is `state` and `dispatch`.
 *
 * Nothing here is a picture of the *document* — that is the panels. `volume` is the grid as the
 * artist sees it, hidden objects and sliced-off layers already gone; `state.volume` is the whole one
 * and is used only by the two overlays that describe the grid itself, the floor and the hint bar's
 * height.
 */
export const Stage = ({
    state,
    dispatch,
    volume: shown,
    onPicture
}: {
    state: AppState
    dispatch: Dispatch<AppAction>
    /**
     * The grid as the artist sees it — `slicedFor(state, shownVolume(…))`, memoised in `App.tsx`.
     *
     * A prop rather than a call, for the reason every panel's is: recomputing it here would rebuild
     * a whole grid on every pointer move over the viewport.
     */
    volume: Volume
    /**
     * A picture dropped on the viewport — `FEATURESET.md` §33 and §34.
     *
     * A callback because it goes through the `Files` port and the browser's own image decoder, and
     * comes back as an `AppAction` for the app to dispatch. `asVoxels` is the Shift key: plain is
     * reference art to trace, Shift is an import to sculpt.
     */
    onPicture: (file: File | undefined, asVoxels: boolean) => void
}) => {
    const {volume, orbit} = state

    // What the viewport draws — see `previewVolume`. Erase shows its hole and Fill its new paint
    // before the press, because neither change is visible from the outside of a block.
    const drawn = useMemo(() => previewVolume(state, shown), [state, shown])

    const bounds = useMemo(
        () => selectionBounds(volume, state.selection),
        [volume, state.selection]
    )

    /*
     * The locked object standing between the cursor and the edit — the one thing the artist can act
     * on when a press is about to be silent. It goes to the hint bar as a name and to the object
     * list as a row to light up, so "why did nothing happen" and "here is the switch" are the same
     * answer seen twice.
     */
    const blockingId =
        state.hover?.blocked?.reason === 'locked' ? state.hover.blocked.object : undefined
    const blocking =
        blockingId === undefined ? undefined : objectAt(state.objects, blockingId)?.name

    /*
     * Measure's tape, shown only while Measure is armed.
     *
     * It stays on the state across a tool change — an artist who measured a leg and armed Draw has
     * not thrown the measurement away, and coming back to Measure finds it where it was. What it
     * must not do is sit over the model through every stroke of the session: a reading is something
     * to look at, and there is nothing to look at while the hand is drawing. This is the whole of
     * that rule, and it is here rather than in `SpanTape` because the hint bar needs the same answer.
     */
    const tape = state.tool === 'measure' ? state.span : undefined

    /*
     * What a pixel means at this zoom — the hint bar's last hint, and the one derivation on this
     * side of the seam that is about the export rather than the picture.
     *
     * The whole grid, not `shown`: `isPerfect` only needs a volume to build a basis against and the
     * answer does not depend on its size, so hiding an object must not change the number. `cellH` is
     * the height alone, because that is the edge `basisFor` takes its scale from.
     */
    const voxel = useMemo(
        () => ({
            pixels: pixelsPerVoxel(orbit.camera, state.output.cellH),
            even: isPerfect(orbit.camera, volume, state.output.cellH),
            cell: state.output.cellH
        }),
        [orbit.camera, volume, state.output.cellH]
    )

    const onOrbit = useCallback(
        (event: OrbitEvent, height: number) => {
            dispatch({type: 'orbit', event, height})
        },
        [dispatch]
    )

    const onPointer = useCallback(
        (event: ViewportPointer) => {
            dispatch({type: 'pointer', event})
        },
        [dispatch]
    )

    const onLeave = useCallback(() => {
        dispatch({type: 'unaim'})
    }, [dispatch])

    /* The seam the browser suite drives the app through — `handle.ts`. Written to, never read. */
    const onReady = useCallback((raycaster: Raycaster) => {
        publish({raycaster})
    }, [])

    const onFrame = useCallback(() => {
        markDrawn()
    }, [])

    const capture = useCallback(() => {
        dispatch({type: 'capture'})
    }, [dispatch])

    return (
        <div
            className='stage'
            onDragOver={event => {
                event.preventDefault()
            }}
            onDrop={event => {
                event.preventDefault()
                onPicture(event.dataTransfer.files[0], event.shiftKey)
            }}
        >
            <ReferenceLayer
                volume={shown}
                camera={orbit.camera}
                references={state.references}
            />
            <Viewport
                volume={drawn}
                camera={orbit.camera}
                map={state.map}
                edges={state.edges}
                light={lightFor(state.lighting)}
                cursor={TOOL_CURSORS[state.tool]}
                isMovingCamera={orbit.gesture !== undefined}
                onOrbit={onOrbit}
                onPointer={onPointer}
                onLeave={onLeave}
                onReady={onReady}
                onFrame={onFrame}
            />
            {/* The floor describes the grid, not the picture, so it takes the whole volume. */}
            {state.grid ?
                <GroundGrid
                    volume={volume}
                    camera={orbit.camera}
                />
            :   undefined}
            <BrushGhost
                volume={shown}
                camera={orbit.camera}
                hover={state.hover}
            />
            <SelectionBox
                volume={shown}
                camera={orbit.camera}
                bounds={bounds}
                band={state.band}
                losing={state.losing}
            />
            <SpanTape
                volume={shown}
                camera={orbit.camera}
                span={tape}
            />
            <AxisGizmo
                volume={shown}
                camera={orbit.camera}
            />
            <ViewCube
                volume={shown}
                camera={orbit.camera}
            />
            <SelectionBar
                count={state.selection.size}
                onTransform={op => {
                    dispatch({type: 'transform', op})
                }}
                onClear={() => {
                    dispatch({type: 'clear-selection'})
                }}
            />
            <HintBar
                tool={`${(state.tool[0] ?? '').toUpperCase()}${state.tool.slice(1)}`}
                hover={state.hover}
                blocking={blocking}
                height={volume.sz}
                losing={state.losing}
                span={tape}
                voxel={voxel}
                onCapture={capture}
            />
        </div>
    )
}
