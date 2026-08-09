import {expect, test} from 'bun:test'
import {act} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {memoryFiles, type Files} from '../doc/files'
import {memoryStore, type Store} from '../doc/store'
import type {BankEntry} from '../gen/bank'
import {memoryScorer, type Scorer} from '../gen/clip'
import {buildLibrary, type Library} from '../gen/library'
import {memoryLlama, type GenerationRecord, type Llama} from '../gen/llama'
import type {VoxSpec} from '../gen/ops'
import {memoryVeto, type Veto} from '../gen/veto'
import type {Volume} from '../render/volume'
import {GenerateDialog, MAX_CANDIDATES} from './GenerateDialog'

/**
 * The dialog against canned ports. Nothing waits: `memoryLlama` resolves on the microtask queue and
 * `act` flushes it, so a whole batch lands inside one `await act`.
 */
const BANK_ENTRIES: readonly BankEntry[] = [
    {id: 'dog', subject: 'a dog', use: 'stands on four legs', notes: ''},
    {id: 'tower', subject: 'a stone tower', use: 'architecture', notes: ''}
]

const carved = (name: string, colour: string): VoxSpec => ({
    name,
    size: [8, 8, 12],
    mirror_x: false,
    // Ops are y-up and the grid is fitted to them — see `gen/ops.ts`. 6 wide, 12 tall, 6 deep.
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

interface Picked {
    volume: Volume
    name: string
    record: GenerationRecord
}

interface Mounted {
    root: Root
    host: HTMLElement
    picked: Picked[]
    closed: number[]
    /** The batch the last Generate click started — see `onRunning`. */
    batch: () => Promise<void>
}

/**
 * A one-entry bank, so the dialog has a manifest to load without reaching for the real one.
 *
 * The tests drive `llama` directly, so what the bank teaches never reaches a server here. What is
 * under test is that the dialog waits for the load before it offers to generate.
 */
const testLibrary = (): Promise<Library> =>
    buildLibrary({fallback: 'tower', entries: BANK_ENTRIES}, () => Promise.resolve(undefined))

const open = async (
    llama: Llama,
    scorer: Scorer = memoryScorer([], false),
    // Canned silence: the judge answers nothing, which passes every candidate — see `gen/veto.ts`.
    veto: Veto = memoryVeto(['']),
    store: Store = memoryStore(),
    files: Files = memoryFiles()
): Promise<Mounted> => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const picked: Picked[] = []
    const closed: number[] = []
    let running: Promise<void> = Promise.resolve()
    await act(async () => {
        root.render(
            <GenerateDialog
                library={testLibrary}
                llama={llama}
                store={store}
                files={files}
                scorer={scorer}
                veto={veto}
                onClose={() => closed.push(1)}
                onPick={(volume, name, record) => picked.push({volume, name, record})}
                onRunning={batch => {
                    running = batch
                }}
            />
        )
    })
    return {root, host, picked, closed, batch: () => running}
}

/**
 * Press Generate and let the batch finish.
 *
 * Two acts, not one: encoding a candidate's ranking views goes through a `CompressionStream`, which
 * settles on the macrotask queue rather than the microtask one, so the click alone leaves work
 * running past the end of the test. That work then renders into an unmounted tree and — measured —
 * breaks the *next* test file about one run in two. It is not a wait: it awaits the batch itself.
 */
const generate = async (mounted: Mounted): Promise<void> => {
    await act(async () => {
        control('Generate').click()
    })
    await act(async () => {
        await mounted.batch()
    })
}

const close = async (root: Root, host: HTMLElement): Promise<void> => {
    await act(async () => {
        root.unmount()
    })
    host.remove()
}

/*
 * Scoped to the dialog that is actually open. A failing test leaves its own dialog behind in
 * `document.body` — the portal outlives the assertion that threw — and an unscoped query would then
 * read the *previous* test's window and fail the next four for the wrong reason.
 */
const dialog = (): HTMLElement => {
    const found = [
        ...global.document.querySelectorAll<HTMLElement>('[data-testid="generate-dialog"]')
    ]
    const last = found[found.length - 1]
    if (!last) throw new Error('the dialog is not open')
    return last
}

const control = (label: string): HTMLElement => {
    const found = [...dialog().querySelectorAll<HTMLElement>('button, input')].find(
        node => node.getAttribute('aria-label') === label || node.textContent.trim() === label
    )
    if (!found) throw new Error(`nothing labelled "${label}"`)
    return found
}

const said = (testid: string): string =>
    dialog().querySelector(`[data-testid="${testid}"]`)?.textContent.trim() ?? ''

const cards = (): HTMLElement[] => [
    ...dialog().querySelectorAll<HTMLElement>('.generate-card:not(.generate-pending)')
]

/** The empty slots for candidates the model has not answered for yet. */
const pending = (): HTMLElement[] => [
    ...dialog().querySelectorAll<HTMLElement>('[data-testid="generate-pending"]')
]

/**
 * Switch the naming pass on.
 *
 * Astryx's Switch is a real checkbox with a `<label for>` beside it, so it is reached as an input
 * rather than by the text next to it — and it is the only checkbox in this dialog.
 */
const toggleNaming = async (): Promise<void> => {
    const box = dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (!box) throw new Error('the dialog has no naming switch')
    await act(async () => {
        box.click()
    })
}

test('with no server there is nothing to press, and the dialog says why', async () => {
    const down: Llama = {
        probe: () => Promise.resolve(undefined),
        pick: () => Promise.resolve(['dog']),
        generate: () => Promise.reject(new Error('not running'))
    }
    const {root, host} = await open(down)

    expect(said('generate-status')).toContain('No local model')
    // astryx keeps a disabled control in the tab order and marks it `aria-disabled`.
    expect(control('Generate').getAttribute('aria-disabled')).toBe('true')

    await close(root, host)
})

test('a batch fills the grid, and every candidate carries what made it', async () => {
    const mounted = await open(
        memoryLlama([carved('tower', '#808080'), brick, carved('hut', '#664422')], 'qwen')
    )
    const {root, host, picked} = mounted

    expect(said('generate-status')).toBe('Ready — qwen')
    await generate(mounted)

    // Four is the default batch, and the three canned replies cycle to fill it.
    // The examples the whole batch was shown are named, because they are the strongest single
    // influence on what came back.
    expect(said('generate-status')).toBe('4 candidates, 0 failed · taught by dog')
    expect(cards()).toHaveLength(4)
    expect(said('clip-status')).toContain('clipserve.py is not running')
    // The naming switch is off until it is asked for, because it costs a call a candidate.
    expect(said('veto-status')).toBe('')

    await act(async () => {
        control('Use this one').click()
    })

    // The primary button is the best candidate, and the brick is not it.
    expect(picked[0]?.name).not.toBe('brick')
    expect(picked[0]?.record.prompt).toBe('a stone tower')
    expect(picked[0]?.record.model).toBe('qwen')
    expect(picked[0]?.volume.sz).toBe(12)

    await close(root, host)
})

test('CLIP takes over the order when the service is up, and says how much it disagreed', async () => {
    const mounted = await open(
        memoryLlama([carved('tower', '#808080'), brick, carved('hut', '#664422')]),
        // The brick is second in the batch, and CLIP is told it is the best of the three.
        memoryScorer([0.28, 0.36, 0.3])
    )
    const {root, host} = mounted

    await generate(mounted)

    expect(said('clip-status')).toContain('3 ranked')
    expect(said('clip-status')).toContain('agreement with the built-in order')
    // The built-in order put the brick last; CLIP's opinion is what is on screen now.
    expect(cards()[0]?.textContent).toContain('brick')
    expect(cards()[0]?.textContent).toContain('clip 0.360')

    // And the artist can put it back.
    await act(async () => {
        control('Built-in').click()
    })
    expect(cards()[0]?.textContent).not.toContain('brick')

    await close(root, host)
})

test('Enter in the prompt starts the batch, the same way the button does', async () => {
    const mounted = await open(memoryLlama([carved('tower', '#808080')]))
    const {root, host} = mounted
    const field = dialog().querySelector<HTMLInputElement>('input[type="text"]')
    if (!field) throw new Error('the dialog has no prompt field')

    await act(async () => {
        field.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
    })
    await act(async () => {
        await mounted.batch()
    })

    expect(cards()).toHaveLength(4)

    await close(root, host)
})

test('the slots a batch will fill are on screen before the model answers', async () => {
    let release: (() => void) | undefined
    let asked = 0
    const held: Llama = {
        probe: () => Promise.resolve('qwen'),
        pick: () => Promise.resolve(['dog']),
        generate: (_prompt, _sampler, _plan, signal) => {
            asked += 1
            if (signal?.aborted === true) return Promise.reject(new Error('cancelled'))
            // Only the second one waits. Holding every candidate after the first would leave the
            // third in flight for ever and the batch would never settle.
            if (asked !== 2) return Promise.resolve({spec: carved('tower', '#808080'), model: 'q'})
            return new Promise(resolve => {
                release = () => {
                    resolve({spec: carved('hut', '#664422'), model: 'q'})
                }
            })
        }
    }
    const mounted = await open(held)

    expect(pending()).toHaveLength(0)
    await act(async () => {
        control('Generate').click()
    })

    // One candidate landed, one in flight, two not started: four slots either way, so the grid
    // keeps its shape and the thumbnails do not move under the pointer as each one arrives.
    expect(cards()).toHaveLength(1)
    expect(pending()).toHaveLength(3)

    await act(async () => {
        release?.()
        await mounted.batch()
    })

    // Nothing left in flight, nothing left shimmering.
    expect(pending()).toHaveLength(0)

    await close(mounted.root, mounted.host)
})

test('what a candidate reads as reaches the card the artist is looking at', async () => {
    const mounted = await open(
        memoryLlama([carved('tower', '#808080'), brick]),
        memoryScorer([], false),
        // The second of the four is the brick, and the model calls it a rock. That is not the
        // prompt's word and the text call refuses it, so two of the four "fail".
        memoryVeto(['tower', 'rock'], false)
    )
    const {root, host} = mounted

    await toggleNaming()
    await generate(mounted)

    expect(said('veto-status')).toBe('Naming: 2 of 4 read as the subject')
    expect(cards()).toHaveLength(4)
    expect(dialog().textContent).toContain('reads as "rock"')
    /*
     * The order is still the built-in score's, and the brick is still last on its own merits. The
     * naming does not sort: measured live, it put a real cat behind a brick for being called "dog".
     */
    expect(cards()[0]?.textContent).toContain('reads as "tower"')
    expect(cards()[0]?.textContent).toContain('tower')

    await close(root, host)
})

test('closing the dialog mid-batch stops asking the model for models', async () => {
    let asked = 0
    const slow: Llama = {
        probe: () => Promise.resolve('qwen'),
        pick: () => Promise.resolve(['dog']),
        generate: (_prompt, _sampler, _plan, signal) => {
            asked += 1
            if (signal?.aborted === true) return Promise.reject(new Error('cancelled'))
            return Promise.resolve({spec: carved('tower', '#808080'), model: 'qwen'})
        }
    }
    const mounted = await open(slow)

    // Unmounted while the batch is in flight. The loop must not run on to four.
    await act(async () => {
        control('Generate').click()
        mounted.root.unmount()
    })
    await mounted.batch()
    mounted.host.remove()

    expect(asked).toBeLessThan(4)
})

test('the header close button closes the dialog rather than the window', async () => {
    const {root, host, closed} = await open(memoryLlama([carved('tower', '#808080')]))

    const shut = [
        ...(dialog().closest('dialog')?.querySelectorAll<HTMLElement>('button') ?? [])
    ].find(node => (node.getAttribute('aria-label') ?? '').toLowerCase().includes('close'))
    if (!shut) throw new Error('the dialog has no close button')
    await act(async () => {
        shut.click()
    })

    expect(closed).toHaveLength(1)

    await close(root, host)
})

test('the count is clamped to what the batch is allowed to be', async () => {
    const mounted = await open(memoryLlama([carved('tower', '#808080')]))
    const field = dialog().querySelector<HTMLInputElement>('input[type="number"]')
    if (!field) throw new Error('the dialog has no count field')

    /*
     * Typing, as React sees it: React keeps its own copy of an input's value and ignores an event
     * whose value it thinks it already has, so the assignment has to go through the prototype's
     * setter — which is what a real keystroke does.
     */
    const set = async (value: string): Promise<void> => {
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            setter?.call(field, value)
            field.dispatchEvent(new Event('input', {bubbles: true}))
        })
    }

    await set('2')
    await generate(mounted)
    expect(cards()).toHaveLength(2)

    await set(String(MAX_CANDIDATES))
    await generate(mounted)
    expect(cards()).toHaveLength(MAX_CANDIDATES)

    /*
     * Twelve candidates is already four minutes of somebody's GPU, and nothing above it is
     * offered: the field's own `max` refuses the keystroke, so the count stays where it was rather
     * than climbing and being clamped afterwards.
     */
    await set('99')
    await generate(mounted)
    expect(cards()).toHaveLength(MAX_CANDIDATES)

    await close(mounted.root, mounted.host)
})

