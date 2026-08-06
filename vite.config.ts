import {defineConfig, type UserConfig} from 'vite'
import react from '@vitejs/plugin-react'
import {resolve} from 'node:path'

// Two builds share this config:
//   `vite`        — dev playground served from index.html
//   `vite build`  — library bundle, one ESM file plus one stylesheet
export default defineConfig((): UserConfig => ({
    plugins: [react()],
    clearScreen: false,
    server: {
        port: 1430,
        strictPort: true
    },
    build: {
        lib: {
            entry: resolve(import.meta.dirname, 'src/index.ts'),
            formats: ['es'],
            fileName: () => 'gofer-pixel.js'
        },
        rollupOptions: {
            external: ['react', 'react-dom', 'react/jsx-runtime'],
            output: {
                assetFileNames: 'gofer-pixel.[ext]'
            }
        },
        sourcemap: true
    }
}))
