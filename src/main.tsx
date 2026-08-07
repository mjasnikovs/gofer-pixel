import '@astryxdesign/core/reset.css'
import '@astryxdesign/core/astryx.css'
import './theme/gofer-pixel-theme.css'
import './app/app.css'

import {Theme} from '@astryxdesign/core'
import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import {App} from './app/App'
import {handle} from './app/handle'
import {goferPixelTheme} from './theme/gofer-pixel'
import carVox from './assets/car.vox?url'
import {readVox} from './vox/vox-file'

/*
 * The browser suite drives the app through this rather than by polling the DOM — see
 * `app/handle.ts`. Published before the `await` below, so that a test which has finished loading
 * the page can always reach `firstFrame`; published after it, there is a window in which the
 * handle does not exist yet and the test's own first call is what races.
 */
;(globalThis as unknown as {goferPixel: typeof handle}).goferPixel = handle

/**
 * One hard-coded model, as the proof of concept asks for. `car.vox` came over from the old build
 * with its bytes untouched; the reader is new.
 */
const volume = readVox(new Uint8Array(await (await fetch(carVox)).arrayBuffer()))

const host = document.getElementById('root')
if (host) {
    createRoot(host).render(
        <StrictMode>
            <Theme
                theme={goferPixelTheme}
                mode='dark'
            >
                <App
                    volume={volume}
                    name='car.vox'
                />
            </Theme>
        </StrictMode>
    )
}
