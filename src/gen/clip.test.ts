import {expect, test} from 'bun:test'
import {createVolume, setVoxel} from '../render/volume'
import {browserScorer, memoryScorer, rankAgreement} from './clip'
import {onGrey, rankingViews, toBase64, VIEW_SIZE, VIEW_YAWS} from './views'

const model = () => {
    const volume = createVolume(
        8,
        8,
        8,
        Uint8Array.from({length: 256 * 4}, (_, i) => (i % 4 === 3 ? 255 : 200))
    )
    for (let x = 2; x < 6; x += 1)
        for (let y = 2; y < 6; y += 1) for (let z = 0; z < 8; z += 1) setVoxel(volume, x, y, z, 1)
    return volume
}

test('a candidate is judged on four views, and they are PNGs', async () => {
    const views = await rankingViews(model())

    expect(views).toHaveLength(VIEW_YAWS.length)
    for (const view of views) {
        const bytes = Uint8Array.from(atob(view), character => character.charCodeAt(0))
        expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    }
    // Four different angles of a square tower are not four copies of one picture.
    expect(new Set(views).size).toBeGreaterThan(1)
})

test('the views are opaque, because transparency reaches CLIP as black', () => {
    const composited = onGrey(
        Uint8Array.from([
            255,
            0,
            0,
            255, // an opaque red voxel
            0,
            0,
            0,
            0, //     a miss
            255,
            255,
            255,
            128 // half of a white one
        ])
    )

    expect([...composited.subarray(0, 4)]).toEqual([255, 0, 0, 255])
    expect([...composited.subarray(4, 8)]).toEqual([128, 128, 128, 255])
    expect([...composited.subarray(8, 12)]).toEqual([192, 192, 192, 255])
    expect(VIEW_SIZE).toBe(64)
})

test('base64 survives a buffer past the argument-stack limit', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 5).fill(65)
    expect(atob(toBase64(bytes)).length).toBe(bytes.length)
})

test('the scorer is asked once for the whole batch', async () => {
    const scorer = memoryScorer([0.31, 0.28])

    const scores = await scorer.score('a stone tower', [
        ['a', 'b', 'c', 'd'],
        ['e', 'f', 'g', 'h']
    ])

    expect(scores).toEqual([0.31, 0.28])
    expect(scorer.seen).toEqual([{prompt: 'a stone tower', views: 8}])
})

test('a service that is not there is a no rather than a thrown batch', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch
    try {
        expect(await browserScorer().probe()).toBe(false)
    } finally {
        globalThis.fetch = original
    }
})

test('a service answering something other than ok is not up', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() =>
        Promise.resolve(new Response(JSON.stringify({ok: false})))) as unknown as typeof fetch
    try {
        expect(await browserScorer().probe()).toBe(false)
    } finally {
        globalThis.fetch = original
    }
})

test('the browser scorer posts the prompt and the views, and reads the scores back', async () => {
    const sent: {url: string; body: Record<string, unknown>}[] = []
    const original = globalThis.fetch
    globalThis.fetch = ((url: string, init?: RequestInit) => {
        sent.push({
            url,
            body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
                string,
                unknown
            >
        })
        return Promise.resolve(new Response(JSON.stringify({scores: [0.4, null]})))
    }) as unknown as typeof fetch

    try {
        const scores = await browserScorer('http://x:8765').score('a tower', [['a'], ['b']])
        expect(scores).toEqual([0.4, null])
    } finally {
        globalThis.fetch = original
    }

    expect(sent[0]?.url).toBe('http://x:8765/score')
    expect(sent[0]?.body['prompt']).toBe('a tower')
    expect(sent[0]?.body['candidates']).toEqual([['a'], ['b']])
})

test('a reply with no scores in it is one null per candidate, not a shorter list', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.resolve(new Response('{}'))) as unknown as typeof fetch
    try {
        expect(await browserScorer().score('a tower', [['a'], ['b'], ['c']])).toEqual([
            null,
            null,
            null
        ])
    } finally {
        globalThis.fetch = original
    }
})

test('a refused batch throws with what the service said', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() =>
        Promise.resolve(new Response('need a prompt', {status: 400}))) as unknown as typeof fetch
    try {
        const failed = await browserScorer()
            .score('', [['a']])
            .catch((error: unknown) => String(error))
        expect(failed).toContain('scorer 400')
    } finally {
        globalThis.fetch = original
    }
})

test('two orderings agree, disagree, or are unrelated', () => {
    expect(rankAgreement([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1)
    expect(rankAgreement([1, 2, 3, 4], [40, 30, 20, 10])).toBe(-1)
    // Every candidate at the same deterministic score ranks nothing, which is what four solid
    // bricks in a batch of six actually look like.
    expect(rankAgreement([1, 1, 1, 1], [4, 3, 2, 1])).toBe(0)
})

test('missing scores are dropped from the agreement rather than counted as zero', () => {
    expect(rankAgreement([1, 2, 3], [10, null, 30])).toBe(1)
    expect(rankAgreement([1, 2, 3], [null, null, 30])).toBe(0)
})
