import {useEffect, useRef, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {HStack} from '@astryxdesign/core/HStack'
import {NumberInput} from '@astryxdesign/core/NumberInput'
import {Text} from '@astryxdesign/core/Text'
import {VStack} from '@astryxdesign/core/VStack'
import {encodePng} from '../image/png'
import type {RgbaImage} from '../image/rgba'
import {sidecarJson, type Atlas} from '../export/atlas'
import {angleAdvice} from '../export/angles'
import {frameToModel} from '../doc/document'
import {bakeAtlas} from './bake'
import {godotCanvasTexture, godotResource} from '../export/godot'
import {sliceStrip, stripLayout} from '../export/strip'
import {frameToLayeredVox, frameToVox} from '../doc/document'
import {download} from './download'
import type {Editor as EditorApi} from './useEditor'

/**
 * `PRODUCTION_PLAN.md` §11's export list behind a panel: the spritesheet with its matching
 * normal-map sheet and JSON sidecar, the Godot 4.7 package, slice strips, and `.vox`.
 *
 * Files come out one at a time rather than as an archive. A zip writer is a dependency and a
 * format to get wrong for no gain — the browser can save four files as easily as one.
 */
const ANGLE_CHOICES = [8, 16, 32, 64]

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

export const ExportPanel = ({editor}: {editor: EditorApi}) => {
    const {snapshot} = editor
    const {doc, frame} = snapshot
    const [angles, setAngles] = useState(16)
    const [scale, setScale] = useState(4)
    const [trim, setTrim] = useState(true)
    const [powerOfTwo, setPowerOfTwo] = useState(false)
    const [atlas, setAtlas] = useState<Atlas | null>(null)
    const [status, setStatus] = useState('nothing baked yet')
    const preview = useRef<HTMLCanvasElement>(null)
    const previewNormal = useRef<HTMLCanvasElement>(null)

    useEffect(() => {
        if (atlas) {
            paint(preview.current, atlas.albedo)
            paint(previewNormal.current, atlas.normal)
        }
    }, [atlas])

    const [baking, setBaking] = useState(false)

    /** The bake runs in a Worker, so a 32-angle sheet does not freeze the editor. */
    const bake = async (): Promise<void> => {
        setBaking(true)
        setStatus('baking…')
        try {
            const {
                atlas: baked,
                ms,
                offThread
            } = await bakeAtlas(doc, {
                angles,
                scale,
                trim,
                powerOfTwo
            })
            setAtlas(baked)
            setStatus(
                `${String(baked.sidecar.rects.length)} sprites`
                    + ` · sheet ${String(baked.sidecar.sheet.width)}×${String(baked.sidecar.sheet.height)}`
                    + ` · cell ${String(baked.sidecar.cell.width)}×${String(baked.sidecar.cell.height)}`
                    + ` · pivot ${String(Math.round(baked.sidecar.pivot.x))},${String(Math.round(baked.sidecar.pivot.y))}`
                    + ` · ${ms.toFixed(0)} ms ${offThread ? 'in a worker' : 'on this thread'}`
            )
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error))
        } finally {
            setBaking(false)
        }
    }

    const saveSheets = async (): Promise<void> => {
        if (!atlas) {
            return
        }
        download(`${doc.name}.png`, await encodePng(atlas.albedo), 'image/png')
        download(`${doc.name}_n.png`, await encodePng(atlas.normal), 'image/png')
        download(`${doc.name}.json`, sidecarJson(atlas.sidecar), 'application/json')
        setStatus(`saved ${doc.name}.png, ${doc.name}_n.png and the sidecar`)
    }

    const saveGodot = (): void => {
        if (!atlas) {
            return
        }
        const paths = {
            albedoPath: `res://${doc.name}.png`,
            normalPath: `res://${doc.name}_n.png`
        }
        download(`${doc.name}.tres`, godotResource(atlas.sidecar, paths), 'text/plain')
        download(`${doc.name}_canvas.tres`, godotCanvasTexture(paths), 'text/plain')
        setStatus(`saved ${doc.name}.tres — load it on an AnimatedSprite2D`)
    }

    return (
        <div data-testid='export-panel'>
            <VStack gap={2}>
                <HStack
                    gap={2}
                    align='center'
                >
                    <Text type='supporting'>angles</Text>
                    {ANGLE_CHOICES.map(choice => (
                        <Button
                            key={choice}
                            label={String(choice)}
                            size='sm'
                            variant={angles === choice ? 'primary' : 'secondary'}
                            clickAction={() => {
                                setAngles(choice)
                            }}
                        />
                    ))}
                    <div style={{width: 90}}>
                        <NumberInput
                            label='scale'
                            isLabelHidden
                            size='sm'
                            min={1}
                            max={16}
                            value={scale}
                            onChange={setScale}
                        />
                    </div>
                    <Button
                        label={trim ? 'trim: on' : 'trim: off'}
                        size='sm'
                        variant={trim ? 'primary' : 'secondary'}
                        clickAction={() => {
                            setTrim(v => !v)
                        }}
                    />
                    <Button
                        label={powerOfTwo ? 'power of two: on' : 'power of two: off'}
                        size='sm'
                        variant={powerOfTwo ? 'primary' : 'secondary'}
                        clickAction={() => {
                            setPowerOfTwo(v => !v)
                        }}
                    />
                    <Button
                        label='suggest'
                        size='sm'
                        variant='secondary'
                        clickAction={() => {
                            // measured per model, because the right count is a property of the
                            // shape: a cylinder needs 8, a truck needs 32 (§8, §14)
                            const advice = angleAdvice(frameToModel(doc, frame))
                            setAngles(advice.suggested)
                            setStatus(
                                `suggested ${String(advice.suggested)} angles · `
                                    + advice.options
                                        .map(
                                            option =>
                                                `${String(option.angles)}: ${(option.error * 100).toFixed(0)}%`
                                        )
                                        .join(' ')
                                    + ` · ${(advice.stepChange * 100).toFixed(0)}% of the silhouette changes per step`
                            )
                        }}
                    />
                    <Button
                        label={baking ? 'baking…' : 'bake'}
                        size='sm'
                        variant='primary'
                        isDisabled={baking}
                        clickAction={bake}
                    />
                </HStack>

                <Text type='supporting'>
                    <span data-testid='export-status'>{status}</span>
                </Text>

                <HStack
                    gap={2}
                    align='center'
                >
                    <Button
                        label='save sheets + sidecar'
                        size='sm'
                        variant='secondary'
                        isDisabled={!atlas}
                        clickAction={saveSheets}
                    />
                    <Button
                        label='save Godot .tres'
                        size='sm'
                        variant='secondary'
                        isDisabled={!atlas}
                        clickAction={saveGodot}
                    />
                    <Button
                        label='save slice strip'
                        size='sm'
                        variant='secondary'
                        clickAction={async () => {
                            const image = sliceStrip(doc, frame, stripLayout({scale: 1}))
                            download(`${doc.name}_slices.png`, await encodePng(image), 'image/png')
                            setStatus(`saved ${doc.name}_slices.png — edit it and drop it back`)
                        }}
                    />
                    <Button
                        label='save .vox'
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
                    <Button
                        label='save .vox (layers)'
                        size='sm'
                        variant='secondary'
                        clickAction={() => {
                            download(
                                `${doc.name}-layers.vox`,
                                frameToLayeredVox(doc, frame),
                                'application/octet-stream'
                            )
                            setStatus(
                                `saved ${String(doc.layers.length)} layers as separate models`
                                    + ' with their names and visibility'
                            )
                        }}
                    />
                </HStack>

                <HStack
                    gap={3}
                    align='start'
                >
                    <VStack gap={1}>
                        <Text type='supporting'>albedo</Text>
                        <canvas
                            ref={preview}
                            data-testid='export-albedo'
                            style={{
                                imageRendering: 'pixelated',
                                display: 'block',
                                maxWidth: 700,
                                background: '#1e1e1e'
                            }}
                        />
                    </VStack>
                    <VStack gap={1}>
                        <Text type='supporting'>normals</Text>
                        <canvas
                            ref={previewNormal}
                            data-testid='export-normal'
                            style={{
                                imageRendering: 'pixelated',
                                display: 'block',
                                maxWidth: 700,
                                background: '#1e1e1e'
                            }}
                        />
                    </VStack>
                </HStack>
            </VStack>
        </div>
    )
}
