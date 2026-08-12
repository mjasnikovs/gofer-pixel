/*
 * One stateless call to llama-server.
 *
 * **Every call is a fresh session and nothing here has to arrange that.** Verified against the live
 * server on 2026-08-12: a request asking "what was in the image I just showed you", sent straight
 * after an image request on the same endpoint, answered "I cannot see any image." `/v1/chat/completions`
 * is conditioned on the messages in the body and on nothing else — the KV prefix cache reuses tokens
 * that already match, never content the body did not carry.
 *
 * Temperature 0 and a fixed seed, because this is a measurement and not a candidate.
 */
export const ENDPOINT = 'http://localhost:8080'

export type Part =
    | {readonly type: 'text'; readonly text: string}
    | {readonly type: 'image_url'; readonly image_url: {readonly url: string}}

export const textPart = (text: string): Part => ({type: 'text', text})

export const imagePart = (base64: string): Part => ({
    type: 'image_url',
    image_url: {url: `data:image/png;base64,${base64}`}
})

export interface Reply {
    readonly said: string
    readonly ms: number
}

interface ChatReply {
    choices?: {message?: {content?: string}}[]
}

/**
 * A GBNF grammar admitting exactly one option and nothing else.
 *
 * Verified against the live server, 2026-08-12: asked "is the sky green, explain first" under
 * `root ::= "yes" | "no"` with 16 tokens, the reply was `no` — the explanation cannot happen.
 *
 * It is a *condition*, never the default, and the reason is finding 7 in `CLAUDE.md`: a constrained
 * reply starts on its first answer token, so it has nowhere to think. That was measured about
 * drawing, not about a one-word classification, so whether it costs anything here is a question with
 * an answer — see the `recheck` stage.
 */
const grammarFor = (options: readonly string[]): string =>
    `root ::= ${options.map(option => `"${option}"`).join(' | ')}`

export const askOnce = async (
    parts: readonly Part[],
    maxTokens = 24,
    options?: readonly string[],
    seed = 7
): Promise<Reply> => {
    const started = performance.now()
    const response = await fetch(`${ENDPOINT}/v1/chat/completions`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            messages: [{role: 'user', content: parts}],
            max_tokens: maxTokens,
            temperature: 0,
            seed,
            ...(options ? {grammar: grammarFor(options)} : {})
        })
    })
    if (!response.ok) throw new Error(`llama-server ${String(response.status)}`)
    const body = (await response.json()) as ChatReply
    return {said: (body.choices?.[0]?.message?.content ?? '').trim(), ms: performance.now() - started}
}

export const probeServer = async (): Promise<string | undefined> => {
    try {
        const response = await fetch(`${ENDPOINT}/v1/models`)
        if (!response.ok) return undefined
        const body = (await response.json()) as {data?: {id?: string}[]}
        return body.data?.[0]?.id ?? 'unknown'
    } catch {
        return undefined
    }
}
