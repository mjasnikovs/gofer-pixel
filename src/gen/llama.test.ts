import {expect, test} from 'bun:test'
import {countFilled, type VoxSpec} from './ops'
import {browserLlama, candidatesOf, generateMany, memoryLlama, SYSTEM, type Attempt} from './llama'

const tower: VoxSpec = {
    name: 'tower',
    size: [8, 8, 8],
    mirror_x: false,
    ops: [{op: 'box', from: [0, 0, 0], to: [3, 3, 7], color: '#808080'}]
}

const empty: VoxSpec = {
    name: 'nothing',
    size: [8, 8, 8],
    mirror_x: false,
    ops: [{op: 'erase', from: [0, 0, 0], to: [7, 7, 7]}]
}

const at = (): Date => new Date(0)

test('every candidate gets its own seed, counting up from the one it was given', async () => {
    const llama = memoryLlama([tower])

    await generateMany(llama, 'a stone tower', 4, {seed: 100, temperature: 0.7, now: at})

    // One seed across four calls at one temperature is one candidate rendered four times.
    expect(llama.seen.map(entry => entry.sampler.seed)).toEqual([100, 101, 102, 103])
    expect(llama.seen.every(entry => entry.sampler.temperature === 0.7)).toBe(true)
    expect(llama.seen.every(entry => entry.prompt === 'a stone tower')).toBe(true)
})

test('a candidate carries the voxels, the spec and what produced it', async () => {
    const attempts = await generateMany(memoryLlama([tower]), 'a stone tower', 1, {
        seed: 7,
        temperature: 0.5,
        now: at
    })
    const candidate = candidatesOf(attempts)[0]
    if (!candidate) throw new Error('expected a candidate')

    expect(countFilled(candidate.volume)).toBe(4 * 4 * 8)
    expect(candidate.record).toEqual({
        prompt: 'a stone tower',
        sampler: {temperature: 0.5, seed: 7},
        model: 'memory',
        at: new Date(0).toISOString()
    })
})

test('a failed candidate is reported, not quietly replaced', async () => {
    const llama = memoryLlama([tower, new Error('llama-server 503: busy'), tower])

    const attempts = await generateMany(llama, 'a stone tower', 3, {now: at})

    expect(attempts.map(attempt => attempt.ok)).toEqual([true, false, true])
    expect(attempts[1]).toEqual({ok: false, error: 'llama-server 503: busy'})
    // Three asked for, three attempted: a silent retry would hide a prompt that has stopped working.
    expect(llama.seen).toHaveLength(3)
    expect(candidatesOf(attempts)).toHaveLength(2)
})

test('a model that rasterises to nothing is a failure rather than an empty document', async () => {
    const attempts = await generateMany(memoryLlama([empty]), 'a stone tower', 1, {now: at})

    expect(attempts[0]).toEqual({ok: false, error: 'the model produced no voxels'})
})

test('the grid fills in as attempts land', async () => {
    const seen: {done: number; total: number; ok: boolean}[] = []

    await generateMany(memoryLlama([tower, new Error('nope')]), 'a tower', 2, {
        now: at,
        onAttempt: (attempt, done, total) => {
            seen.push({done, total, ok: attempt.ok})
        }
    })

    expect(seen).toEqual([
        {done: 1, total: 2, ok: true},
        {done: 2, total: 2, ok: false}
    ])
})

test('a cancel stops the queue instead of finishing it', async () => {
    const controller = new AbortController()
    const llama = memoryLlama([tower])

    const attempts = await generateMany(llama, 'a tower', 8, {
        now: at,
        signal: controller.signal,
        onAttempt: () => {
            controller.abort()
        }
    })

    expect(attempts).toHaveLength(1)
    expect(llama.seen).toHaveLength(1)
})

test('the browser port sends the schema, the sampler and the system prompt', async () => {
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
        return Promise.resolve(
            new Response(
                JSON.stringify({
                    model: 'qwen',
                    choices: [{message: {content: JSON.stringify(tower)}}]
                })
            )
        )
    }) as unknown as typeof fetch

    try {
        const {spec, model} = await browserLlama('http://x:8080').generate('a tower', {
            temperature: 0.8,
            seed: 12
        })
        expect(spec.name).toBe('tower')
        expect(model).toBe('qwen')
    } finally {
        globalThis.fetch = original
    }

    const [call] = sent
    expect(call?.url).toBe('http://x:8080/v1/chat/completions')
    expect(call?.body['seed']).toBe(12)
    expect(call?.body['temperature']).toBe(0.8)
    expect(call?.body['response_format']).toMatchObject({type: 'json_schema'})
    expect(JSON.stringify(call?.body['messages'])).toContain(SYSTEM.slice(0, 40))
})

test('a reply the grammar did not constrain is an error, not a half-built model', async () => {
    const bodies = ['not json at all', JSON.stringify({name: 'x'})]
    const original = globalThis.fetch
    let next = 0
    globalThis.fetch = (() => {
        const content = bodies[next] ?? ''
        next += 1
        return Promise.resolve(new Response(JSON.stringify({choices: [{message: {content}}]})))
    }) as unknown as typeof fetch

    const errors: string[] = []
    try {
        const port = browserLlama()
        for (const _ of bodies) {
            await port
                .generate('a tower', {temperature: 0.8, seed: 1})
                .catch((error: unknown) => errors.push(String(error)))
        }
    } finally {
        globalThis.fetch = original
    }

    expect(errors[0]).toContain('not JSON')
    expect(errors[1]).toContain('no usable ops')
})

test('probing a server that is not there is a no, not a throw', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch
    try {
        expect(await browserLlama().probe()).toBeUndefined()
    } finally {
        globalThis.fetch = original
    }
})

test('a probe that lands names the model the server is actually running', async () => {
    const original = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = ((url: string) => {
        seen.push(url)
        return Promise.resolve(new Response(JSON.stringify({data: [{id: 'Qwen3.6-27B'}]})))
    }) as unknown as typeof fetch
    try {
        expect(await browserLlama('http://x:8080').probe()).toBe('Qwen3.6-27B')
    } finally {
        globalThis.fetch = original
    }
    expect(seen).toEqual(['http://x:8080/v1/models'])
})

test('a server with no model listed is still a server', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.resolve(new Response('{}'))) as unknown as typeof fetch
    try {
        expect(await browserLlama().probe()).toBe('unknown')
    } finally {
        globalThis.fetch = original
    }
})

test('a server that answers with an error is no server at all', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() =>
        Promise.resolve(new Response('model loading', {status: 503}))) as unknown as typeof fetch
    try {
        // 503 while a model loads is the ordinary case here, and it must not read as "ready".
        expect(await browserLlama().probe()).toBeUndefined()
    } finally {
        globalThis.fetch = original
    }
})

test('an attempt is one shape, so a caller cannot read a candidate off a failure', () => {
    const attempts: readonly Attempt[] = [{ok: false, error: 'busy'}]
    expect(
        attempts.map(attempt => (attempt.ok ? attempt.candidate.spec.name : attempt.error))
    ).toEqual(['busy'])
})
