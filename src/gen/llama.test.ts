import {expect, test} from 'bun:test'
import {countFilled, type VoxSpec} from './ops'
import {
    browserLlama,
    generateMany,
    memoryLlama,
    SYSTEM,
    type Attempt,
    type Candidate
} from './llama'
import {readManifest, type Manifest, type WorkedExample} from './bank'
import MANIFEST from '../assets/examples/examples.json'

const manifest: Manifest = readManifest(MANIFEST) ?? {fallback: 'tower', entries: []}

const dog: WorkedExample = {prompt: 'a dog', reply: "box(0,0,0, 1,1,1, '#8b5a2b')"}
const tall: WorkedExample = {prompt: 'a stone tower', reply: "box(0,0,0, 1,7,1, '#8a8a86')"}

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

/** The attempts that produced something. One line, and it was an export nothing but this used. */
const landed = (attempts: readonly Attempt[]): readonly Candidate[] =>
    attempts.filter(attempt => attempt.ok).map(attempt => attempt.candidate)

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
    const candidate = landed(attempts)[0]
    if (!candidate) throw new Error('expected a candidate')

    expect(countFilled(candidate.volume)).toBe(4 * 4 * 8)
    expect(candidate.record).toEqual({
        prompt: 'a stone tower',
        sampler: {temperature: 0.5, seed: 7},
        model: 'memory',
        // Which examples the batch was shown, because the pick is its own model call and prompt
        // plus seed no longer reproduce a candidate without it.
        examples: ['dog'],
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
    expect(landed(attempts)).toHaveLength(2)
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

test('the browser port sends the sampler, the system prompt and the worked example', async () => {
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
                    choices: [{message: {content: "box(0,0,0, 3,3,7, '#808080')"}}]
                })
            )
        )
    }) as unknown as typeof fetch

    try {
        const {spec, model} = await browserLlama(manifest, 'http://x:8080').generate(
            'a tower',
            {temperature: 0.8, seed: 12},
            [dog, tall]
        )
        // The code format carries no name of its own, so the prompt is the name.
        expect(spec.name).toBe('a tower')
        expect(model).toBe('qwen')
    } finally {
        globalThis.fetch = original
    }

    const [call] = sent
    expect(call?.url).toBe('http://x:8080/v1/chat/completions')
    expect(call?.body['seed']).toBe(12)
    expect(call?.body['temperature']).toBe(0.8)
    // No decoding grammar: a schema-constrained reply has nowhere to think, and the proportions
    // comment the code format opens with is where the thinking happens.
    expect(call?.body['response_format']).toBeUndefined()
    expect(JSON.stringify(call?.body['messages'])).toContain(SYSTEM.slice(0, 40))
    /*
     * The worked examples go as prior turns, not as quotes in the system prompt, and every one the
     * pick named is sent — in the order it was handed over, so the last sits against the prompt.
     */
    expect(call?.body['messages']).toMatchObject([
        {role: 'system'},
        {role: 'user', content: dog.prompt},
        {role: 'assistant', content: dog.reply},
        {role: 'user', content: tall.prompt},
        {role: 'assistant', content: tall.reply},
        {role: 'user', content: 'a tower'}
    ])
})

test('no examples still generates, rather than refusing to ask', async () => {
    const original = globalThis.fetch
    let body: Record<string, unknown> = {}
    globalThis.fetch = ((_url: string, init: {body: string}) => {
        body = JSON.parse(init.body) as Record<string, unknown>
        return Promise.resolve(
            new Response(
                JSON.stringify({choices: [{message: {content: "box(0,0,0, 1,1,1, '#fff000')"}}]})
            )
        )
    }) as unknown as typeof fetch
    try {
        await browserLlama(manifest).generate('a tower', {temperature: 0.8, seed: 1}, [])
    } finally {
        globalThis.fetch = original
    }
    // System turn and prompt, nothing between them. A worse model, never a broken call.
    expect(body['messages']).toMatchObject([{role: 'system'}, {role: 'user', content: 'a tower'}])
})

test('a reply that is not runnable code is an error, not a half-built model', async () => {
    const bodies = ['this is prose, not a program', 'const x =']
    const original = globalThis.fetch
    let next = 0
    globalThis.fetch = (() => {
        const content = bodies[next] ?? ''
        next += 1
        return Promise.resolve(new Response(JSON.stringify({choices: [{message: {content}}]})))
    }) as unknown as typeof fetch

    const errors: string[] = []
    try {
        const port = browserLlama(manifest)
        for (const _ of bodies) {
            await port
                .generate('a tower', {temperature: 0.8, seed: 1}, [dog])
                .catch((error: unknown) => errors.push(String(error)))
        }
    } finally {
        globalThis.fetch = original
    }

    expect(errors[0]).toContain('no usable ops')
    expect(errors[1]).toContain('no usable ops')
})

test('probing a server that is not there is a no, not a throw', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch
    try {
        expect(await browserLlama(manifest).probe()).toBeUndefined()
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
        expect(await browserLlama(manifest, 'http://x:8080').probe()).toBe('Qwen3.6-27B')
    } finally {
        globalThis.fetch = original
    }
    expect(seen).toEqual(['http://x:8080/v1/models'])
})

test('a server with no model listed is still a server', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.resolve(new Response('{}'))) as unknown as typeof fetch
    try {
        expect(await browserLlama(manifest).probe()).toBe('unknown')
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
        expect(await browserLlama(manifest).probe()).toBeUndefined()
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
