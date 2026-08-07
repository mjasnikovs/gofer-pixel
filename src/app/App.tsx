import {Text} from '@astryxdesign/core/Text'
import {useCallback, useEffect, useReducer} from 'react'
import type {Raycaster} from '../render/gl'
import type {Volume} from '../render/volume'
import {countVoxels} from '../vox/vox-file'
import {Viewport} from '../viewport/Viewport'
import type {OrbitEvent} from '../viewport/orbit'
import {CamerasPanel} from './CamerasPanel'
import {ModelPanel} from './ModelPanel'
import {SheetPanel} from './SheetPanel'
import {initialState, reduce} from './state'
import {handle} from './handle'

/**
 * Frame first, as `astryx docs layout` asks: a header, then three regions — a 232 px model rail, the
 * viewport taking whatever is left, and a 340 px camera-and-export panel. Regions are budgeted in
 * px because a tool's panels are sized by what they hold, not by a fraction of the window.
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

    // Publishing to the browser-test seam is exactly what an effect is for: pushing React's latest
    // state out to something that is not React.
    useEffect(() => {
        handle.state = state
        handle.dispatch = dispatch
    }, [state])

    return (
        <div className='app'>
            <header className='app-header'>
                <span className='app-mark' />
                <Text weight='semibold'>gofer-pixel</Text>
                <span className='app-divider' />
                <Text type='supporting'>{name}</Text>
                <Text
                    type='supporting'
                    color='disabled'
                >
                    · {countVoxels(volume)} voxels
                </Text>
                <span className='spacer' />
                <Text
                    type='supporting'
                    color='disabled'
                >
                    {state.cameras.length} cameras
                </Text>
            </header>

            <div className='app-body'>
                <ModelPanel
                    name={name}
                    volume={volume}
                    map={state.map}
                    onMap={map => {
                        dispatch({type: 'map', map})
                    }}
                />

                <Viewport
                    volume={volume}
                    camera={state.orbit.camera}
                    map={state.map}
                    onOrbit={onOrbit}
                    onReady={onReady}
                />

                <div className='panel app-rail'>
                    <CamerasPanel
                        volume={volume}
                        cameras={state.cameras}
                        selected={state.selected}
                        onSelect={id => {
                            dispatch({type: 'select', id})
                        }}
                        onCapture={() => {
                            dispatch({type: 'capture'})
                        }}
                        onEightDirections={() => {
                            dispatch({type: 'eight-directions'})
                        }}
                        onDelete={id => {
                            dispatch({type: 'delete', id})
                        }}
                    />
                    <SheetPanel
                        sheet={state.sheet}
                        cell={state.cell}
                        onCell={cell => {
                            dispatch({type: 'cell', cell})
                        }}
                        onBake={() => {
                            dispatch({type: 'bake'})
                        }}
                    />
                </div>
            </div>
        </div>
    )
}