test('Cancel stops a batch that is already running, and keeps what landed', async () => {
    let release: (() => void) | undefined
    let asked = 0
    const held: Llama = {
        probe: () => Promise.resolve('qwen'),
        pick: () => Promise.resolve(['dog']),
        generate: (_prompt, _sampler, _plan, signal) => {
            asked += 1
            if (signal?.aborted === true) return Promise.reject(new Error('cancelled'))
            // The first candidate lands at once; the second waits for the test to let it go.
            if (asked === 1) return Promise.resolve({spec: carved('tower', '#808080'), model: 'q'})
            return new Promise(resolve => {
                release = () => {
                    resolve({spec: carved('hut', '#664422'), model: 'q'})
                }
            })
        }
    }
    const mounted = await open(held)

    await act(async () => {
        control('Generate').click()
    })
    // Mid-batch: one candidate on screen, the second in flight, and the button is now Cancel.
    expect(cards()).toHaveLength(1)
    await act(async () => {
        control('Cancel').click()
    })
    await act(async () => {
        release?.()
        await mounted.batch()
    })

    expect(asked).toBe(2)
    expect(said('generate-status')).toContain('2 candidates')
    expect(cards()).toHaveLength(2)
    // Aborted, so CLIP is never asked about a batch the artist walked away from.
    expect(said('clip-status')).toBe('')

    await close(mounted.root, mounted.host)
})

