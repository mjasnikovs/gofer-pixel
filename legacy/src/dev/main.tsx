import '@astryxdesign/core/reset.css'
import '@astryxdesign/core/astryx.css'
import '@astryxdesign/theme-neutral/theme.css'

import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import {App} from './App'

const root = document.getElementById('root')

if (!root) {
    throw new Error('#root is missing from index.html')
}

createRoot(root).render(
    <StrictMode>
        <App />
    </StrictMode>
)
