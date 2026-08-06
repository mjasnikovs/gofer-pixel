import {useEffect, useRef, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {HStack} from '@astryxdesign/core/HStack'
import {Text} from '@astryxdesign/core/Text'
import {VStack} from '@astryxdesign/core/VStack'
import {readVox} from '../vox/vox-file'
import {light, rotationSheet} from '../vox/render'
import type {RgbaImage} from '../image/rgba'
import type {VoxModel} from '../vox/model'

const MODELS = ['car.vox', 'truck.vox', 'fork.vox', 'fork1.vox']

const paint = (canvas: HTMLCanvasElement, image: RgbaImage): void => {
    const ctx = canvas.getContext('2d')
    if (!ctx) {
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

/** The original playground: load a `.vox` from disk and look at its rotation sheet. */
export const Viewer = () => {
    const [name, setName] = useState(MODELS[0] ?? 'car.vox')
    const [model, setModel] = useState<VoxModel | null>(null)
    const [lit, setLit] = useState(true)
    const canvas = useRef<HTMLCanvasElement>(null)

    useEffect(() => {
        let cancelled = false
        const load = async () => {
            const bytes = new Uint8Array(await (await fetch(`/${name}`)).arrayBuffer())
            if (!cancelled) {
                setModel(readVox(bytes))
            }
        }
        void load()
        return () => {
            cancelled = true
        }
    }, [name])

    useEffect(() => {
        if (!model || !canvas.current) {
            return
        }
        const sheet = rotationSheet(model, 8, {scale: 4})
        paint(canvas.current, lit ? light(sheet) : sheet.albedo)
    }, [model, lit])

    return (
        <VStack gap={3}>
            <Text type='body'>
                {model ?
                    `${name} — ${String(model.sx)}×${String(model.sy)}×${String(model.sz)}, ${String(model.voxels.size)} voxels`
                :   'loading…'}
            </Text>
            <HStack gap={2}>
                {MODELS.map(m => (
                    <Button
                        key={m}
                        label={m}
                        size='sm'
                        variant={m === name ? 'primary' : 'secondary'}
                        clickAction={() => {
                            setName(m)
                        }}
                    />
                ))}
                <Button
                    label={lit ? 'lit' : 'albedo'}
                    size='sm'
                    variant='secondary'
                    clickAction={() => {
                        setLit(v => !v)
                    }}
                />
            </HStack>
            <canvas
                ref={canvas}
                style={{imageRendering: 'pixelated', maxWidth: '100%'}}
            />
        </VStack>
    )
}
