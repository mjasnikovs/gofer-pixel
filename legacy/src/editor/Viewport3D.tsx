import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {HStack} from '@astryxdesign/core/HStack'
import {Text} from '@astryxdesign/core/Text'
import {VStack} from '@astryxdesign/core/VStack'
import {frameToModel} from '../doc/document'
import {light, rotationSheet} from '../vox/render'
import type {RgbaImage} from '../image/rgba'
import type {BrushMode, BrushShape} from './brush3d'
import {renderOrtho, toCell, viewSize, type Axis, type OrthoView} from './view3d'
import type {Editor as EditorApi} from './useEditor'

/**
 * The quad viewport of `PRODUCTION_PLAN.md` §6: top, front and side orthographic views plus the
 * rotating stacked render, which stands in for the perspective view because it is the thing the
 * asset actually has to look right in.
 *
 * Every view is one pixel per voxel and scaled by the DOM, exactly like the slice canvas, so the
 * whole 3D mode costs three small CPU renders per edit and no GPU path at all (§3).
 */
const SHAPES: [BrushShape | 'region' | 'pick', string][] = [
    ['voxel', 'voxel'],
    ['face', 'face'],
    ['box', 'box'],
    ['line', 'line'],
    ['centre', 'centre'],
    ['region', 'region'],
    ['pick', 'pick']
]

const MODES: BrushMode[] = ['attach', 'erase', 'paint']

const AXES: [Axis | null, string][] = [
    [null, 'free'],
    ['x', 'lock x'],
    ['y', 'lock y'],
    ['z', 'lock z']
]

const pixelated = {imageRendering: 'pixelated' as const, display: 'block' as const}

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

const OrthoPane = ({editor, view, zoom}: {editor: EditorApi; view: OrthoView; zoom: number}) => {
    const canvas = useRef<HTMLCanvasElement>(null)
    const {snapshot, settings} = editor
    const {doc, frame, slice} = snapshot

    useEffect(() => {
        paint(
            canvas.current,
            renderOrtho(doc, frame, view, settings.sliceLock ? {lockZ: slice} : {})
        )
    }, [doc, frame, view, settings.sliceLock, slice])

    const locate = useCallback(
        (event: {clientX: number; clientY: number}): [number, number] => {
            const rect = canvas.current?.getBoundingClientRect()
            return rect ? toCell(event.clientX, event.clientY, rect, view, doc.size) : [0, 0]
        },
        [doc.size, view]
    )

    const {width, height} = viewSize(view, doc.size)

    return (
        <VStack gap={1}>
            <Text type='supporting'>{view}</Text>
            <canvas
                ref={canvas}
                data-testid={`view-${view}`}
                style={{
                    ...pixelated,
                    width: width * zoom,
                    height: height * zoom,
                    background: '#1e1e1e',
                    outline: '1px solid #333',
                    touchAction: 'none',
                    cursor: 'crosshair'
                }}
                onPointerDown={event => {
                    event.currentTarget.setPointerCapture(event.pointerId)
                    const [h, v] = locate(event)
                    editor.pointerDown3d(view, h, v)
                }}
                onPointerMove={event => {
                    const [h, v] = locate(event)
                    editor.pointerMove3d(h, v)
                }}
                onPointerUp={event => {
                    const [h, v] = locate(event)
                    editor.pointerUp3d(h, v)
                }}
                onPointerCancel={event => {
                    const [h, v] = locate(event)
                    editor.pointerUp3d(h, v)
                }}
            />
        </VStack>
    )
}

/** The fourth pane: the model as it will ship, lit, at eight angles. */
const StackedPane = ({editor}: {editor: EditorApi}) => {
    const canvas = useRef<HTMLCanvasElement>(null)
    const {doc, frame} = editor.snapshot
    const model = useMemo(() => frameToModel(doc, frame), [doc, frame])

    useEffect(() => {
        paint(canvas.current, light(rotationSheet(model, 8, {scale: 3})))
    }, [model])

    return (
        <VStack gap={1}>
            <Text type='supporting'>8 angles, lit</Text>
            <canvas
                ref={canvas}
                data-testid='view-stacked'
                style={{...pixelated, maxWidth: 460, background: '#1e1e1e'}}
            />
        </VStack>
    )
}

export const Viewport3D = ({editor, zoom = 10}: {editor: EditorApi; zoom?: number}) => {
    const {settings, setSettings, snapshot, actions} = editor
    // replace-colour needs two colours. The source is set explicitly rather than remembered from
    // the last eyedropper hit, so it cannot change under you while you pick the destination.
    const [source, setSource] = useState<number | null>(null)

    return (
        <div data-testid='viewport-3d'>
            <VStack gap={3}>
                <HStack
                    gap={1}
                    align='center'
                >
                    <Text type='supporting'>brush</Text>
                    {SHAPES.map(([shape, label]) => (
                        <Button
                            key={shape}
                            label={label}
                            size='sm'
                            variant={settings.shape3d === shape ? 'primary' : 'secondary'}
                            clickAction={() => {
                                setSettings(s => ({...s, shape3d: shape}))
                            }}
                        />
                    ))}
                </HStack>

                <HStack
                    gap={1}
                    align='center'
                >
                    <Text type='supporting'>mode</Text>
                    {MODES.map(mode => (
                        <Button
                            key={mode}
                            label={mode}
                            size='sm'
                            variant={settings.mode3d === mode ? 'primary' : 'secondary'}
                            clickAction={() => {
                                setSettings(s => ({...s, mode3d: mode}))
                            }}
                        />
                    ))}
                    {AXES.map(([axis, label]) => (
                        <Button
                            key={label}
                            label={label}
                            size='sm'
                            variant={settings.axisLock === axis ? 'primary' : 'secondary'}
                            clickAction={() => {
                                setSettings(s => ({...s, axisLock: axis}))
                            }}
                        />
                    ))}
                    <Button
                        label={
                            settings.sliceLock ?
                                `slice lock: ${String(snapshot.slice)}`
                            :   'slice lock: off'
                        }
                        size='sm'
                        variant={settings.sliceLock ? 'primary' : 'secondary'}
                        clickAction={() => {
                            setSettings(s => ({...s, sliceLock: !s.sliceLock}))
                        }}
                    />
                </HStack>

                <HStack
                    gap={1}
                    align='center'
                >
                    <Text type='supporting'>colour</Text>
                    <Button
                        label='remove this colour'
                        size='sm'
                        variant='secondary'
                        clickAction={() => {
                            actions.removeColor(settings.color)
                        }}
                    />
                    <Button
                        label={`source: ${source === null ? 'none' : String(source)}`}
                        size='sm'
                        variant='secondary'
                        clickAction={() => {
                            setSource(settings.color)
                        }}
                    />
                    <Button
                        label={
                            source === null ?
                                'replace: set a source first'
                            :   `replace ${String(source)} → ${String(settings.color)}`
                        }
                        size='sm'
                        variant='secondary'
                        isDisabled={source === null || source === settings.color}
                        clickAction={() => {
                            if (source !== null) {
                                actions.replaceColorInCel(source, settings.color)
                            }
                        }}
                    />
                </HStack>

                <HStack
                    gap={3}
                    align='start'
                >
                    <OrthoPane
                        editor={editor}
                        view='top'
                        zoom={zoom}
                    />
                    <OrthoPane
                        editor={editor}
                        view='front'
                        zoom={zoom}
                    />
                    <OrthoPane
                        editor={editor}
                        view='side'
                        zoom={zoom}
                    />
                    <StackedPane editor={editor} />
                </HStack>
            </VStack>
        </div>
    )
}
