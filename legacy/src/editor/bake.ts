import {atlasMeta, atlasModels, packAtlas, type Atlas, type AtlasOptions} from '../export/atlas'
import type {Document} from '../doc/document'
import type {BakeFailure, BakeRequest, BakeResponse} from '../vox/render-worker'

/**
 * Bake an atlas without blocking the editor.
 *
 * One long-lived Worker rather than one per bake: spinning a Worker up costs more than a small
 * bake, and a person pressing bake twice should not pay for a second module load. Requests carry an
 * id so a reply that arrives after the caller has moved on is ignored rather than resolving the
 * wrong promise.
 *
 * Falls back to baking on the calling thread when there is no `Worker` — Bun's test runner, Node,
 * and anywhere a bundler has not produced the worker chunk. The pixels are identical either way:
 * both paths call `packModels`.
 */
let worker: Worker | null = null
let nextId = 1

const ensureWorker = (): Worker | null => {
    if (typeof Worker === 'undefined') {
        return null
    }
    worker ??= new Worker(new URL('../vox/render-worker.ts', import.meta.url), {type: 'module'})
    return worker
}

/** Drop the Worker, for a test or a teardown that wants the thread back. */
export const stopBakeWorker = (): void => {
    worker?.terminate()
    worker = null
}

export interface BakeResult {
    atlas: Atlas
    /** Milliseconds of render work, as measured wherever it ran. */
    ms: number
    /** False when it had to run on the calling thread after all. */
    offThread: boolean
}

export const bakeAtlas = async (doc: Document, options: AtlasOptions = {}): Promise<BakeResult> => {
    const active = ensureWorker()
    if (!active) {
        const started = performance.now()
        return {atlas: packAtlas(doc, options), ms: performance.now() - started, offThread: false}
    }

    const request: BakeRequest = {
        id: nextId++,
        models: atlasModels(doc),
        meta: atlasMeta(doc),
        options
    }

    return new Promise<BakeResult>((resolve, reject) => {
        const onMessage = ({data}: MessageEvent<BakeResponse | BakeFailure>): void => {
            if (data.id !== request.id) {
                return // a reply to a bake somebody has already moved on from
            }
            active.removeEventListener('message', onMessage)
            active.removeEventListener('error', onError)
            if ('error' in data) {
                reject(new Error(data.error))
                return
            }
            resolve({
                atlas: {albedo: data.albedo, normal: data.normal, sidecar: data.sidecar},
                ms: data.ms,
                offThread: true
            })
        }
        const onError = (event: ErrorEvent): void => {
            active.removeEventListener('message', onMessage)
            active.removeEventListener('error', onError)
            reject(new Error(event.message || 'the render worker failed'))
        }
        active.addEventListener('message', onMessage)
        active.addEventListener('error', onError)
        active.postMessage(request)
    })
}