/** A `drop` with files on it. happy-dom has no `DataTransfer`, so the event carries one of its own. */
const dropFile = async (node: HTMLElement, file: File): Promise<void> => {
    const event = new Event('drop', {bubbles: true})
    Object.defineProperty(event, 'dataTransfer', {value: {files: [file]}})
    await act(async () => {
        node.dispatchEvent(event)
    })
}

/** The drop target, scoped to the open dialog like every other query here. */
const referenceZone = (): HTMLElement => {
    const found = dialog().querySelector<HTMLElement>('[data-testid="generate-reference"]')
    if (!found) throw new Error('the reference drop target is not there')
    return found
}

const carBytes = new Uint8Array(
    await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer()
)

test('a dropped model becomes the example the next batch is taught from', async () => {
    const llama = memoryLlama([carved('tower', '#808080')])
    const store = memoryStore()
    const mounted = await open(llama, memoryScorer([], false), memoryVeto(['']), store)
    const {root, host} = mounted

    await dropFile(referenceZone(), new File([carBytes], 'car.vox'))
    expect(said('generate-reference')).toContain('car.vox')

    await generate(mounted)

    /*
     * Last, against the prompt. The bank's pick is a guess and a dropped model is not — an artist
     * who went and found a file has said which teacher they want more clearly than any call can.
     */
    const sent = llama.seen[0]?.examples ?? []
    expect(sent).toHaveLength(2)
    expect(sent[1]?.reply).toContain('box(')
    // It survives a reload, because it cost the artist a file picker to set.
    expect(store.get('gofer-pixel/gen-reference') ?? '').toContain('box(')

    await close(root, host)
})

