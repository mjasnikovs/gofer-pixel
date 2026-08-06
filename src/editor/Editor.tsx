import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {HStack} from '@astryxdesign/core/HStack'
import {NumberInput} from '@astryxdesign/core/NumberInput'
import {Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import {VStack} from '@astryxdesign/core/VStack'
import {celAt, frameToModel, frameToVox, uniqueTagName, type Tag} from '../doc/document'
import {light, rotationSheet} from '../vox/render'
import {composeStacked, sliceLayers} from '../vox/slice'
import {colorToHex} from '../doc/serialize'
import type {RgbaImage} from '../image/rgba'
import {renderSlice, selectionOutline, toVoxel} from './canvas'
import {download} from './download'
import {readImport} from './files'
import {EffectsPanel} from './EffectsPanel'
import {ExportPanel} from './ExportPanel'
import {GeneratePanel} from './GeneratePanel'
import {PalettePanel} from './PalettePanel'
import {RigPanel} from './RigPanel'
import type {Rig} from '../anim/rig'
import {Viewport3D} from './Viewport3D'
import {useEditor, type Editor as EditorApi} from './useEditor'
import type {Tool} from './state'

const TOOLS: [Tool, string][] = [
    ['pencil', '✏️'],
    ['eraser', '🩹'],
    ['line', '╱'],
    ['rect', '▭'],
    ['ellipse', '◯'],
    ['fill', '🪣'],
    ['shade', '◐'],
    ['eyedropper', '💧'],
    ['select', '⬚'],
    ['lasso', '🪢'],
    ['wand', '✨'],
    ['move', '✥']
]

const paint = (canvas: HTMLCanvasElement | null, image: RgbaImage): void => {
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) {
        return
    }
    canvas.width = image.width
    canvas.height = image.height
    ctx.putImageData(
        new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
        0,
        0
    )
}

const pixelated = {imageRendering: 'pixelated' as const, display: 'block' as const}

/** The modes the editor can be in, and what the switch calls them. */
const MODE_LABELS = {
    slice: 'slice mode',
    '3d': '3D mode',
    generate: 'generate',
    export: 'export',
    rig: 'rig',
    fx: 'effects'
} as const

type Mode = keyof typeof MODE_LABELS

/** The drawing surface: the active slice, its onion skin, and the selection marquee over the top. */
const SliceCanvas = ({editor, zoom}: {editor: EditorApi; zoom: number}) => {
    const canvas = useRef<HTMLCanvasElement>(null)
    const overlay = useRef<HTMLCanvasElement>(null)
    const {snapshot, settings} = editor
    const {doc, slice, layer, frame, selection} = snapshot

    useEffect(() => {
        paint(
            canvas.current,
            renderSlice(doc, celAt(doc, layer, frame), slice, {
                onionSkin: settings.onionSkin,
                ...(settings.frameOnion ?
                    {
                        frameOnion: {
                            before: celAt(doc, layer, frame - 1),
                            after: celAt(doc, layer, frame + 1)
                        }
                    }
                :   {})
            })
        )
    }, [doc, layer, frame, slice, settings.onionSkin, settings.frameOnion])

    useEffect(() => {
        const element = overlay.current
        const ctx = element?.getContext('2d')
        if (!element || !ctx) {
            return
        }
        element.width = doc.size.sx
        element.height = doc.size.sy
        ctx.clearRect(0, 0, element.width, element.height)
        if (!selection) {
            return
        }
        const outline = selectionOutline(selection, doc.size)
        ctx.fillStyle = 'rgba(255,255,255,0.85)'
        outline.forEach((on, i) => {
            if (on) {
                ctx.fillRect(i % doc.size.sx, Math.floor(i / doc.size.sx), 1, 1)
            }
        })
    }, [selection, doc.size])

    const locate = useCallback(
        (event: {clientX: number; clientY: number}): [number, number] => {
            const rect = canvas.current?.getBoundingClientRect()
            return rect ? toVoxel(event.clientX, event.clientY, rect, doc.size) : [0, 0]
        },
        [doc.size]
    )

    const width = doc.size.sx * zoom
    const height = doc.size.sy * zoom

    return (
        <div
            style={{position: 'relative', width, height, touchAction: 'none', cursor: 'crosshair'}}
            onPointerDown={event => {
                event.currentTarget.setPointerCapture(event.pointerId)
                const [x, y] = locate(event)
                editor.pointerDown(x, y)
            }}
            onPointerMove={event => {
                const [x, y] = locate(event)
                editor.pointerMove(x, y)
            }}
            onPointerUp={() => {
                editor.pointerUp()
            }}
            onPointerCancel={() => {
                editor.pointerUp()
            }}
        >
            <div
                style={{
                    position: 'absolute',
                    inset: 0,
                    backgroundImage:
                        'linear-gradient(45deg,#2a2a2a 25%,transparent 25%,transparent 75%,#2a2a2a 75%),'
                        + 'linear-gradient(45deg,#2a2a2a 25%,transparent 25%,transparent 75%,#2a2a2a 75%)',
                    backgroundSize: `${String(zoom * 2)}px ${String(zoom * 2)}px`,
                    backgroundPosition: `0 0, ${String(zoom)}px ${String(zoom)}px`,
                    backgroundColor: '#1e1e1e'
                }}
            />
            <canvas
                ref={canvas}
                style={{...pixelated, position: 'absolute', inset: 0, width, height}}
            />
            <canvas
                ref={overlay}
                style={{...pixelated, position: 'absolute', inset: 0, width, height, opacity: 0.9}}
            />
        </div>
    )
}

