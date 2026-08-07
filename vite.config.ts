import {defineConfig, type UserConfig} from 'vite'
import react from '@vitejs/plugin-react'

// gofer-pixel is an application, not a package: `vite build` emits a deployable bundle
// from index.html. There is no library entry and no .d.ts step.
export default defineConfig((): UserConfig => ({
    plugins: [react()],
    clearScreen: false,
    server: {
        port: 1430,
        strictPort: true
    },
    build: {
        sourcemap: true
    }
}))
