import {afterEach, describe, expect, test} from 'bun:test'
import {generateMany, generateOne} from './llama'
import type {VoxSpec} from './ops'

/**
 * A stub server rather than the real one: these tests are about the request we send and what we do
 * with the reply, and a unit test that needs a 27B model loaded is a test nobody runs. The live
 * server is exercised by hand and by `voxbatch.py`.
 */
const spec: VoxSpec = {
    name: 'tower',
    size: [4, 4, 4],
    mirror_x: false,
    ops: [{op: 'box', from: [0, 0, 0], to: [1, 1, 3], color: '#808080'}]
}

interface Sent {
    body: Record<string, unknown>
}

const stub = (
    reply: (sent: Sent) => {status?: number; content?: string; model?: string; text?: string}
) => {
    const sent: Sent[] = []
    const original = globalThis.fetch
    globalThis.fetch = ((_url: string, init?: {body?: string}) => {
        const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
        sent.push({body})
        const out = reply({body})
        const status = out.status ?? 200
        if (status !== 200) {
            return Promise.resolve(new Response(out.text ?? 'boom', {status}))
        }
        return Promise.resolve(
            new Response(
                JSON.stringify({
                    model: out.model ?? 'stub',
                    choices: [{message: {content: out.content ?? JSON.stringify(spec)}}]
                }),
                {status: 200, headers: {'Content-Type': 'application/json'}}
            )
        )
    }) as typeof globalThis.fetch
    return {
        sent,
        restore: () => {
            globalThis.fetch = original
        }
    }
}

let active: {restore: () => void} | null = null
afterEach(() => {
    active?.restore()
    active = null
})

describe('generateOne', () => {
    test('sends the schema so decoding is constrained, and records the sampler it used', async () => {
        const server = stub(() => ({}))
        active = server
        const candidate = await generateOne('a stone tower', {
            sampler: {temperature: 0.3, seed: 42}
        })

        const body = server.sent[0]?.body as {
            response_format?: {type?: string; json_schema?: {schema?: unknown}}
            temperature?: number
            seed?: number
        }
        expect(body.response_format?.type).toBe('json_schema')
        expect(body.response_format?.json_schema?.schema).toBeDefined()
        expect(body.temperature).toBe(0.3)
        expect(body.seed).toBe(42)

        expect(candidate.record.sampler).toEqual({temperature: 0.3, seed: 42})
        expect(candidate.record.prompt).toBe('a stone tower')
        expect(candidate.record.model).toBe('stub')
        expect(candidate.voxels.voxels.size).toBe(16)
    })

    test('a seed is invented and kept when none is given, so the run is reproducible', async () => {
        active = stub(() => ({}))
        const candidate = await generateOne('anything')
        expect(Number.isInteger(candidate.record.sampler.seed)).toBe(true)
    })

    test('an HTTP failure surfaces the status', async () => {
        active = stub(() => ({status: 503, text: 'no slot'}))
        let message = ''
        try {
            await generateOne('x')
        } catch (error) {
            message = String(error)
        }
        expect(message).toContain('503')
        expect(message).toContain('no slot')
    })

    test('a spec that rasterises to nothing is a failure, not an empty document', async () => {
        active = stub(() => ({
            content: JSON.stringify({
                ...spec,
                ops: [{op: 'box', from: [99, 99, 99], to: [99, 99, 99], color: '#808080'}]
            })
        }))
        let message = ''
        try {
            await generateOne('x')
        } catch (error) {
            message = String(error)
        }
        expect(message).toContain('no voxels')
    })
})

describe('generateMany', () => {
    test('keeps the good ones and reports the failures instead of retrying', async () => {
        let call = 0
        active = stub(() => {
            call += 1
            return call === 2 ? {status: 500, text: 'busy'} : {}
        })
        const progress: number[] = []
        const result = await generateMany('a stone tower', 3, {
            onProgress: done => progress.push(done)
        })

        expect(result.candidates.length).toBe(2)
        expect(result.failures.length).toBe(1)
        expect(result.failures[0]).toContain('500')
        expect(progress).toEqual([1, 2, 3])
    })
})