/** Every slice as a thumbnail column, bottom slice at the bottom, like the stack itself. */
const SliceStrip = ({editor}: {editor: EditorApi}) => {
    const {snapshot} = editor
    const {doc, slice, layer, frame} = snapshot
    const cel = celAt(doc, layer, frame)

    return (
        // the strip scrolls inside itself: 32 slices is taller than a laptop screen, and letting
        // the page scroll instead moves the canvas out from under the cursor mid-edit
        <div style={{maxHeight: '80vh', overflowY: 'auto', paddingRight: 4}}>
            <VStack gap={1}>
                {Array.from({length: doc.size.sz}, (_unused, i) => doc.size.sz - 1 - i).map(z => (
                    <SliceThumb
                        key={z}
                        editor={editor}
                        z={z}
                        active={z === slice}
                        image={renderSlice(doc, cel, z, {onionSkin: false})}
                    />
                ))}
            </VStack>
        </div>
    )
}

const SliceThumb = ({
    editor,
    z,
    active,
    image
}: {
    editor: EditorApi
    z: number
    active: boolean
    image: RgbaImage
}) => {
    const canvas = useRef<HTMLCanvasElement>(null)
    useEffect(() => {
        paint(canvas.current, image)
    }, [image])

    return (
        <HStack
            gap={1}
            align='center'
        >
            <Text type='supporting'>{String(z).padStart(2, '0')}</Text>
            <canvas
                ref={canvas}
                onClick={() => {
                    editor.navigate({slice: z})
                }}
                style={{
                    ...pixelated,
                    width: 40,
                    height: 40,
                    background: '#1e1e1e',
                    outline: active ? '2px solid #7aa2f7' : '1px solid #333',
                    cursor: 'pointer'
                }}
            />
        </HStack>
    )
}

/** Live stacked preview — the whole point of the format, so it updates on every stroke. */
const StackedPreview = ({editor, angle}: {editor: EditorApi; angle: number}) => {
    const flat = useRef<HTMLCanvasElement>(null)
    const rotated = useRef<HTMLCanvasElement>(null)
    const {doc, frame} = editor.snapshot
    const model = useMemo(() => frameToModel(doc, frame), [doc, frame])

    useEffect(() => {
        const layers = sliceLayers(model, 3)
        if (layers.length > 0) {
            paint(flat.current, composeStacked(layers, 3, 2))
        }
        const sheet = rotationSheet(model, 8, {scale: 3})
        paint(rotated.current, light(sheet))
    }, [model, angle])

    return (
        <VStack gap={2}>
            <Text type='supporting'>stacked</Text>
            <canvas
                ref={flat}
                style={{...pixelated, maxWidth: 220, background: '#1e1e1e'}}
            />
            <Text type='supporting'>8 angles, lit</Text>
            <canvas
                ref={rotated}
                style={{...pixelated, maxWidth: 460, background: '#1e1e1e'}}
            />
        </VStack>
    )
}

