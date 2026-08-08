// First, and it has to stay first: it turns off a dev-only cost that React measures once, when
// `react-dom` is evaluated. See the file.
import './react-timing'

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
import {loadDocument} from './doc/save'
import {browserStore, latestSnapshot} from './doc/store'
import {readVox} from './vox/vox-file'

/*
 * The browser suite drives the app through this rather than by polling the DOM — see
 * `app/handle.ts`. Published before the `await` below, so that a test which has finished loading
 * the page can always reach `firstFrame`; published after it, there is a window in which the
 * handle does not exist yet and the test's own first call is what races.
 */
;(globalThis as unknown as {goferPixel: typeof handle}).goferPixel = handle

/**
 * What opens: the last autosave if there is one, and `car.vox` otherwise.
 *
 * Crash recovery without a dialog — `FEATURESET.md` §32. An artist whose browser died wants their
 * work back, not a question about whether they want it back, and the file they started from is one
 * click away in the snapshot list. A save that fails to load is skipped rather than fatal: the
 * worst case has to be an old document, never a window that will not open.
 */
const recovered = (() => {
    const store = browserStore()
    const latest = latestSnapshot(store)
    return latest ? loadDocument(latest) : undefined
})()

const volume =
    recovered?.volume ?? readVox(new Uint8Array(await (await fetch(carVox)).arrayBuffer()))
const name = recovered?.name ?? 'car.vox'

const host = document.getElementById('root')
if (host) {
    createRoot(host).render(
        <StrictMode>
            <Theme
                theme={goferPixelTheme}
                mode='dark'
            >
                {/*
                 * `unsaved`, because a snapshot only exists when an edit was committed and not
                 * written to disk. Handing it back as a saved document would let the artist close
                 * the tab without a word and lose the very work this recovery just returned.
                 */}
                <App
                    volume={volume}
                    name={name}
                    opened={recovered ? {...recovered, name, unsaved: true} : undefined}
                />
            </Theme>
        </StrictMode>
    )
}
