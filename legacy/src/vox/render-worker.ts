import {packModels, type Atlas, type AtlasMeta, type AtlasOptions} from '../export/atlas'
import type {VoxModel} from './model'

/**
 * The renderer in a Worker.
 *
 * `PRODUCTION_PLAN.md` §3 argues for the CPU renderer partly because it "runs identically in a
 * Worker, in Node, in Bun, and in CI" — this is the part of that claim that had never actually been
 * run. It matters beyond tidiness: a 32-angle bake of a 32³ model is ~160 ms of solid work, and on
 * the main thread that is ten dropped frames every time somebody presses bake.
 *
 * The message is `VoxModel`s rather than a `Document` because a `Document` holds `Volume`
 * instances, and a class instance loses its methods to structured cloning. A `VoxModel` is a `Map`
 * and plain objects, which survive; the pixel buffers come back as transfers, so the sheets are
 * moved rather than copied.
 */
export interface BakeRequest {
    id: number
    models: VoxModel[]
    meta: AtlasMeta
    options: AtlasOptions
}

export interface BakeResponse {
    id: number
    albedo: {width: number; height: number; data: Uint8Array}
    normal: {width: number; height: number; data: Uint8Array}
    sidecar: Atlas['sidecar']
    /** How long the render itself took, so the caller can report it honestly. */
    ms: number
}

export interface BakeFailure {
    id: number
    error: string
}

/** The whole job, as a pure function — so it can be tested without a Worker at all. */
export const runBake = ({id, models, meta, options}: BakeRequest): BakeResponse => {
    const started = performance.now()
    const atlas = packModels(models, meta, options)
    return {
        id,
        albedo: atlas.albedo,
        normal: atlas.normal,
        sidecar: atlas.sidecar,
        ms: performance.now() - started
    }
}

// `self.postMessage` only exists inside a Worker; importing this module elsewhere must not throw
declare const self: {
    onmessage: ((event: {data: BakeRequest}) => void) | null
    postMessage: (message: BakeResponse | BakeFailure, transfer?: Transferable[]) => void
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    self.onmessage = ({data}: {data: BakeRequest}): void => {
        try {
            const result = runBake(data)
            self.postMessage(result, [result.albedo.data.buffer, result.normal.data.buffer])
        } catch (error) {
            self.postMessage({
                id: data.id,
                error: error instanceof Error ? error.message : String(error)
            })
        }
    }
}
