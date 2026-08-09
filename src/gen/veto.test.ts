import {expect, test} from 'bun:test'
import {specFromCode} from './code'
import {rasterise} from './ops'
import {
    browserVeto,
    judge,
    memoryVeto,
    namesTheSubject,
    NAMING_QUESTION,
    NAMING_SIZE,
    namingView,
    readName,
    type Veto
} from './veto'
import type {Volume} from '../render/volume'

const cat = (): Volume => {
    const spec = specFromCode("box(0,0,0, 5,4,9, '#804020')", 'a cat')
    if (!spec) throw new Error('the model did not build')
    return rasterise(spec)
}

test('the answer is narrowed to the subject, or thrown away', () => {
    expect(readName('Cat')).toBe('cat')
    expect(readName(' A cat.\n')).toBe('cat')
    expect(readName('a stone tower')).toBe('stone tower')
    // Two words are the format; the head noun is the last one, not the first.
    expect(readName('a small grey robot')).toBe('grey robot')
    // A sentence is the model refusing the format, and its extra words are hedging, not subject.
    expect(readName('I am not sure what this is meant to be, possibly a shape')).toBe('')
})

test('the match is generous, because a good cat once came back "sheep"', () => {
    expect(namesTheSubject('cat', 'a cat')).toBe(true)
    expect(namesTheSubject('cats', 'a cat')).toBe(true)
    expect(namesTheSubject('tower', 'a stone tower')).toBe(true)
    expect(namesTheSubject('stone', 'a stone tower')).toBe(true)
    expect(namesTheSubject('knight', 'a knight with a sword')).toBe(true)
    // Not a match, and not a decision either — these go to the second call.
    expect(namesTheSubject('sheep', 'a cat')).toBe(false)
    expect(namesTheSubject('robot', 'a cat')).toBe(false)
    // The article must never carry a match on its own.
    expect(namesTheSubject('a', 'a cat')).toBe(false)
})

test('a word that is already the subject costs no second call', async () => {
    const veto = memoryVeto(['cat'])
    expect(await judge(veto, cat(), 'a cat')).toEqual({word: 'cat', pass: true})
    expect(veto.seen).toHaveLength(0)
})

test('a different word is put to the model, and its answer decides', async () => {
    const agrees = memoryVeto(['sheep'], true)
    expect(await judge(agrees, cat(), 'a cat')).toEqual({
        word: 'sheep',
        pass: true
    })
    expect(agrees.seen).toEqual([{word: 'sheep', prompt: 'a cat'}])

    const refuses = memoryVeto(['robot'], false)
    expect(await judge(refuses, cat(), 'a cat')).toEqual({
        word: 'robot',
        pass: false
    })
})

test('every way of not getting an answer passes the candidate', async () => {
    // A veto that vetoes cats is worse than no veto, so nothing but an explicit "no" fails.
    expect(await judge(memoryVeto([new Error('llama-server 503')]), cat(), 'a cat')).toEqual({
        word: '',
        pass: true
    })
    expect(await judge(memoryVeto(['']), cat(), 'a cat')).toEqual({
        word: '',
        pass: true
    })
    const broken: Veto = {
        name: () => Promise.resolve('sheep'),
        couldDescribe: () => Promise.reject(new Error('llama-server 500'))
    }
    expect(await judge(broken, cat(), 'a cat')).toEqual({
        word: 'sheep',
        pass: true
    })
})

test('the browser port sends one picture, the measured question, and no temperature', async () => {
    const sent: Record<string, unknown>[] = []
    const original = globalThis.fetch
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
        sent.push(
            JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>
        )
        return Promise.resolve(
            new Response(JSON.stringify({choices: [{message: {content: 'A robot.'}}]}))
        )
    }) as unknown as typeof fetch

    try {
        expect(await browserVeto('http://x:8080').name(cat())).toBe('robot')
    } finally {
        globalThis.fetch = original
    }

    const [call] = sent
    expect(call?.['temperature']).toBe(0)
    // One image, not the four-view strip: a neutral question over a strip says no to everything.
    const content = JSON.stringify(call?.['messages'])
    expect(content.match(/image_url/g)).toHaveLength(2)
    expect(content).toContain(NAMING_QUESTION)
    expect(content).toContain('data:image/png;base64,')
})

test('the second call is text only, and reads a yes as a yes', async () => {
    const sent: Record<string, unknown>[] = []
    const original = globalThis.fetch
    const replies = ['Yes.', 'No, a robot is not a cat.', 'Yesterday']
    let next = 0
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
        sent.push(
            JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>
        )
        const content = replies[next] ?? ''
        next += 1
        return Promise.resolve(new Response(JSON.stringify({choices: [{message: {content}}]})))
    }) as unknown as typeof fetch

    const said: boolean[] = []
    try {
        const port = browserVeto('http://x:8080')
        for (const _ of replies) said.push(await port.couldDescribe('sheep', 'a cat'))
    } finally {
        globalThis.fetch = original
    }

    // The third is the reason it is a word boundary and not `includes('yes')`.
    expect(said).toEqual([true, false, false])
    expect(JSON.stringify(sent[0]?.['messages'])).not.toContain('image_url')
})

test('the naming view is one square render at the size the model looks at', async () => {
    const png = await namingView(cat())
    const bytes = Uint8Array.from(atob(png), character => character.charCodeAt(0))
    // PNG magic, then IHDR: width and height are big-endian at bytes 16 and 20.
    expect([...bytes.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47])
    const head = new DataView(bytes.buffer, bytes.byteOffset)
    expect(head.getUint32(16)).toBe(NAMING_SIZE)
    expect(head.getUint32(20)).toBe(NAMING_SIZE)
})
