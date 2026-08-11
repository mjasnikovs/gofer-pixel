import {expect, test} from 'bun:test'
import {act} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {memoryFiles, type Files} from '../doc/files'
import {freshenPalette} from '../doc/palette'
import {memoryStore, type Store} from '../doc/store'
import {newDocument} from '../doc/templates'
import {DEFAULT_CANVAS} from '../gen/ask'
import {swatchesOf} from '../gen/palette'
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

/**
 * The document the dialog is opened over, for its palette — see `gen/palette.ts`.
 *
 * Freshened, exactly as `initialState` freshens every document the app opens, so the palette the
 * candidates are snapped to is DB32 and not the empty grid `newDocument` hands back.
 */
const project = (): Volume => {
    const {volume} = newDocument([16, 16, 16])
    return {...volume, palette: freshenPalette(volume)}
}

const open = async (
    llama: Llama,
    scorer: Scorer = memoryScorer([], false),
    // Canned silence: the judge answers nothing, which passes every candidate — see `gen/veto.ts`.
    veto: Veto = memoryVeto(['']),
    store: Store = memoryStore(),
    files: Files = memoryFiles(),
    volume: Volume = project()
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
                volume={volume}
                scorer={scorer}
                veto={veto}
                onClose={() => closed.push(1)}
                onPick={(made, name, record) => picked.push({volume: made, name, record})}
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
 * Astryx's Switch is a real checkbox with a `<label for>` beside it, so it is reached through the
 * label rather than by the text next to it. By name rather than by position: there are three
 * switches in this dialog now and "the only checkbox" stopped being true the day a second landed.
 */
const toggleSwitch = async (label: string): Promise<void> => {
    const found = [...dialog().querySelectorAll<HTMLLabelElement>('label')].find(node =>
        node.textContent.includes(label)
    )
    const box =
        found?.htmlFor === '' ?
            found.querySelector<HTMLInputElement>('input[type="checkbox"]')
        :   dialog().querySelector<HTMLInputElement>(`#${found?.htmlFor ?? ''}`)
    if (!box) throw new Error(`the dialog has no switch called ${label}`)
    await act(async () => {
        box.click()
    })
}

const toggleNaming = (): Promise<void> => toggleSwitch('Ask what each result looks like')

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
    // The default canvas is 64, so the document is the canvas rather than the fitted 12-tall tower.
    expect(picked[0]?.volume.sz).toBe(DEFAULT_CANVAS)
    expect(picked[0]?.record.canvas).toBe(DEFAULT_CANVAS)

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
    const sent = llama.seen[0]?.brief.examples ?? []
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
    expect(llama.seen[0]?.brief.examples ?? []).toHaveLength(1)

    await close(root, host)
})

/*
 * The other end of the drop. Clear is the only way back to the bank once a model has been taught
 * from, and it has to reach `localStorage` and not just the dialog's own state — a reference that
 * came back on the next reload would be a teacher the artist thought they had dismissed.
 */
test('clearing the dropped reference forgets it, on screen and on disk', async () => {
    const llama = memoryLlama([carved('tower', '#808080')])
    const store = memoryStore()
    const mounted = await open(llama, memoryScorer([], false), memoryVeto(['']), store)
    const {root, host} = mounted

    await dropFile(referenceZone(), new File([carBytes], 'car.vox'))
    expect(said('generate-reference')).toContain('Teaching from')
    expect(store.get('gofer-pixel/gen-reference') ?? '').toContain('box(')

    await act(async () => {
        control('Clear').click()
    })

    expect(said('generate-reference')).toContain('Drop a .vox or .gpix here')
    expect(store.get('gofer-pixel/gen-reference') ?? '').toBe('')
    // And Clear is gone with it: there is nothing left to clear.
    expect(
        [...dialog().querySelectorAll('button')].some(node => node.textContent.trim() === 'Clear')
    ).toBe(false)

    await generate(mounted)
    expect(llama.seen[0]?.brief.examples ?? []).toHaveLength(1)

    await close(root, host)
})

/*
 * The other way out of the dialog, beside the close button above. Astryx listens for Escape on the
 * `<dialog>` element itself, and this dialog is `purpose='form'`, so Escape closes it and a click on
 * the backdrop does not — a batch is a minute of the artist's time to lose to a stray click.
 */
test('Escape closes the dialog, the same as the close button', async () => {
    const {root, host, closed} = await open(memoryLlama([carved('tower', '#808080')]))

    const shell = dialog().closest('dialog')
    if (!shell) throw new Error('the dialog is not in a <dialog>')
    await act(async () => {
        shell.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))
    })

    expect(closed).toHaveLength(1)

    await close(root, host)
})

/*
 * The two rules a batch runs under — `gen/ask.ts`. Both are default-on in a way the rest of this
 * dialog is not, so both are asserted from the dialog rather than only from the modules under it:
 * the switch, the control and the candidate that comes out have to agree.
 */

test('the canvas is the document, and turning it off gives the fitted model back', async () => {
    const mounted = await open(memoryLlama([carved('tower', '#808080')]))
    const {root, host, picked} = mounted

    await act(async () => {
        control('32³').click()
    })
    await generate(mounted)
    await act(async () => {
        control('Use this one').click()
    })
    expect([picked[0]?.volume.sx, picked[0]?.volume.sz]).toEqual([32, 32])

    await act(async () => {
        control('Off').click()
    })
    await generate(mounted)
    await act(async () => {
        control('Use this one').click()
    })
    // The tower is 6 wide and 12 tall, which is what the ops painted — see `gen/ops.ts`.
    expect([picked[1]?.volume.sx, picked[1]?.volume.sz]).toEqual([6, 12])
    expect(picked[1]?.record.canvas).toBeUndefined()

    await close(root, host)
})

test('a candidate paints in the project palette until the switch says it need not', async () => {
    const doc = project()
    // On no palette, and nowhere near DB32's greys: every voxel of it has to move.
    const mounted = await open(
        memoryLlama([carved('tower', '#013b02')]),
        memoryScorer([], false),
        memoryVeto(['']),
        memoryStore(),
        memoryFiles(),
        doc
    )
    const {root, host, picked} = mounted

    await generate(mounted)
    await act(async () => {
        control('Use this one').click()
    })
    const allowed = new Set(swatchesOf(doc).slots)
    const held = picked[0]?.volume
    expect(held?.palette).toEqual(doc.palette)
    expect(
        [...new Set(held?.data ?? [])].filter(value => value !== 0).every(v => allowed.has(v))
    ).toBe(true)

    await toggleSwitch('Keep to the project palette')
    await generate(mounted)
    await act(async () => {
        control('Use this one').click()
    })
    // Off, the model keeps what it painted: the green it asked for, plus the two tones `finish`
    // shades it into. The project's palette is not adopted and none of the three is in it.
    const free = picked[1]?.volume
    const greens = [...new Set(free?.data ?? [])].filter(value => value !== 0)
    expect(greens.length).toBeGreaterThan(1)
    for (const value of greens) {
        const [r, g, b] = free?.palette.subarray(value * 4, value * 4 + 3) ?? []
        expect(g ?? 0).toBeGreaterThan(Math.max(r ?? 0, b ?? 0))
    }
    expect(free?.palette).not.toEqual(doc.palette)

    await close(root, host)
})
