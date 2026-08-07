import {useEffect, useRef, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {HStack} from '@astryxdesign/core/HStack'
import {NumberInput} from '@astryxdesign/core/NumberInput'
import {Text} from '@astryxdesign/core/Text'
import {TextArea} from '@astryxdesign/core/TextArea'
import {VStack} from '@astryxdesign/core/VStack'
import {editCel, frameToModel} from '../doc/document'
import {renderAngle} from '../vox/render'
import {applyPasses, dither, lambert, normalOcclusion, outline, type Pass} from '../fx/passes'
import {SCRIPT_PRESETS, runVoxelScript, type ScriptOptions} from '../fx/voxelScript'
import type {RgbaImage} from '../image/rgba'
import type {Editor as EditorApi} from './useEditor'

/**
 * `PRODUCTION_PLAN.md` §8's two halves in one panel, because they are the same idea at two levels:
 * the pass pipeline changes pixels after the render, the voxel script changes voxels before it.
 *
 * The preview is a single angle at a small scale, which is a few milliseconds of CPU — §14's
 * measurement says one angle of a 32³ model is 5.6 ms, so this repaints inside a frame budget with
 * no GPU path involved.
 */
type PassName = 'outline' | 'dither' | 'occlusion' | 'lambert'

const OUTLINE_COLOR = {r: 12, g: 12, b: 18, a: 255}

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

export const EffectsPanel = ({editor}: {editor: EditorApi}) => {
    const {snapshot, mutate} = editor
    const {doc, frame} = snapshot
    const [enabled, setEnabled] = useState<Record<PassName, boolean>>({
        outline: true,
        dither: false,
        occlusion: true,
        lambert: true
    })
    const [angle, setAngle] = useState(30)
    const [source, setSource] = useState(SCRIPT_PRESETS[0]?.source ?? '')
    const [mode, setMode] = useState<NonNullable<ScriptOptions['mode']>>('paint')
    const [status, setStatus] = useState('no script run yet')
    const canvas = useRef<HTMLCanvasElement>(null)

    useEffect(() => {
        const sheet = renderAngle(frameToModel(doc, frame), angle, {scale: 4})
        const passes: Pass[] = []
        if (enabled.occlusion) {
            passes.push(normalOcclusion(0.6))
        }
        if (enabled.lambert) {
            passes.push(lambert())
        }
        if (enabled.dither) {
            passes.push(dither(0.35))
        }
        if (enabled.outline) {
            passes.push(outline(OUTLINE_COLOR))
        }
        paint(canvas.current, applyPasses(sheet.albedo, passes, sheet))
    }, [doc, frame, angle, enabled])

    const run = (): void => {
        try {
            let result = {changed: 0, visited: 0}
            mutate('voxel script', current =>
                editCel(current, snapshot.layer, frame, volume => {
                    result = runVoxelScript(volume, current.size, source, {mode})
                })
            )
            setStatus(
                `${String(result.changed)} voxels changed of ${String(result.visited)} visited`
            )
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error))
        }
    }

    return (
        <div data-testid='effects-panel'>
            <VStack gap={3}>
                <HStack
                    gap={2}
                    align='center'
                >
                    <Text type='supporting'>passes</Text>
                    {(['outline', 'dither', 'occlusion', 'lambert'] as PassName[]).map(name => (
                        <Button
                            key={name}
                            label={name}
                            size='sm'
                            variant={enabled[name] ? 'primary' : 'secondary'}
                            clickAction={() => {
                                setEnabled(current => ({...current, [name]: !current[name]}))
                            }}
                        />
                    ))}
                    <div style={{width: 90}}>
                        <NumberInput
                            label='angle'
                            isLabelHidden
                            size='sm'
                            min={0}
                            max={359}
                            value={angle}
                            onChange={setAngle}
                        />
                    </div>
                </HStack>

                <canvas
                    ref={canvas}
                    data-testid='effects-preview'
                    style={{
                        imageRendering: 'pixelated',
                        display: 'block',
                        maxWidth: 420,
                        background: '#1e1e1e'
                    }}
                />

                <HStack
                    gap={2}
                    align='center'
                >
                    <Text type='supporting'>voxel script</Text>
                    {SCRIPT_PRESETS.map(preset => (
                        <Button
                            key={preset.name}
                            label={preset.name}
                            size='sm'
                            variant='secondary'
                            clickAction={() => {
                                setSource(preset.source)
                                setMode(preset.mode)
                            }}
                        />
                    ))}
                </HStack>

                <div style={{maxWidth: 720}}>
                    <TextArea
                        label='script'
                        isLabelHidden
                        rows={3}
                        value={source}
                        onChange={setSource}
                    />
                </div>

                <HStack
                    gap={2}
                    align='center'
                >
                    {(['set', 'add', 'paint'] as const).map(option => (
                        <Button
                            key={option}
                            label={option}
                            size='sm'
                            variant={mode === option ? 'primary' : 'secondary'}
                            clickAction={() => {
                                setMode(option)
                            }}
                        />
                    ))}
                    <Button
                        label='run script'
                        size='sm'
                        variant='primary'
                        clickAction={run}
                    />
                    <Text type='supporting'>
                        <span data-testid='script-status'>{status}</span>
                    </Text>
                </HStack>
            </VStack>
        </div>
    )
}
