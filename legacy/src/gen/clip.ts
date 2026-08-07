import type {VoxSpec} from './ops'

/**
 * The browser half of the local CLIP scorer (`voxserve.py`).
 *
 * CLIP needs torch on the CPU and cannot run in a page, so the editor sends the op lists it already
 * has and the service rasterises them with the same code the TypeScript port is pinned against.
 *
 * Everything here treats the service as optional. `PRODUCTION_PLAN.md` §9 is explicit that CLIP
 * must not be a quality gate — it ranks candidates for one prompt and nothing else — so the panel's
 * own deterministic scores stand on their own and this is an extra opinion when it happens to be
 * available.
 */
export const DEFAULT_SCORER = 'http://127.0.0.1:8765'

export interface ScorerOptions {
    endpoint?: string
    signal?: AbortSignal
    /** Give up rather than hanging the panel if the service is wedged. */
    timeoutMs?: number
}

const withTimeout = async <T>(
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    outer?: AbortSignal
): Promise<T> => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
        controller.abort()
    }, timeoutMs)
    const forward = (): void => {
        controller.abort()
    }
    outer?.addEventListener('abort', forward)
    try {
        return await run(controller.signal)
    } finally {
        clearTimeout(timer)
        outer?.removeEventListener('abort', forward)
    }
}

/** Is the scorer up? A short timeout, because this runs before every scoring attempt. */
export const probeScorer = async ({
    endpoint = DEFAULT_SCORER,
    timeoutMs = 1500,
    signal
}: ScorerOptions = {}): Promise<boolean> => {
    try {
        const response = await withTimeout(
            inner => fetch(`${endpoint}/health`, {signal: inner}),
            timeoutMs,
            signal
        )
        if (!response.ok) {
            return false
        }
        const body = (await response.json()) as {ok?: boolean}
        return body.ok === true
    } catch {
        return false
    }
}

/**
 * CLIP scores for a batch of candidates, one per spec, `null` where the service could not score
 * one. Throws only if the whole request failed — a single bad spec comes back as a null.
 */
export const scoreWithClip = async (
    prompt: string,
    specs: readonly VoxSpec[],
    {endpoint = DEFAULT_SCORER, timeoutMs = 300000, signal}: ScorerOptions = {}
): Promise<(number | null)[]> => {
    const response = await withTimeout(
        inner =>
            fetch(`${endpoint}/score`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({prompt, specs}),
                signal: inner
            }),
        timeoutMs,
        signal
    )
    if (!response.ok) {
        throw new Error(`scorer ${String(response.status)}: ${await response.text()}`)
    }
    const body = (await response.json()) as {scores?: (number | null)[]}
    return body.scores ?? specs.map(() => null)
}

/**
 * How much two orderings of the same candidates agree, as Spearman's rank correlation.
 *
 * This is the number that says whether `overallScore`'s invented weights (§14) are picking the
 * same winners CLIP would. 1 is identical orders, 0 is unrelated, −1 is reversed. Pairs where
 * either score is missing are dropped.
 */
export const rankAgreement = (
    a: readonly (number | null)[],
    b: readonly (number | null)[]
): number => {
    const pairs = a
        .map((value, i) => ({a: value, b: b[i] ?? null}))
        .filter((pair): pair is {a: number; b: number} => pair.a !== null && pair.b !== null)
    const n = pairs.length
    if (n < 2) {
        return 0
    }
    const ranks = (values: number[]): number[] => {
        const order = values.map((value, i) => ({value, i})).sort((p, q) => p.value - q.value)
        const out = new Array<number>(values.length).fill(0)
        let i = 0
        while (i < order.length) {
            // average the ranks of ties, which is what makes this Spearman rather than an
            // ordering that depends on sort stability
            let j = i
            while (j + 1 < order.length && order[j + 1]?.value === order[i]?.value) {
                j += 1
            }
            const rank = (i + j) / 2 + 1
            for (let k = i; k <= j; k += 1) {
                const entry = order[k]
                if (entry) {
                    out[entry.i] = rank
                }
            }
            i = j + 1
        }
        return out
    }

    const ra = ranks(pairs.map(pair => pair.a))
    const rb = ranks(pairs.map(pair => pair.b))
    const mean = (values: number[]): number => values.reduce((x, y) => x + y, 0) / values.length
    const ma = mean(ra)
    const mb = mean(rb)
    let top = 0
    let leftSq = 0
    let rightSq = 0
    for (let i = 0; i < n; i += 1) {
        const da = (ra[i] ?? 0) - ma
        const db = (rb[i] ?? 0) - mb
        top += da * db
        leftSq += da * da
        rightSq += db * db
    }
    const bottom = Math.sqrt(leftSq * rightSq)
    return bottom === 0 ? 0 : top / bottom
}
