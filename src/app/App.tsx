import {useCallback, useEffect, useMemo, useReducer} from 'react'
import {canRemove, shownVolume} from '../doc/objects'
import {toHexPalette} from '../doc/palette'
import {sheetMetadata} from '../sheet/metadata'
import {selectionBounds} from '../doc/selection'
import {canRadial} from '../doc/symmetry'
import type {Raycaster} from '../render/gl'
import type {Volume} from '../render/volume'
import {Viewport} from '../viewport/Viewport'
import type {OrbitEvent, ViewportPointer} from '../viewport/orbit'
import {BrushPanel} from './BrushPanel'
import {CamerasPanel} from './CamerasPanel'
import {writeMetadata, writePalette, writeSheet, writeSprite} from './download'
import {ExportPanel} from './ExportPanel'
import {Header} from './Header'
import {ObjectsPanel} from './ObjectsPanel'
import {RendersPanel} from './RendersPanel'
import {SelectionBar} from './SelectionBar'
import {Timeline} from './Timeline'
import {GridPanel, ToolRail} from './ToolRail'
import {AxisGizmo, GroundGrid, HintBar, SelectionBox, ViewCube} from './ViewportOverlay'
import {ViewsStrip} from './ViewsStrip'
import {allPresets, initialState, presetMaps, reduce, TOOLS} from './state'
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
 *
 * Arrow keys move the selection by one voxel along a grid axis; see the key handler for Shift.
 */
const NUDGES: Record<string, readonly [number, number, number] | undefined> = {
    ArrowRight: [1, 0, 0],
    ArrowLeft: [-1, 0, 0],
    ArrowUp: [0, 1, 0],
    ArrowDown: [0, -1, 0]
}

