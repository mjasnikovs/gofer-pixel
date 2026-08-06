import {afterEach, describe, expect, test} from 'bun:test'
import {probeScorer, rankAgreement, scoreWithClip} from './clip'
import type {VoxSpec} from './ops'

const spec: VoxSpec = {
    name: 'tower',
    size: [4, 4, 4],
    mirror_x: false,
    ops: [{op: 'box', from: [0, 0, 0], to: [1, 1, 3], color: '#808080'}]
}

const stub = (handler: (path: string, body: unknown) => Response | Promise<Response>) => {
    const seen: {path: string; body: unknown}[] = []
    const original = globalThis.fetch
    globalThis.fetch = ((url: string, init?: {body?: string}) => {
        const body: unknown = init?.body === undefined ? undefined : JSON.parse(init.body)
        seen.push({path: url, body})
        return Promise.resolve(handler(url, body))
    }) as typeof globalThis.fetch
    return {
        seen,
        restore: () => {
            globalThis.fetch = original
        }
    }
}

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}})

let active: {restore: () => void} | null = null
afterEach(() => {
    active?.restore()
    active = null
})

describe('probeScorer', () => {
    test('true when the service answers', async () => {
        active = stub(() => json({ok: true}))
        expect(await probeScorer()).toBe(true)
    })

    test('false — not an error — when it is not running', async () => {
        active = stub(() => {
            throw new Error('ECONNREFUSED')
        })
        expect(await probeScorer()).toBe(false)
    })

    test('false when something else is listening on the port', async () => {
        active = stub(() => json({hello: 'i am not voxserve'}))
        expect(await probeScorer()).toBe(false)
    })
})

describe('scoreWithClip', () => {
    test('sends the specs and returns one score per candidate', async () => {
        const server = stub(() => json({scores: [0.31, 0.22]}))
        active = server
        const scores = await scoreWithClip('a stone tower', [spec, spec])

        expect(scores).toEqual([0.31, 0.22])
        const sent = server.seen[0]?.body as {prompt?: string; specs?: unknown[]}
        expect(sent.prompt).toBe('a stone tower')
        expect(sent.specs?.length).toBe(2)
    })

    test('a candidate the service could not score comes back null, not zero', async () => {
        active = stub(() => json({scores: [0.3, null]}))
        expect(await scoreWithClip('x', [spec, spec])).toEqual([0.3, null])
    })

    test('an HTTP failure surfaces', async () => {
        active = stub(() => new Response('boom', {status: 500}))
        let message = ''
        try {
            await scoreWithClip('x', [spec])
        } catch (error) {
            message = String(error)
        }
        expect(message).toContain('500')
    })
})

describe('rankAgreement', () => {
    test('1 for the same order, -1 for the reverse', () => {
        expect(rankAgreement([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1)
        expect(rankAgreement([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1)
    })

    test('0 when one side is flat, because a flat ranking says nothing', () => {
        expect(rankAgreement([1, 2, 3], [5, 5, 5])).toBe(0)
    })

    test('ties are averaged rather than left to sort order', () => {
        expect(rankAgreement([1, 1, 2], [1, 1, 2])).toBeCloseTo(1)
    })

    test('missing scores drop out of the comparison', () => {
        expect(rankAgreement([1, null, 3], [10, 99, 30])).toBeCloseTo(1)
        expect(rankAgreement([1, null], [10, null])).toBe(0)
    })

    test('a real disagreement lands between the extremes', () => {
        const value = rankAgreement([1, 2, 3, 4], [10, 40, 20, 30])
        expect(value).toBeGreaterThan(0)
        expect(value).toBeLessThan(1)
    })
})
