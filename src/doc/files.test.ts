import {expect, test} from 'bun:test'
import {browserFiles, memoryFiles, projectName, PROJECT_ACCEPT, PROJECT_EXTENSION} from './files'

test('a file written is a file read back', async () => {
    const disk = new Map<string, string>()
    const files = memoryFiles(disk)

    expect(await files.save('knight.gpix', '{"a":1}', false)).toBe('knight.gpix')
    expect(disk.get('knight.gpix')).toBe('{"a":1}')

    const back = await files.open(PROJECT_ACCEPT)
    expect(back?.name).toBe('knight.gpix')
    expect(back?.text).toBe('{"a":1}')
})

test('the second save reuses the first file rather than asking again', async () => {
    const disk = new Map<string, string>()
    const asked: string[] = []
    const files = memoryFiles(disk, suggested => {
        asked.push(suggested)
        return suggested
    })

    await files.save('knight.gpix', 'one', false)
    await files.save('knight.gpix', 'two', true)

    expect(asked).toEqual(['knight.gpix'])
    expect(disk.get('knight.gpix')).toBe('two')
    expect(disk.size).toBe(1)
})

test('a cancelled picker writes nothing and says so', async () => {
    const disk = new Map<string, string>()
    const files = memoryFiles(disk, () => undefined)

    expect(await files.save('knight.gpix', 'lost', false)).toBeUndefined()
    expect(disk.size).toBe(0)
})

test('forgetting the file makes the next save ask again', async () => {
    const disk = new Map<string, string>()
    const asked: string[] = []
    const files = memoryFiles(disk, suggested => {
        asked.push(suggested)
        return suggested
    })

    await files.save('knight.gpix', 'one', false)
    files.forget()
    await files.save('untitled.gpix', 'two', true)

    expect(asked).toEqual(['knight.gpix', 'untitled.gpix'])
    expect(disk.size).toBe(2)
})

/*
 * A read that did not ask to be remembered must not arm the reuse path — see `ReadFor`. It is the
 * palette loader and the generate dialog's reference model that depend on this, and it is why all
 * three readers can share one instance of the port. The rule that a `.vox` opened as a *document*
 * is untitled is `openProject`'s, and `session.test.ts` holds it.
 */
test('a read that does not ask to be remembered is not the file Save writes back to', async () => {
    const disk = new Map<string, string>([['car.vox', 'VOX ']])
    const asked: string[] = []
    const files = memoryFiles(disk, suggested => {
        asked.push(suggested)
        return suggested
    })

    expect((await files.open(PROJECT_ACCEPT))?.name).toBe('car.vox')
    await files.save(`untitled${PROJECT_EXTENSION}`, '{}', true)

    expect(asked).toEqual(['untitled.gpix'])
    expect(disk.get('car.vox')).toBe('VOX ')
})

test('a document saves under its own name, and never back over somebody else’s format', () => {
    expect(projectName('knight.gpix')).toBe('knight.gpix')
    // The one that matters: this app cannot write MagicaVoxel's format, so offering to save over a
    // `.vox` would be offering to destroy it.
    expect(projectName('car.vox')).toBe('car.gpix')
    expect(projectName('sprite.png')).toBe('sprite.gpix')
    expect(projectName('no extension')).toBe('no extension.gpix')
    expect(projectName('two.dots.here')).toBe('two.dots.gpix')
    expect(projectName('')).toBe('untitled.gpix')
    expect(projectName('.gitignore')).toBe('untitled.gpix')
})

/*
 * `browserFiles` against a stubbed picker.
 *
 * The native dialog cannot be driven, but everything *around* it can be, and that is where the
 * damage lives: which handle is held, whether a cancel is silent, and whether a `.vox` can ever
 * become the file Save writes back to. happy-dom gives real `globalThis`, so the two picker
 * functions are stubbed in and the branch under test is the one the artist's Chrome actually runs.
 */
interface StubHandle {
    name: string
    written: string[]
}

const stubPicker = (files: readonly {name: string; text: string}[]) => {
    const asked: string[] = []
    const handles = new Map<string, StubHandle>()
    const handleFor = (name: string) => {
        const held = handles.get(name) ?? {name, written: []}
        handles.set(name, held)
        return {
            get name() {
                return held.name
            },
            getFile: () =>
                Promise.resolve(
                    new File(
                        [
                            files.find(entry => entry.name === name)?.text
                                ?? held.written.at(-1)
                                ?? ''
                        ],
                        name
                    )
                ),
            createWritable: () =>
                Promise.resolve({
                    write: (data: string) => {
                        held.written.push(data)
                        return Promise.resolve()
                    },
                    close: () => Promise.resolve()
                })
        }
    }
    return {asked, handles, handleFor}
}