const PaletteBar = ({editor}: {editor: EditorApi}) => {
    const {snapshot, settings, setSettings} = editor
    const entries = snapshot.doc.palette.slice(0, 64)

    return (
        <div style={{display: 'grid', gridTemplateColumns: 'repeat(16, 20px)', gap: 2}}>
            {entries.map((color, i) => (
                <button
                    key={`${String(i)}-${colorToHex(color)}`}
                    type='button'
                    title={`${String(i + 1)} ${colorToHex(color)}`}
                    onClick={() => {
                        setSettings(s => ({...s, color: i + 1}))
                    }}
                    style={{
                        width: 20,
                        height: 20,
                        padding: 0,
                        background: colorToHex(color),
                        border: settings.color === i + 1 ? '2px solid #7aa2f7' : '1px solid #333',
                        cursor: 'pointer'
                    }}
                />
            ))}
        </div>
    )
}

/**
 * One tag: its name, its range, and a lane showing which frames it covers.
 *
 * The name is the tag's identity, so an edit to it is a rename of the thing being edited — the
 * input keeps its own draft until blur, otherwise every keystroke would rename the tag and the
 * next keystroke would look for a tag that no longer exists.
 */
const TagRow = ({editor, tag}: {editor: EditorApi; tag: Tag}) => {
    const {snapshot, actions} = editor
    const {doc} = snapshot
    // the row is keyed on the tag name, so a committed rename remounts this with a fresh draft —
    // no effect needed to keep the two in step
    const [draft, setDraft] = useState(tag.name)

    return (
        <HStack
            gap={2}
            align='center'
        >
            <div style={{width: 110}}>
                <TextInput
                    label='tag name'
                    isLabelHidden
                    size='sm'
                    value={draft}
                    onChange={setDraft}
                    onBlur={() => {
                        if (draft !== tag.name && draft.trim() !== '') {
                            actions.updateTag(tag.name, {name: draft.trim()})
                        }
                    }}
                    onKeyDown={event => {
                        if (event.key === 'Enter') {
                            event.currentTarget.blur()
                        }
                    }}
                />
            </div>
            <div style={{width: 76}}>
                <NumberInput
                    label='from'
                    isLabelHidden
                    size='sm'
                    min={0}
                    max={doc.frames - 1}
                    value={tag.from + 1}
                    onChange={value => {
                        actions.updateTag(tag.name, {from: value - 1})
                    }}
                />
            </div>
            <div style={{width: 76}}>
                <NumberInput
                    label='to'
                    isLabelHidden
                    size='sm'
                    min={0}
                    max={doc.frames - 1}
                    value={tag.to + 1}
                    onChange={value => {
                        actions.updateTag(tag.name, {to: value - 1})
                    }}
                />
            </div>
            <div
                data-testid={`tag-lane-${tag.name}`}
                style={{display: 'flex', gap: 2}}
            >
                {Array.from({length: doc.frames}, (_unused, i) => (
                    <div
                        key={i}
                        style={{
                            width: 24,
                            height: 8,
                            background: i >= tag.from && i <= tag.to ? '#7aa2f7' : '#2a2a2a'
                        }}
                    />
                ))}
            </div>
            <Button
                label='remove tag'
                size='sm'
                variant='secondary'
                clickAction={() => {
                    actions.removeTag(tag.name)
                }}
            />
        </HStack>
    )
}

/**
 * Frames across, tags underneath — Aseprite's timeline, minus the per-layer rows, which do not
 * earn their space until a document routinely has more than a couple of layers.
 */
