import {expect, test} from 'bun:test'
import {
    clipNote,
    generateNote,
    namingNote,
    ordered,
    pendingSlots,
    runBatch,
    type BatchPorts,
    type BatchState
} from './batch'
import type {WorkedExample} from './bank'
import {memoryScorer, type Scorer} from './clip'
import {memoryLlama, type Llama} from './llama'
import type {VoxSpec} from './ops'
import {memoryVeto, type Veto} from './veto'

/**
 * The pipeline, with no DOM anywhere.
 *
 * These used to be dialog tests: every one of them mounted React, clicked a button and read a
 * `data-testid` to find out what order the stages ran in. Nothing they assert is about a dialog.
 */

const carved = (name: string, colour: string): VoxSpec => ({
    name,
    size: [8, 8, 12],
    mirror_x: false,
    // Ops are y-up and the grid is fitted to them — see `ops.ts`. 6 wide, 12 tall, 6 deep.
    ops: [
        {op: 'box', from: [1, 0, 1], to: [6, 11, 6], color: colour},
        {op: 'erase', from: [2, 4, 2], to: [5, 11, 5]}
    ]
})

const brick: VoxSpec = {
    name: 'brick',
    size: [8, 8, 12],
    mirror_x: false,
    ops: [{op: 'box', from: [0, 0, 0], to: [7, 11, 7], color: '#808080'}]
}

const ports = (
    llama: Llama,
    scorer: Scorer = memoryScorer([], false),
    // Canned silence: the judge answers nothing, which passes every candidate — see `veto.ts`.
    veto: Veto = memoryVeto([''])
): BatchPorts => ({llama, scorer, veto})

const run = async (
    given: BatchPorts,
    request: Partial<Parameters<typeof runBatch>[1]> = {},
    signal?: AbortSignal
): Promise<{final: BatchState; seen: BatchState[]}> => {
    const seen: BatchState[] = []
    const final = await runBatch(
        given,
        {prompt: 'a stone tower', count: 4, naming: false, seed: 1, ...request},
        state => seen.push(state),
        signal
    )
    return {final, seen}
}

test('a batch scores what lands and names the examples that taught it', async () => {
    const {final} = await run(ports(memoryLlama([carved('tower', '#808080'), brick], 'qwen')))

    expect(final.ranked).toHaveLength(4)
    expect(final.stage).toBe('done')
    expect(final.taughtBy).toEqual(['dog'])
    expect(generateNote(final)).toBe('4 candidates, 0 failed · taught by dog')
    // The brick is a solid block and every built-in score rates it down.
    expect(ordered(final)[0]?.candidate.spec.name).not.toBe('brick')
})

test('a candidate that failed is counted and named, not silently dropped', async () => {
    const {final} = await run(
        ports(memoryLlama([carved('tower', '#808080'), new Error('llama-server 503: busy')]))
    )

    // Four asked for, the canned replies alternate: two good, two failed.
    expect(final.ranked).toHaveLength(2)
    expect(final.failures).toHaveLength(2)
    expect(generateNote(final)).toBe(
        '2 candidates, 2 failed · taught by dog — llama-server 503: busy'
    )
})

test('the grid keeps its shape while the model is still answering', async () => {
    const {final, seen} = await run(ports(memoryLlama([carved('tower', '#808080')])))

    // Every snapshot taken while generating accounts for all four slots, so nothing on screen
    // moves under the pointer as each candidate arrives.
    const midway = seen.filter(state => state.stage === 'generating')
    expect(midway.length).toBeGreaterThan(0)
    for (const state of midway) {
        expect(state.ranked.length + pendingSlots(state)).toBe(4)
    }
    expect(pendingSlots(final)).toBe(0)
})

test('naming is never asked for until it is switched on, because it costs a call a candidate', async () => {
    const veto = memoryVeto(['rock'], false)
    const {final} = await run(ports(memoryLlama([carved('tower', '#808080')]), undefined, veto))

    expect(final.naming).toBeUndefined()
    expect(namingNote(final)).toBe('')
    expect(final.ranked.every(entry => entry.veto === null)).toBe(true)
    // Not merely hidden: the server was never asked.
    expect(veto.seen).toHaveLength(0)
})

test('what a candidate reads as is counted, and allowed to move nothing', async () => {
    const {final} = await run(
        ports(
            memoryLlama([carved('tower', '#808080'), brick]),
            undefined,
            // The second of the four is the brick, and the model calls it a rock. That is not the
            // prompt's word and the text call refuses it, so two of the four "fail".
            memoryVeto(['tower', 'rock'], false)
        ),
        {naming: true}
    )

    expect(namingNote(final)).toBe('Naming: 2 of 4 read as the subject')
    /*
     * The order is still the built-in score's, and the brick is still last on its own merits. The
     * naming does not sort: measured live, it put a real cat behind a brick for being called "dog".
     */
    expect(ordered(final)[0]?.veto?.word).toBe('tower')
    expect(ordered(final)[final.ranked.length - 1]?.candidate.spec.name).toBe('brick')
})