test('choosing a model through the picker teaches the same as dropping one', async () => {
    const llama = memoryLlama([carved('tower', '#808080')])
    /*
     * The `Files` port, not a stubbed `<input type=file>`. The dialog gets its own instance rather
     * than the app's, because this port remembers what Save writes back to and a reference model is
     * not the document — see `doc/files.ts`.
     */
    const disk = new Map<string, string | Uint8Array>([['car.vox', carBytes]])
    const mounted = await open(
        llama,
        memoryScorer([], false),
        memoryVeto(['']),
        memoryStore(),
        memoryFiles(disk)
    )
    const {root, host} = mounted

    await act(async () => {
        control('Choose a model').click()
    })
    // The port resolves on the microtask queue; one more flush lands the state it set.
    await act(async () => {
        await Promise.resolve()
    })

    expect(referenceZone().textContent).toContain('Teaching from car.vox')

    await close(root, host)
})

test('a file that is not a model says so, and does not become the reference', async () => {
    const llama = memoryLlama([carved('tower', '#808080')])
    const mounted = await open(llama)
    const {root, host} = mounted

    await dropFile(referenceZone(), new File([new Uint8Array([1, 2, 3])], 'notes.txt'))

    expect(said('generate-reference')).toContain('not a .vox or .gpix')
    await generate(mounted)
    // The batch still runs, taught by the bank alone.
    expect(llama.seen[0]?.examples ?? []).toHaveLength(1)

    await close(root, host)
})