const FrameBar = ({editor}: {editor: EditorApi}) => {
    const {snapshot, settings, setSettings, actions, navigate} = editor
    const {doc, frame} = snapshot
    const [playing, setPlaying] = useState(false)
    const [fps, setFps] = useState(8)

    /**
     * Playback loops inside the tag under the playhead when there is one, and over the whole
     * document otherwise — the same rule Aseprite uses, and the reason tags are worth having
     * before the animation is worth exporting.
     *
     * A timeout chain rather than an interval: the effect re-runs per frame anyway, and a chain
     * cannot pile up ticks if a render takes longer than the interval.
     */
    useEffect(() => {
        if (!playing || doc.frames < 2) {
            return
        }
        const tag = doc.tags.find(entry => frame >= entry.from && frame <= entry.to)
        const from = tag?.from ?? 0
        const to = tag?.to ?? doc.frames - 1
        const timer = setTimeout(
            () => {
                navigate({frame: frame >= to ? from : frame + 1})
            },
            1000 / Math.max(fps, 1)
        )
        return () => {
            clearTimeout(timer)
        }
    }, [playing, fps, frame, doc.frames, doc.tags, navigate])

    return (
        <div data-testid='frame-bar'>
            <VStack gap={2}>
                <HStack
                    gap={1}
                    align='center'
                >
                    <Text type='supporting'>frames</Text>
                    {Array.from({length: doc.frames}, (_unused, i) => (
                        <Button
                            key={i}
                            label={String(i + 1)}
                            size='sm'
                            variant={i === frame ? 'primary' : 'secondary'}
                            clickAction={() => {
                                navigate({frame: i})
                            }}
                        />
                    ))}
                    <Button
                        label='+ frame'
                        size='sm'
                        variant='secondary'
                        clickAction={actions.addFrame}
                    />
                    <Button
                        label='dup frame'
                        size='sm'
                        variant='secondary'
                        clickAction={actions.duplicateFrame}
                    />
                    <Button
                        label='del frame'
                        size='sm'
                        variant='secondary'
                        clickAction={actions.removeFrame}
                    />
                    <Button
                        label={playing ? 'stop' : 'play'}
                        size='sm'
                        variant={playing ? 'primary' : 'secondary'}
                        clickAction={() => {
                            setPlaying(v => !v)
                        }}
                    />
                    <div style={{width: 80}}>
                        <NumberInput
                            label='fps'
                            isLabelHidden
                            size='sm'
                            min={1}
                            max={60}
                            value={fps}
                            onChange={setFps}
                        />
                    </div>
                    <Button
                        label={settings.frameOnion ? 'frame onion: on' : 'frame onion: off'}
                        size='sm'
                        variant={settings.frameOnion ? 'primary' : 'secondary'}
                        clickAction={() => {
                            setSettings(s => ({...s, frameOnion: !s.frameOnion}))
                        }}
                    />
                </HStack>
                {doc.tags.map(tag => (
                    <TagRow
                        key={tag.name}
                        editor={editor}
                        tag={tag}
                    />
                ))}
                <HStack
                    gap={2}
                    align='center'
                >
                    <Button
                        label='+ tag on this frame'
                        size='sm'
                        variant='secondary'
                        clickAction={() => {
                            actions.addTag(uniqueTagName(doc), frame, frame)
                        }}
                    />
                    <Text type='supporting'>
                        <span data-testid='tag-summary'>
                            {doc.tags.length === 0 ?
                                'no tags'
                            :   doc.tags
                                    .map(
                                        tag =>
                                            `${tag.name} ${String(tag.from + 1)}–${String(tag.to + 1)}`
                                    )
                                    .join(', ')
                            }
                        </span>
                    </Text>
                </HStack>
            </VStack>
        </div>
    )
}

const LayerList = ({editor}: {editor: EditorApi}) => {
    const {snapshot, actions, navigate} = editor

    return (
        <VStack gap={1}>
            {snapshot.doc.layers.map((layer, index) => (
                <HStack
                    key={layer.id}
                    gap={1}
                    align='center'
                >
                    <Button
                        label={layer.visible ? '👁' : '—'}
                        size='sm'
                        variant='secondary'
                        clickAction={() => {
                            actions.patchLayer(index, {visible: !layer.visible})
                        }}
                    />
                    <Button
                        label={layer.locked ? '🔒' : '🔓'}
                        size='sm'
                        variant='secondary'
                        clickAction={() => {
                            actions.patchLayer(index, {locked: !layer.locked})
                        }}
                    />
                    <Button
                        label={layer.name}
                        size='sm'
                        variant={index === snapshot.layer ? 'primary' : 'secondary'}
                        clickAction={() => {
                            navigate({layer: index})
                        }}
                    />
                </HStack>
            ))}
        </VStack>
    )
}

