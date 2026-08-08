import {defineConfig, type UserConfig} from 'vite'
import react from '@vitejs/plugin-react'

// gofer-pixel is an application, not a package: `vite build` emits a deployable bundle
// from index.html. There is no library entry and no .d.ts step.
export default defineConfig((): UserConfig => ({
    plugins: [react()],
    // `.vox` is a binary model, not a module. Without this, `import … from './car.vox?url'`
    // resolves in dev and silently emits nothing in a production build.
    assetsInclude: ['**/*.vox'],
    clearScreen: false,
    /*
     * Every astryx entrypoint the app imports, named up front.
     *
     * Vite discovers dependencies by crawling from `index.html`, and a subpath it has not
     * pre-bundled yet is found *while the page is loading* — at which point it optimizes and
     * **full-reloads the page**. That reload lands between `page.goto` returning and the browser
     * suite reading `window.goferPixel`, so the handle is gone and `firstFrame` is undefined. It
     * fails only on a cold `node_modules/.vite`, which is exactly when nobody is looking: the first
     * run after a fresh checkout, or the first run after a component is added here.
     *
     * Listing them is the fix rather than making the suite wait for the handle to reappear, because
     * a wait would hide a real boot failure behind a timeout — see the testing law in `CLAUDE.md`.
     */
    optimizeDeps: {
        include: [
            '@astryxdesign/core',
            '@astryxdesign/core/AlertDialog',
            '@astryxdesign/core/Badge',
            '@astryxdesign/core/Button',
            '@astryxdesign/core/Dialog',
            '@astryxdesign/core/IconButton',
            '@astryxdesign/core/Kbd',
            '@astryxdesign/core/MoreMenu',
            '@astryxdesign/core/NumberInput',
            '@astryxdesign/core/ProgressBar',
            '@astryxdesign/core/RadioList',
            '@astryxdesign/core/SegmentedControl',
            '@astryxdesign/core/Selector',
            '@astryxdesign/core/Switch',
            '@astryxdesign/core/Text',
            '@astryxdesign/core/TextInput'
        ]
    },
    server: {
        port: 1430,
        strictPort: true
    },
    build: {
        sourcemap: true
    }
}))
