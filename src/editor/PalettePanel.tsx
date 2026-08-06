import {useRef, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {HStack} from '@astryxdesign/core/HStack'
import {NumberInput} from '@astryxdesign/core/NumberInput'
import {Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import {VStack} from '@astryxdesign/core/VStack'
import {closeColors, colorUsage, flatSlicePairs, type SortKey} from '../doc/palette'
import {encodePalette, toStrip, type PaletteFormat} from '../doc/palette-formats'
import {colorToHex} from '../doc/serialize'
import {encodePng} from '../image/png'
import {download} from './download'
import {readPalette} from './files'
import type {Editor as EditorApi} from './useEditor'

const SORTS: SortKey[] = ['luminance', 'hue', 'saturation']
const FORMATS: PaletteFormat[] = ['gpl', 'hex', 'pal']

const swatch = (color: string, border: string): React.CSSProperties => ({
    width: 20,
    height: 20,
    padding: 0,
    background: color,
    border,
    cursor: 'pointer'
})

/**
 * The palette editor proper. The swatch bar beside the canvas is for picking a colour; this is for
 * changing the palette itself, which is a different job and needs two selected entries rather than
 * one — gradients and ramps both run between a pair.
 *
 * Click picks the paint colour, shift-click sets the other end.
 */
export const PalettePanel = ({editor}: {editor: EditorApi}) => {
    const {snapshot, settings, setSettings, actions} = editor
    const {doc, frame} = snapshot
    const [anchor, setAnchor] = useState(1)
    const [rampName, setRampName] = useState('ramp')
    const [rampSteps, setRampSteps] = useState(5)
    const [tolerance, setTolerance] = useState(2)
    const [report, setReport] = useState<string | null>(null)
    const [note, setNote] = useState<string | null>(null)
    const input = useRef<HTMLInputElement>(null)

    const usage = colorUsage(doc)
    const current = settings.color
    const hex = (index: number): string =>
        colorToHex(doc.palette[index - 1] ?? {r: 0, g: 0, b: 0, a: 0})

    const check = (): void => {
        const close = closeColors(doc.palette, tolerance)
        const flat = flatSlicePairs(doc, frame)
        setReport(
            `${String(close.length)} palette pairs within ${String(tolerance)} · `
                + `${String(flat.length)} adjacent slice pairs under 3 L*`
                + (flat[0] ?
                    ` (first: slices ${String(flat[0].lower)}/${String(flat[0].upper)}, ΔL ${flat[0].deltaL.toFixed(1)})`
                :   '')
        )
    }

    const importPalette = async (file: File | undefined): Promise<void> => {
        if (!file) {
            return
        }
        try {
            const palette = await readPalette(file.name, new Uint8Array(await file.arrayBuffer()))
            actions.setPalette(palette)
            setNote(`imported ${String(palette.length)} colours from ${file.name}`)
        } catch (error) {
            setNote(error instanceof Error ? error.message : String(error))
        }
    }

    return (
        <div data-testid='palette-panel'>
            <VStack gap={2}>
                <Text type='supporting'>
                    <span data-testid='palette-summary'>
                        {`palette ${String(doc.palette.length)} · paint ${String(current)} ${hex(current)} · other end ${String(anchor)} ${hex(anchor)}`}
                    </span>
                </Text>

                <div style={{display: 'grid', gridTemplateColumns: 'repeat(16, 20px)', gap: 2}}>
                    {doc.palette.map((color, i) => {
                        const value = i + 1
                        const border =
                            value === current ? '2px solid #7aa2f7'
                            : value === anchor ? '2px solid #e0af68'
                            : '1px solid #333'
                        return (
                            <button
                                key={`${String(i)}-${colorToHex(color)}`}
                                type='button'
                                data-testid={`palette-swatch-${String(value)}`}
                                title={`${String(value)} ${colorToHex(color)} · ${String(usage.get(value) ?? 0)} voxels`}
                                onClick={event => {
                                    if (event.shiftKey) {
                                        setAnchor(value)
                                    } else {
                                        setSettings(s => ({...s, color: value}))
                                    }
                                }}
                                style={swatch(colorToHex(color), border)}
                            />
                        )
                    })}
                </div>

                <HStack
                    gap={2}
                    align='center'
                >
                    <Text type='supporting'>sort</Text>
                    {SORTS.map(by => (
                        <Button
                            key={by}
                            label={by}
                            size='sm'
                            variant='secondary'
                            clickAction={() => {
                                actions.sortPalette(by)
                            }}
                        />
                    ))}
                </HStack>

                <HStack
                    gap={2}
                    align='center'
                >
                    <Text type='supporting'>gradient</Text>
                    <Button
                        label='fill between'
                        size='sm'
                        variant='secondary'
                        clickAction={() => {
                            actions.gradientBetween(anchor, current, false)
                        }}
                    />
                    <Button
                        label='fill by hue'
                        size='sm'
                        variant='secondary'
                        clickAction={() => {
                            actions.gradientBetween(anchor, current, true)
                        }}
                    />
                </HStack>

                <HStack
                    gap={2}
                    align='center'
                >
                    <div style={{width: 110}}>
                        <TextInput
                            label='ramp name'
                            isLabelHidden
                            size='sm'
                            value={rampName}
                            onChange={setRampName}
                        />
                    </div>
                    <div style={{width: 80}}>
                        <NumberInput
                            label='steps'
                            isLabelHidden
                            size='sm'
                            min={2}
                            max={32}
                            value={rampSteps}
                            onChange={setRampSteps}
                        />
                    </div>
                    <Button
                        label='make ramp'
                        size='sm'
                        variant='secondary'
                        clickAction={() => {
                            actions.addGradientRamp(rampName, anchor, current, rampSteps, false)
                        }}
                    />
                </HStack>

                <VStack gap={1}>
                    {doc.ramps.map(ramp => (
                        <HStack
                            key={ramp.name}
                            gap={2}
                            align='center'
                        >
                            <Text type='supporting'>{ramp.name}</Text>
                            <div
                                data-testid={`ramp-${ramp.name}`}
                                style={{display: 'flex', gap: 1}}
                            >
                                {ramp.indices.map(index => (
                                    <button
                                        key={index}
                                        type='button'
                                        title={`${String(index)} ${hex(index)}`}
                                        onClick={() => {
                                            setSettings(s => ({...s, color: index}))
                                        }}
                                        style={{
                                            ...swatch(hex(index), '1px solid #333'),
                                            width: 14,
                                            height: 14
                                        }}
                                    />
                                ))}
                            </div>
                            <Button
                                label='drop ramp'
                                size='sm'
                                variant='secondary'
                                clickAction={() => {
                                    actions.removeRamp(ramp.name)
                                }}
                            />
                        </HStack>
                    ))}
                </VStack>

                <HStack
                    gap={2}
                    align='center'
                >
                    <div style={{width: 90}}>
                        <NumberInput
                            label='tolerance'
                            isLabelHidden
                            size='sm'
                            min={0}
                            max={50}
                            value={tolerance}
                            onChange={setTolerance}
                        />
                    </div>
                    <Button
                        label='merge duplicates'
                        size='sm'
                        variant='secondary'
                        clickAction={() => {
                            actions.mergeDuplicates(tolerance)
                        }}
                    />
                    <Button
                        label='check contrast'
                        size='sm'
                        variant='secondary'
                        clickAction={check}
                    />
                </HStack>

                <Text type='supporting'>
                    <span data-testid='palette-report'>{report ?? 'contrast not checked'}</span>
                </Text>

                <HStack
                    gap={2}
                    align='center'
                >
                    <input
                        ref={input}
                        type='file'
                        data-testid='palette-input'
                        accept='.gpl,.hex,.pal,.png,image/png,text/plain'
                        style={{display: 'none'}}
                        onChange={event => {
                            void importPalette(event.target.files?.[0]).finally(() => {
                                event.target.value = ''
                            })
                        }}
                    />
                    <Button
                        label='import palette'
                        size='sm'
                        variant='secondary'
                        clickAction={() => {
                            input.current?.click()
                        }}
                    />
                    {FORMATS.map(format => (
                        <Button
                            key={format}
                            label={`.${format}`}
                            size='sm'
                            variant='secondary'
                            clickAction={() => {
                                download(
                                    `${doc.name}.${format}`,
                                    encodePalette(doc.palette, format, doc.name),
                                    'text/plain'
                                )
                            }}
                        />
                    ))}
                    <Button
                        label='strip .png'
                        size='sm'
                        variant='secondary'
                        clickAction={async () => {
                            download(
                                `${doc.name}-palette.png`,
                                await encodePng(toStrip(doc.palette, 8)),
                                'image/png'
                            )
                        }}
                    />
                </HStack>

                <Text type='supporting'>
                    <span data-testid='palette-note'>{note ?? 'no palette file loaded'}</span>
                </Text>
            </VStack>
        </div>
    )
}