export const Editor = ({zoom = 20}: {zoom?: number}) => {
    const editor = useEditor()
    const {snapshot, settings, setSettings, actions} = editor
    const {doc, slice, frame} = snapshot
    const fileInput = useRef<HTMLInputElement>(null)
    const [status, setStatus] = useState<string | null>(null)
    // one document, two ways of editing it — §6's "the two modes stay one document"
    const [mode, setMode] = useState<Mode>('slice')
    // the rig outlives the panel: switching modes to add a frame must not lose the bones
    const [rig, setRig] = useState<Rig>({bones: []})

    /**
     * Opening a file replaces the whole document, so it goes through the same commit path as any
     * other edit — the previous document stays on the undo stack and ctrl-z gets it back.
     */
    const openFile = useCallback(
        async (file: File | undefined): Promise<void> => {
            if (!file) {
                return
            }
            try {
                const imported = readImport(file.name, new Uint8Array(await file.arrayBuffer()))
                if (imported.kind === 'vox' && imported.scene) {
                    actions.importScene(imported.scene, imported.name)
                    setStatus(
                        `imported ${imported.name}.vox —`
                            + ` ${String(imported.scene.models.length)} layers`
                    )
                } else if (imported.kind === 'vox') {
                    actions.importModel(imported.model, imported.name)
                    setStatus(
                        `imported ${imported.name}.vox — ${String(imported.model.voxels.size)} voxels`
                    )
                } else {
                    actions.loadText(imported.text)
                    setStatus(`opened ${imported.name}.json`)
                }
            } catch (error) {
                setStatus(error instanceof Error ? error.message : String(error))
            }
        },
        [actions]
    )

    // keyboard shortcuts, the ones a pixel artist expects to work without looking
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            const meta = event.ctrlKey || event.metaKey
            if (meta && event.key.toLowerCase() === 'z') {
                event.preventDefault()
                if (event.shiftKey) {
                    editor.redo()
                } else {
                    editor.undo()
                }
                return
            }
            if (meta && event.key.toLowerCase() === 'c') {
                actions.copy()
                return
            }
            if (meta && event.key.toLowerCase() === 'v') {
                actions.paste()
                return
            }
            if (meta && event.key.toLowerCase() === 'x') {
                actions.cut()
                return
            }
            if (meta && event.key.toLowerCase() === 'a') {
                event.preventDefault()
                actions.selectAll()
                return
            }
            if (event.key === 'Escape') {
                actions.deselect()
                return
            }
            if (event.key === 'Delete' || event.key === 'Backspace') {
                actions.remove()
                return
            }
            if (event.key === 'PageUp' || event.key === 'ArrowUp') {
                editor.navigate({slice: Math.min(doc.size.sz - 1, slice + 1)})
                return
            }
            if (event.key === 'PageDown' || event.key === 'ArrowDown') {
                editor.navigate({slice: Math.max(0, slice - 1)})
            }
        }
        window.addEventListener('keydown', onKey)
        return () => {
            window.removeEventListener('keydown', onKey)
        }
    }, [editor, actions, doc.size.sz, slice])

    return (
        <div
            data-testid='editor-root'
            onDragOver={event => {
                event.preventDefault()
            }}
            onDrop={event => {
                event.preventDefault()
                void openFile(event.dataTransfer.files[0])
            }}
        >
            <VStack
                gap={3}
                padding={3}
            >
                <HStack
                    gap={2}
                    align='center'
                >
                    {(Object.keys(MODE_LABELS) as Mode[]).map(option => (
                        <Button
                            key={option}
                            label={MODE_LABELS[option]}
                            size='sm'
                            variant={mode === option ? 'primary' : 'secondary'}
                            clickAction={() => {
                                setMode(option)
                            }}
                        />
                    ))}
                    {mode === 'slice'
                        && TOOLS.map(([tool, glyph]) => (
                            <Button
                                key={tool}
                                label={glyph}
                                size='sm'
                                variant={settings.tool === tool ? 'primary' : 'secondary'}
                                clickAction={() => {
                                    setSettings(s => ({...s, tool}))
                                }}
                            />
                        ))}
                </HStack>

                {mode === '3d' && <Viewport3D editor={editor} />}
                {mode === 'generate' && <GeneratePanel editor={editor} />}
                {mode === 'export' && <ExportPanel editor={editor} />}
                {mode === 'fx' && <EffectsPanel editor={editor} />}
                {mode === 'rig' && (
                    <RigPanel
                        editor={editor}
                        rig={rig}
                        setRig={setRig}
                    />
                )}

                <HStack
                    gap={2}
                    align='center'
                >
                    <Button
                        label='undo'
                        size='sm'
                        variant='secondary'
                        clickAction={editor.undo}
                    />
                    <Button
                        label='redo'
                        size='sm'
                        variant='secondary'
                        clickAction={editor.redo}
                    />
                    <Button
                        label={settings.mirrorX ? 'mirror x: on' : 'mirror x'}
                        size='sm'
                        variant={settings.mirrorX ? 'primary' : 'secondary'}
                        clickAction={() => {
                            setSettings(s => ({...s, mirrorX: !s.mirrorX}))
                        }}
                    />
                    <Button
                        label={settings.mirrorY ? 'mirror y: on' : 'mirror y'}
                        size='sm'
                        variant={settings.mirrorY ? 'primary' : 'secondary'}
                        clickAction={() => {
                            setSettings(s => ({...s, mirrorY: !s.mirrorY}))
                        }}
                    />
                    <Button
                        label={settings.filled ? 'filled' : 'outline'}
                        size='sm'
                        variant='secondary'
                        clickAction={() => {
                            setSettings(s => ({...s, filled: !s.filled}))
                        }}
                    />
                    <Button
                        label={settings.onionSkin ? 'onion: on' : 'onion: off'}
                        size='sm'
                        variant='secondary'
                        clickAction={() => {
                            setSettings(s => ({...s, onionSkin: !s.onionSkin}))
                        }}
                    />
                    <Button
                        label='copy slice up'
                        size='sm'
                        variant='secondary'
                        clickAction={() => {
                            actions.copySliceTo(Math.min(doc.size.sz - 1, slice + 1))
                        }}
                    />
                </HStack>

                <HStack
                    gap={4}
                    align='start'
                >
                    <SliceStrip editor={editor} />
                    <VStack gap={2}>
                        <SliceCanvas
                            editor={editor}
                            zoom={zoom}
                        />
                        <PaletteBar editor={editor} />
                        <FrameBar editor={editor} />
                        <Text type='supporting'>
                            {`slice ${String(slice)}/${String(doc.size.sz - 1)} · frame ${String(frame + 1)}/${String(doc.frames)} · ${editor.undoLabel ?? 'nothing'} to undo · ${String(Math.round(editor.historyBytes / 1024))} KB of history`}
                        </Text>
                    </VStack>
                    <VStack gap={3}>
                        <StackedPreview
                            editor={editor}
                            angle={0}
                        />
                        <PalettePanel editor={editor} />
                        <LayerList editor={editor} />
                        <HStack gap={2}>
                            <Button
                                label='+ layer'
                                size='sm'
                                variant='secondary'
                                clickAction={actions.addLayer}
                            />
                            <Button
                                label='- layer'
                                size='sm'
                                variant='secondary'
                                clickAction={actions.removeLayer}
                            />
                        </HStack>
                        <HStack gap={2}>
                            <input
                                ref={fileInput}
                                type='file'
                                data-testid='import-input'
                                accept='.vox,.json,application/json,application/octet-stream'
                                style={{display: 'none'}}
                                onChange={event => {
                                    void openFile(event.target.files?.[0]).finally(() => {
                                        // clearing lets the same file be re-opened, which is what a
                                        // person doing "undo, try again" expects
                                        event.target.value = ''
                                    })
                                }}
                            />
                            <Button
                                label='open .vox / .json'
                                size='sm'
                                variant='secondary'
                                clickAction={() => {
                                    fileInput.current?.click()
                                }}
                            />
                        </HStack>
                        <HStack gap={2}>
                            <Button
                                label='save .json'
                                size='sm'
                                variant='secondary'
                                clickAction={() => {
                                    download(
                                        `${doc.name}.json`,
                                        actions.saveText(),
                                        'application/json'
                                    )
                                }}
                            />
                            <Button
                                label='export .vox'
                                size='sm'
                                variant='secondary'
                                clickAction={() => {
                                    download(
                                        `${doc.name}.vox`,
                                        frameToVox(doc, frame),
                                        'application/octet-stream'
                                    )
                                }}
                            />
                        </HStack>
                        <Text type='supporting'>
                            <span data-testid='import-status'>
                                {status ?? 'drop a .vox or .json anywhere to open it'}
                            </span>
                        </Text>
                    </VStack>
                </HStack>
            </VStack>
        </div>
    )
}
