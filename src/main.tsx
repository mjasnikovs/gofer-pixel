import '@astryxdesign/core/reset.css'
import '@astryxdesign/core/astryx.css'
import '@astryxdesign/theme-neutral/theme.css'
import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import {App} from './App'

const host = document.getElementById('root')
if (host) {
    createRoot(host).render(
        <StrictMode>
            <App />
        </StrictMode>
    )
}
