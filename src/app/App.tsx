import {useCallback, useEffect, useMemo, useReducer} from 'react'
import type {Raycaster} from '../render/gl'
import type {Volume} from '../render/volume'
import {Viewport} from '../viewport/Viewport'
import type {OrbitEvent} from '../viewport/orbit'
import {BrushPanel} from './BrushPanel'
import {CamerasPanel} from './CamerasPanel'
import {writeSheet} from './download'
import {ExportPanel} from './ExportPanel'
import {Header} from './Header'
import {RendersPanel} from './RendersPanel'
import {Timeline} from './Timeline'
import {GridPanel, ToolRail} from './ToolRail'
import {AxisGizmo, GroundGrid, HintBar, ViewCube} from './ViewportOverlay'
import {ViewsStrip} from './ViewsStrip'
import {initialState, reduce, TOOLS} from './state'
import {handle} from './handle'

/**
 * Frame first, as `astryx docs layout` asks. The regions and their budgets are `docs/editor.png`'s
 * own: a 96 px tool rail, a 216 px brush-and-palette column, the viewport taking whatever is left, a
 * 384 px camera-and-export rail down the side, a views strip under the viewport and an animation bar
 * across the foot. Every one is budgeted in px because a tool's panels are sized by what they hold,
 * not by a fraction of the window. The exact column arithmetic is in `app.css`.
 *
 * There is no state here. Everything is `reduce` in `state.ts`, which is why the interesting tests
 * are 1 ms functions rather than a browser driving a UI.
 */
export const App = ({volume, name}: {volume: Volume; name: string}) => {
    const [state, dispatch] = useReducer(reduce, volume, initialState)

    const onOrbit = useCallback((event: OrbitEvent, height: number) => {
        dispatch({type: 'orbit', event, height})
    }, [])

    const onReady = useCallback((raycaster: Raycaster) => {
        handle.raycaster = raycaster
    }, [])

    const onFrame = useCallback(() => {
        handle.markDrawn()
    }, [])

    const capture = useCallback(() => {
        dispatch({type: 'capture'})
    }, [])

    /*
     * Export is one action from two places — the header button and the panel button — and both mean
     * "write the files", not "show me a preview". So it bakes through the reducer, which is what
     * golden-hashes, and writes the PNGs off the sheet the reducer produced rather than off a
     * second render that would only be probably identical.
     */
    const onExport = useCallback(() => {
        dispatch({type: 'bake'})
    }, [])

    useEffect(() => {
        if (state.sheet && state.exporting) {
            dispatch({type: 'written'})
            void writeSheet(state.sheet)
        }
    }, [state.sheet, state.exporting])

    // The mockup's `C`. A shortcut that only exists in the hint bar's caption is a caption.
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            const target = event.target
            const isTyping =
                target instanceof HTMLElement
                && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))
            if (isTyping || event.metaKey || event.ctrlKey || event.altKey) return
            if (event.key === 'c' || event.key === 'C') capture()
        }
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('keydown', onKey)
        }
    }, [capture])

    // Publishing to the browser-test seam is exactly what an effect is for: pushing React's latest
    // state out to something that is not React.
    useEffect(() => {
        handle.state = state
        handle.dispatch = dispatch
    }, [state])

    const current = useMemo(
        () => state.cameras.find(({id}) => id === state.selected),
        [state.cameras, state.selected]
    )

    return (
        <div className='app'>
            <Header
                name={name}
                state={state}
                onWorkspace={workspace => {
                    dispatch({type: 'workspace', workspace})
                }}
                onExport={onExport}
            />

            <div className='app-body'>
                <div className='panel rail-panel'>
                    <ToolRail
                        tools={TOOLS}
                        tool={state.tool}
                        onTool={tool => {
                            dispatch({type: 'tool', tool})
                        }}
                    />
                </div>

                <div className='brush-column'>
                    <BrushPanel
                        volume={volume}
                        brush={state.brush}
                        color={state.color}
                        onBrush={brush => {
                            dispatch({type: 'brush', brush})
                        }}
                        onColor={color => {
                            dispatch({type: 'color', color})
                        }}
                    />
                </div>

                <div className='stage'>
                    <Viewport
                        volume={volume}
                        camera={state.orbit.camera}
                        map={state.map}
                        onOrbit={onOrbit}
                        onReady={onReady}
                        onFrame={onFrame}
                    />
                    {state.grid ?
                        <GroundGrid
                            volume={volume}
                            camera={state.orbit.camera}
                        />
                    :   undefined}
                    <AxisGizmo
                        volume={volume}
                        camera={state.orbit.camera}
                    />
                    <ViewCube
                        volume={volume}
                        camera={state.orbit.camera}
                    />
                    <HintBar onCapture={capture} />
                </div>

                <div className='snap-column'>
                    <GridPanel
                        grid={state.grid}
                        snap={state.snap}
                        voxelSize={Math.max(1, Math.round(state.cell / state.orbit.camera.zoom))}
                        onGrid={on => {
                            dispatch({type: 'grid', on})
                        }}
                        onSnap={on => {
                            dispatch({type: 'snap', on})
                        }}
                    />
                </div>

                <ViewsStrip
                    volume={volume}
                    cameras={state.cameras}
                    selected={state.selected}
                    onSelect={id => {
                        dispatch({type: 'select', id})
                    }}
                    onCapture={capture}
                />

                <div className='panel app-rail'>
                    <CamerasPanel
                        volume={volume}
                        cameras={state.cameras}
                        selected={state.selected}
                        onSelect={id => {
                            dispatch({type: 'select', id})
                        }}
                        onCapture={capture}
                        onDuplicate={() => {
                            dispatch({type: 'duplicate'})
                        }}
                        onDelete={id => {
                            dispatch({type: 'delete', id})
                        }}
                    />
                    <RendersPanel
                        volume={volume}
                        camera={current}
                        map={state.map}
                        onMap={map => {
                            dispatch({type: 'map', map})
                        }}
                    />
                    <ExportPanel
                        volume={volume}
                        cameras={state.cameras}
                        cell={state.cell}
                        sheet={state.sheet}
                        preset={state.preset}
                        onPreset={preset => {
                            dispatch({type: 'preset', preset})
                        }}
                        onCell={cell => {
                            dispatch({type: 'cell', cell})
                        }}
                        onExport={onExport}
                    />
                </div>
            </div>

            <Timeline
                volume={volume}
                camera={current ?? state.cameras[0]}
                frame={state.frame}
                fps={state.fps}
                onFps={fps => {
                    dispatch({type: 'fps', fps})
                }}
            />
        </div>
    )
}