test('a word the model stands behind counts the same as one that matched', async () => {
    // "a stone tower" named "castle": not the prompt's word, and the model says it could describe
    // it anyway. Counted as read, and nothing moves either way.
    const {final} = await run(
        ports(memoryLlama([carved('tower', '#808080')]), undefined, memoryVeto(['castle'], true)),
        {naming: true}
    )

    expect(namingNote(final)).toBe('Naming: 4 of 4 read as the subject')
    expect(final.ranked[0]?.veto?.word).toBe('castle')
})

test('a judge that will not say anything says so rather than reporting nought of nought', async () => {
    const {final} = await run(
        ports(memoryLlama([carved('tower', '#808080')]), undefined, memoryVeto([''])),
        {naming: true}
    )

    expect(namingNote(final)).toBe('Naming: the model would not say what these are')
})

test('CLIP takes over the order when the service is up, and says how much it disagreed', async () => {
    const {final} = await run(
        ports(
            memoryLlama([carved('tower', '#808080'), brick, carved('hut', '#664422')]),
            // The brick is second in the batch, and CLIP is told it is the best of the three.
            memoryScorer([0.28, 0.36, 0.3])
        )
    )

    expect(final.rankBy).toBe('clip')
    expect(clipNote(final)).toContain('3 ranked')
    expect(clipNote(final)).toContain('agreement with the built-in order')
    // The built-in order put the brick last; CLIP's opinion is what the grid draws now.
    expect(ordered(final)[0]?.candidate.spec.name).toBe('brick')
    // And the built-in order is still there to go back to.
    expect(ordered(final, 'built-in')[0]?.candidate.spec.name).not.toBe('brick')
})

test('a scorer that is not running costs the ranking, not the candidates', async () => {
    const {final} = await run(ports(memoryLlama([carved('tower', '#808080')])))

    expect(final.ranked).toHaveLength(4)
    expect(final.rankBy).toBe('built-in')
    expect(clipNote(final)).toContain('clipserve.py is not running')
})

test('a scorer that falls over costs the ranking, not the candidates', async () => {
    const broken: Scorer = {
        probe: () => Promise.resolve(true),
        score: () => Promise.reject(new Error('scorer 500: out of memory'))
    }
    const {final} = await run(ports(memoryLlama([carved('tower', '#808080')]), broken))

    expect(final.ranked).toHaveLength(4)
    expect(clipNote(final)).toContain('out of memory')
})

test('a dropped model is taught last, nearest the prompt, and is named as the artist’s own', async () => {
    const llama = memoryLlama([carved('tower', '#808080')])
    const bank: WorkedExample = {prompt: 'a dog', reply: 'box(0,0,0, 1,1,1, "#fff")'}
    const own: WorkedExample = {prompt: 'a stone tower', reply: 'box(0,0,0, 2,2,2, "#888")'}
    const {final} = await run(ports(llama), {teach: () => [bank], reference: own})

    const sent = llama.seen[0]?.examples ?? []
    expect(sent).toHaveLength(2)
    // An explicit drop outranks the picking call's guess, so it goes closest to the prompt.
    expect(sent[1]).toBe(own)
    expect(final.taughtBy).toEqual(['dog', 'your model'])
    expect(generateNote(final)).toContain('taught by dog, your model')
})

test('cancelling keeps what landed and never asks CLIP about a batch that was walked away from', async () => {
    const controller = new AbortController()
    let asked = 0
    const scorer = memoryScorer([0.5, 0.5])
    const held: Llama = {
        probe: () => Promise.resolve('qwen'),
        pick: () => Promise.resolve(['dog']),
        generate: (_prompt, _sampler, _examples, signal) => {
            asked += 1
            if (signal?.aborted === true) return Promise.reject(new Error('cancelled'))
            // The second candidate is where the artist gives up.
            if (asked === 2) controller.abort()
            return Promise.resolve({spec: carved('tower', '#808080'), model: 'q'})
        }
    }
    const {final} = await run(ports(held, scorer), {}, controller.signal)

    expect(asked).toBe(2)
    expect(final.ranked).toHaveLength(2)
    expect(generateNote(final)).toContain('2 candidates')
    expect(scorer.seen).toHaveLength(0)
    expect(clipNote(final)).toBe('')
})

test('a batch that produced nothing stops before the two stages that need candidates', async () => {
    const scorer = memoryScorer([0.5])
    const veto = memoryVeto(['tower'])
    const {final} = await run(ports(memoryLlama([new Error('llama-server 503')]), scorer, veto), {
        naming: true
    })

    expect(final.ranked).toHaveLength(0)
    expect(final.failures).toHaveLength(4)
    expect(veto.seen).toHaveLength(0)
    expect(scorer.seen).toHaveLength(0)
})