const withPicker = async (
    stubs: Partial<Record<'showOpenFilePicker' | 'showSaveFilePicker', unknown>>,
    body: () => Promise<void>
): Promise<void> => {
    const host = globalThis as unknown as Record<string, unknown>
    const before = {
        showOpenFilePicker: host['showOpenFilePicker'],
        showSaveFilePicker: host['showSaveFilePicker']
    }
    Object.assign(host, {showOpenFilePicker: undefined, showSaveFilePicker: undefined}, stubs)
    try {
        await body()
    } finally {
        Object.assign(host, before)
    }
}

test('with a picker, the first save asks and every later one writes back to the same handle', async () => {
    const stub = stubPicker([])
    await withPicker(
        {
            showSaveFilePicker: (options: {suggestedName: string}) => {
                stub.asked.push(options.suggestedName)
                return Promise.resolve(stub.handleFor(options.suggestedName))
            }
        },
        async () => {
            const files = browserFiles()
            expect(files.overwrites).toBe(true)

            expect(await files.save('knight.gpix', 'one', false)).toBe('knight.gpix')
            expect(await files.save('knight.gpix', 'two', true)).toBe('knight.gpix')
            expect(await files.save('knight.gpix', 'three', true)).toBe('knight.gpix')

            expect(stub.asked).toEqual(['knight.gpix'])
            expect(stub.handles.get('knight.gpix')?.written).toEqual(['one', 'two', 'three'])

            // `forget` is what `new` calls, so a fresh project cannot land on the last one's file.
            files.forget()
            expect(await files.save('untitled.gpix', 'four', true)).toBe('untitled.gpix')
            expect(stub.asked).toEqual(['knight.gpix', 'untitled.gpix'])
        }
    )
})

test('a picker the artist escapes out of writes nothing and reports nothing', async () => {
    await withPicker(
        {
            // What Chrome throws on Escape, and on a page that has lost user activation.
            showSaveFilePicker: () => Promise.reject(new DOMException('aborted', 'AbortError')),
            showOpenFilePicker: () => Promise.reject(new DOMException('aborted', 'AbortError'))
        },
        async () => {
            const files = browserFiles()
            expect(await files.save('knight.gpix', 'lost', false)).toBeUndefined()
            expect(await files.open(PROJECT_ACCEPT)).toBeUndefined()
        }
    )
})

test('an unremembered read gets its real bytes back and does not arm the overwrite', async () => {
    // A byte above 0x7f, which is what makes reading a binary file as text lossy.
    const raw = Uint8Array.from([0x56, 0x4f, 0x58, 0x20, 0x99, 0x00, 0xff])
    const stub = stubPicker([])
    await withPicker(
        {
            showOpenFilePicker: () =>
                Promise.resolve([
                    {
                        name: 'car.vox',
                        getFile: () => Promise.resolve(new File([raw], 'car.vox')),
                        createWritable: () => Promise.reject(new Error('a .vox is not ours'))
                    }
                ]),
            showSaveFilePicker: (options: {suggestedName: string}) => {
                stub.asked.push(options.suggestedName)
                return Promise.resolve(stub.handleFor(options.suggestedName))
            }
        },
        async () => {
            const files = browserFiles()
            const back = await files.open(PROJECT_ACCEPT)
            expect(back?.name).toBe('car.vox')
            expect(back?.bytes).toEqual(raw)

            // Even asking to reuse, the picker opens: their model is not ours to overwrite.
            await files.save('car.gpix', '{}', true)
            expect(stub.asked).toEqual(['car.gpix'])
        }
    )
})

test('a remembered read arms the overwrite, so the next Ctrl+S is silent', async () => {
    const stub = stubPicker([{name: 'knight.gpix', text: '{"a":1}'}])
    await withPicker(
        {
            showOpenFilePicker: () => Promise.resolve([stub.handleFor('knight.gpix')]),
            showSaveFilePicker: (options: {suggestedName: string}) => {
                stub.asked.push(options.suggestedName)
                return Promise.resolve(stub.handleFor(options.suggestedName))
            }
        },
        async () => {
            const files = browserFiles()
            expect((await files.open(PROJECT_ACCEPT, {remember: true}))?.text).toBe('{"a":1}')

            expect(await files.save('knight.gpix', 'edited', true)).toBe('knight.gpix')
            expect(stub.asked).toEqual([])
            expect(stub.handles.get('knight.gpix')?.written).toEqual(['edited'])
        }
    )
})