export const App = ({volume: source, name}: {volume: Volume; name: string}) => {
    const [state, dispatch] = useReducer(reduce, source, initialState)
    // Everything below reads the *document's* volume, not the one the file was opened with. They
    // are the same object until the first stroke, and after it the difference is the whole point.
    const {volume} = state

    /*
     * What is drawn is the grid with hidden objects taken out of it, and everything that renders
     * uses it: the viewport, every thumbnail and the exported sheet. The panels that are about the
     * *document* rather than about the picture — the palette, the object list — keep the whole one.
     */
    const shown = useMemo(() => shownVolume(volume, state.objects), [volume, state.objects])

    const onOrbit = useCallback((event: OrbitEvent, height: number) => {
        dispatch({type: 'orbit', event, height})
    }, [])

    const onPointer = useCallback((event: ViewportPointer) => {
        dispatch({type: 'pointer', event})
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
     * Reading a file is the one thing that needs an element rather than an action: a browser will
     * only open a picker from a real click on a real `<input type=file>`. It is created, clicked
     * and dropped rather than kept in the tree, because a hidden input that lives in the layout is
     * one more thing for the bounding-box test to trip over.
     */
    const loadPalette = useCallback(() => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.hex,.txt,text/plain'
        input.addEventListener('change', () => {
            const file = input.files?.[0]
            if (!file) return
            void file.text().then(text => {
                dispatch({type: 'palette-load', text})
            })
        })
        input.click()
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
            void writeSheet(state.sheet, presetMaps(state, state.preset))
        }
    }, [state.sheet, state.exporting, state.preset])

    // The mockup's `C`, and the two shortcuts nobody looks up. A shortcut that only exists in the
    // hint bar's caption is a caption.
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            const target = event.target
            const isTyping =
                target instanceof HTMLElement
                && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))
            if (isTyping) return
            if (event.metaKey || event.ctrlKey) {
                const key = event.key.toLowerCase()
                if (key === 'z') dispatch({type: event.shiftKey ? 'redo' : 'undo'})
                else if (key === 'c') dispatch({type: 'copy'})
                else if (key === 'v') dispatch({type: 'paste'})
                else return
                event.preventDefault()
                return
            }
            if (event.altKey) return
            if (event.key === 'c' || event.key === 'C') capture()
            if (event.key === 'Escape') dispatch({type: 'clear-selection'})
            // The two brackets that every editor uses for "more of this" and "less of this".
            if (event.key === 'f' || event.key === 'F') dispatch({type: 'focus'})
            if (event.key === ']') dispatch({type: 'grow-selection'})
            if (event.key === '[') dispatch({type: 'shrink-selection'})
            if (event.key === 'Delete' || event.key === 'Backspace') {
                dispatch({type: 'transform', op: {kind: 'delete'}})
            }
            /*
             * Nudging is along the axes of the *model*, not of the screen: a voxel-safe move is by
             * whole cells of the grid, and mapping a screen direction onto a grid axis would have
             * to round somewhere. Shift swaps the horizontal pair for the vertical one, which is
             * the third axis a two-dimensional keyboard cannot otherwise reach.
             */
            const nudge = NUDGES[event.key]
            if (nudge) {
                event.preventDefault()
                const [dx, dy, dz] = nudge
                dispatch({
                    type: 'transform',
                    op: {kind: 'move', delta: event.shiftKey ? [0, 0, dx + dy] : [dx, dy, dz]}
                })
            }
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

    const bounds = useMemo(
        () => selectionBounds(volume, state.selection),
        [volume, state.selection]
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
                        onEmissive={value => {
                            dispatch({type: 'emissive', color: state.color, value})
                        }}
                        recent={state.recent}
                        isLocked={state.paletteLocked}
                        onLock={on => {
                            dispatch({type: 'palette-lock', on})
                        }}
                        onAdd={() => {
                            dispatch({type: 'palette-add'})
                        }}
                        onEyedropper={() => {
                            dispatch({type: 'tool', tool: 'pick'})
                        }}
                        onPaletteColor={css => {
                            dispatch({type: 'palette-color', color: state.color, css})
                        }}
                        onReplace={(from, to) => {
                            dispatch({type: 'replace-color', from, to})
                        }}
                        onSelectColor={index => {
                            dispatch({type: 'select-color', color: index})
                        }}
                        onLoad={loadPalette}
                        onSave={() => {
                            writePalette(toHexPalette(volume.palette))
                        }}
                    />
                </div>

                <div className='stage'>
                    <Viewport
                        volume={shown}
                        camera={state.orbit.camera}
                        map={state.map}
                        onOrbit={onOrbit}
                        onPointer={onPointer}
                        onReady={onReady}
                        onFrame={onFrame}
                    />
                    {state.grid ?
                        <GroundGrid
                            volume={volume}
                            camera={state.orbit.camera}
                        />
                    :   undefined}
                    <SelectionBox
                        volume={shown}
                        camera={state.orbit.camera}
                        bounds={bounds}
                        band={state.band}
                    />
                    <AxisGizmo
                        volume={shown}
                        camera={state.orbit.camera}
                    />
                    <ViewCube
                        volume={shown}
                        camera={state.orbit.camera}
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
                        onCapture={capture}
                    />
                </div>

                <div className='snap-column'>
                    <GridPanel
                        grid={state.grid}
                        snap={state.snap}
                        voxelSize={Math.max(1, Math.round(state.cell / state.orbit.camera.zoom))}
                        symmetry={state.symmetry}
                        canRadial={canRadial(volume)}
                        plane={state.plane}
                        onGrid={on => {
                            dispatch({type: 'grid', on})
                        }}
                        onSnap={on => {
                            dispatch({type: 'snap', on})
                        }}
                        onSymmetry={(axis, on) => {
                            dispatch({type: 'symmetry', axis, on})
                        }}
                        onPlane={axis => {
                            dispatch({type: 'plane', axis})
                        }}
                    />
                </div>

                <ViewsStrip
                    volume={shown}
                    cameras={state.cameras}
                    selected={state.selected}
                    dragging={state.dragging}
                    onSelect={id => {
                        dispatch({type: 'select', id})
                    }}
                    onCapture={capture}
                    onDragStart={id => {
                        dispatch({type: 'drag-camera', id})
                    }}
                    onDragOver={to => {
                        if (state.dragging !== undefined) {
                            dispatch({type: 'reorder-camera', id: state.dragging, to})
                        }
                    }}
                    onDragEnd={() => {
                        if (state.dragging !== undefined) {
                            dispatch({type: 'drag-camera', id: undefined})
                        }
                    }}
                />

                <div className='panel app-rail'>
                    <ObjectsPanel
                        objects={state.objects}
                        query={state.search}
                        canRemove={canRemove(state.objects)}
                        onQuery={query => {
                            dispatch({type: 'search', query})
                        }}
                        onRename={objectName => {
                            dispatch({
                                type: 'object',
                                op: {kind: 'rename', id: state.objects.active, name: objectName}
                            })
                        }}
                        onOp={op => {
                            dispatch({type: 'object', op})
                        }}
                    />
                    <CamerasPanel
                        volume={shown}
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
                        onDirections={count => {
                            dispatch({type: 'directions', count})
                        }}
                        onAlign={() => {
                            dispatch({type: 'align'})
                        }}
                    />
                    <RendersPanel
                        volume={shown}
                        camera={current}
                        map={state.map}
                        size={state.preview}
                        onMap={map => {
                            dispatch({type: 'map', map})
                        }}
                        onSize={size => {
                            dispatch({type: 'preview', size})
                        }}
                    />
                    <ExportPanel
                        volume={shown}
                        cameras={state.cameras}
                        cell={state.cell}
                        sheet={state.sheet}
                        preset={state.preset}
                        presets={allPresets(state)}
                        padding={state.padding}
                        bounds={state.bounds}
                        onPreset={preset => {
                            dispatch({type: 'preset', preset})
                        }}
                        onCell={cell => {
                            dispatch({type: 'cell', cell})
                        }}
                        onExport={onExport}
                        onPadding={padding => {
                            dispatch({type: 'padding', padding})
                        }}
                        onBounds={on => {
                            dispatch({type: 'bounds', on})
                        }}
                        onSprites={() => {
                            if (!state.sheet) return
                            for (const [index, entry] of state.cameras.entries()) {
                                void writeSprite(state.sheet, index, entry.name)
                            }
                        }}
                        onMetadata={() => {
                            if (!state.sheet) return
                            writeMetadata(
                                sheetMetadata(shown, state.cameras, state.sheet, state.bounds)
                            )
                        }}
                        onSavePreset={() => {
                            const chosen = globalThis.prompt('Name this preset')
                            if (chosen === null) return
                            dispatch({
                                type: 'save-preset',
                                name: chosen,
                                maps: presetMaps(state, state.preset)
                            })
                        }}
                    />
                </div>
            </div>

            <Timeline
                volume={shown}
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
