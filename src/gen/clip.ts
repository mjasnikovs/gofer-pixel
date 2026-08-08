/**
 * The browser half of the local CLIP scorer — `py/clipserve.py`.
 *
 * CLIP is the scorer. Code metrics rate an unreadable tank the same as a good mushroom; CLIP,
 * given N candidates for one prompt, ranks them the way a person would. Its one limit is that it
 * **only ranks candidates of the same prompt** — a good stone tower scores below a mediocre
 * mushroom — so it is a sort order inside one batch and never a quality bar.
 *
 * It needs torch, torch runs on the CPU here because both GPUs are full, and neither fits in a web
 * page. So the page renders the candidates it already has and posts the PNGs, and the service does
 * nothing but CLIP. Everything here treats it as optional: the deterministic scores in `score.ts`
 * stand on their own and this is a better opinion when it happens to be available.
 */
export const DEFAULT_SCORER = 'http://127.0.0.1:8765'

export interface Scorer {
    /** Whether the service is up. Asked before every batch, so it is short and never throws. */
    readonly probe: () => Promise<boolean>
    /**
     * One score per candidate, `null` where the service could not read one. Throws only if the
     * whole request failed — a single bad candidate comes back as a null.
     */
    readonly score: (
        prompt: string,
        candidates: readonly (readonly string[])[],
        signal?: AbortSignal
    ) => Promise<readonly (number | null)[]>
}

/**
 * How long the health probe waits.
 *
 * A duration in production, not in a test. The service is a Python process an artist starts by
 * hand; when it is not there the socket refuses immediately, and when it is *wedged* nothing else
 * will tell the dialog to stop waiting.
 */
const PROBE_MS = 1500

export const browserScorer = (endpoint: string = DEFAULT_SCORER): Scorer => ({
    probe: async () => {
        const timer = new AbortController()
        const stop = setTimeout(() => {
            timer.abort()
        }, PROBE_MS)
        try {
            const response = await fetch(`${endpoint}/health`, {signal: timer.signal})
            if (!response.ok) return false
            const body = (await response.json()) as {ok?: boolean}
            return body.ok === true
        } catch {
            return false
        } finally {
            clearTimeout(stop)
        }
    },
    score: async (prompt, candidates, signal) => {
        const response = await fetch(`${endpoint}/score`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            ...(signal ? {signal} : {}),
            body: JSON.stringify({prompt, candidates})
        })
        if (!response.ok) {
            throw new Error(`scorer ${String(response.status)}: ${await response.text()}`)
        }
        const body = (await response.json()) as {scores?: (number | null)[]}
        return body.scores ?? candidates.map(() => null)
    }
})

/** A canned scorer, for tests. */
export const memoryScorer = (
    scores: readonly (number | null)[],
    up = true
): Scorer & {readonly seen: {prompt: string; views: number}[]} => {
    const seen: {prompt: string; views: number}[] = []
    return {
        seen,
        probe: () => Promise.resolve(up),
        score: (prompt, candidates) => {
            seen.push({prompt, views: candidates.reduce((n, views) => n + views.length, 0)})
            return Promise.resolve(candidates.map((_, i) => scores[i] ?? null))
        }
    }
}

/**
 * How much two orderings of the same candidates agree, as Spearman's rank correlation.
 *
 * The number that says whether `overallScore`'s invented weights are picking the same winners CLIP
 * would. `1` is identical orders, `0` unrelated, `-1` reversed. Pairs where either score is missing
 * are dropped.
 */
export const rankAgreement = (
    a: readonly (number | null)[],
    b: readonly (number | null)[]
): number => {
    const pairs = a
        .map((value, i) => ({a: value, b: b[i] ?? null}))
        .filter((pair): pair is {a: number; b: number} => pair.a !== null && pair.b !== null)
    const n = pairs.length
    if (n < 2) return 0

    const ranks = (values: readonly number[]): number[] => {
        const order = values.map((value, i) => ({value, i})).sort((p, q) => p.value - q.value)
        const out = new Array<number>(values.length).fill(0)
        let i = 0
        while (i < order.length) {
            // Ties take the average of the ranks they span, which is what makes this Spearman
            // rather than an ordering that depends on how stable the sort happened to be.
            let j = i
            while (j + 1 < order.length && order[j + 1]?.value === order[i]?.value) j += 1
            const rank = (i + j) / 2 + 1
            for (let k = i; k <= j; k += 1) {
                const entry = order[k]
                if (entry) out[entry.i] = rank
            }
            i = j + 1
        }
        return out
    }

    const left = ranks(pairs.map(pair => pair.a))
    const right = ranks(pairs.map(pair => pair.b))
    const mean = (values: readonly number[]): number =>
        values.reduce((x, y) => x + y, 0) / values.length
    const ml = mean(left)
    const mr = mean(right)
    let top = 0
    let leftSq = 0
    let rightSq = 0
    for (let i = 0; i < n; i += 1) {
        const dl = (left[i] ?? 0) - ml
        const dr = (right[i] ?? 0) - mr
        top += dl * dr
        leftSq += dl * dl
        rightSq += dr * dr
    }
    const bottom = Math.sqrt(leftSq * rightSq)
    return bottom === 0 ? 0 : top / bottom
}