/*
 * Firefox and Safari, which have never had the File System Access API. Every save is another file
 * in the downloads folder, and `overwrites` is how the menu knows to stop saying `Save`.
 */
test('without a picker, saving is a download and it says it cannot overwrite', async () => {
    await withPicker({}, async () => {
        // The anchor's own `click`, rather than a stub over `document.createElement`. The download
        // is the click, so this is the narrowest thing that can be watched and it leaves everything
        // the code under test does to build the element alone.
        const clicked: {href: string; download: string}[] = []
        const pressed = HTMLAnchorElement.prototype.click
        HTMLAnchorElement.prototype.click = function press(this: HTMLAnchorElement) {
            clicked.push({href: this.href, download: this.download})
        }

        try {
            const files = browserFiles()
            expect(files.overwrites).toBe(false)

            // `reuse` is honoured only where it can be. Here it is another download, both times.
            expect(await files.save('knight.gpix', 'one', false)).toBe('knight.gpix')
            expect(await files.save('knight.gpix', 'two', true)).toBe('knight.gpix')

            expect(clicked.map(entry => entry.download)).toEqual(['knight.gpix', 'knight.gpix'])
            expect(clicked[0]?.href).toStartWith('blob:')
        } finally {
            HTMLAnchorElement.prototype.click = pressed
        }
    })
})

/*
 * Firefox and Safari have no `showOpenFilePicker` either, so opening falls back to an
 * `<input type=file>` that is created, clicked and dropped. Never kept in the tree: a hidden input
 * living in the layout is one more node for a bounding-box test to trip over.
 *
 * The input's own `click` is what gets stubbed, for the same reason the anchor's is above — it is
 * the narrowest thing that can stand in for a native dialog, and everything the code does to build
 * the element is left alone.
 */
const withFileInput = async (
    answer: (input: HTMLInputElement) => void,
    body: () => Promise<void>
): Promise<void> => {
    const pressed = HTMLInputElement.prototype.click
    HTMLInputElement.prototype.click = function press(this: HTMLInputElement) {
        answer(this)
    }
    try {
        await withPicker({}, body)
    } finally {
        HTMLInputElement.prototype.click = pressed
    }
}

test('with no open picker, opening goes through a file input that never joins the page', async () => {
    let accept = ''
    let inTree = true

    await withFileInput(
        input => {
            accept = input.accept
            inTree = input.isConnected
            Object.defineProperty(input, 'files', {
                configurable: true,
                value: [new File(['{"format":"gofer-pixel"}'], 'knight.gpix')]
            })
            input.dispatchEvent(new Event('change'))
        },
        async () => {
            const picked = await browserFiles().open(PROJECT_ACCEPT)

            expect(picked?.name).toBe('knight.gpix')
            expect(picked?.text).toBe('{"format":"gofer-pixel"}')
            expect(picked?.bytes).toEqual(new TextEncoder().encode('{"format":"gofer-pixel"}'))
        }
    )

    // The picker is told what the two formats are, and the element is gone by the time it opens.
    expect(accept).toBe(PROJECT_ACCEPT)
    expect(inTree).toBe(false)
})

test('a file input that fires change with nothing chosen opens nothing', async () => {
    await withFileInput(
        input => {
            input.dispatchEvent(new Event('change'))
        },
        async () => {
            expect(await browserFiles().open(PROJECT_ACCEPT)).toBeUndefined()
        }
    )
})

test('a file input the artist cancels opens nothing either', async () => {
    await withFileInput(
        input => {
            input.dispatchEvent(new Event('cancel'))
        },
        async () => {
            expect(await browserFiles().open(PROJECT_ACCEPT)).toBeUndefined()
        }
    )
})

/*
 * A picker that resolves with no handle at all. Not the cancel path — that throws — but what a
 * `multiple: false` call is still typed to allow, and the one branch where a missing guard would be
 * a `TypeError` in the artist's console instead of a shrug.
 */
test('an open picker that hands back no handle is not an error', async () => {
    await withPicker({showOpenFilePicker: () => Promise.resolve([])}, async () => {
        expect(await browserFiles().open(PROJECT_ACCEPT)).toBeUndefined()
    })
})
