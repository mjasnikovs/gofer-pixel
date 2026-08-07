import {IconButton} from '@astryxdesign/core/IconButton'
import {Selector} from '@astryxdesign/core/Selector'
import {Text} from '@astryxdesign/core/Text'
import type {ReactNode} from 'react'
import {colorCss, projectPalette, SWATCH_COLUMNS, type Swatch} from '../doc/palette'
import type {Volume} from '../render/volume'
import {
    CircleIcon,
    CubeIcon,
    DownloadIcon,
    MinusIcon,
    PickIcon,
    PlusIcon,
    RingIcon,
    SquareIcon,
    UploadIcon
} from './icons'
import {SectionHead} from './SectionHead'
import {FIGURES, type Figure} from '../doc/figures'
import {BRUSH_KINDS, MAX_BRUSH, SHAPES, type Brush, type Shape} from './state'

/**
 * The second column of `docs/editor.png`: what the brush is, and what colour is loaded into it.
 *
 * The palette is the model's own. A `.vox` file carries 255 colours whether the artist used them or
 * not, so `projectPalette` puts the ones this model is actually made of first — the top-left of the
 * grid is always the model, which is what a palette panel is for. Inventing a grid of pretty
 * swatches would have looked closer to the mockup and told the artist nothing.
 *
 * The brush, the figure and the loaded colour are what a stroke reads: the footprint is stamped on
 * every cell the figure covers, and the colour is what gets written into them.
 */
const SHAPE_ICONS: Record<Shape, ReactNode> = {
    square: <SquareIcon />,
    circle: <CircleIcon />,
    ring: <RingIcon />,
    cube: <CubeIcon />
}

const SHAPE_LABELS: Record<Shape, string> = {
    square: 'Square brush',
    circle: 'Round brush',
    ring: 'Hollow brush',
    cube: 'Cube brush'
}

const FIGURE_LABELS: Record<Figure, string> = {
    free: 'Free',
    line: 'Line',
    rect: 'Rect',
    ellipse: 'Ellipse'
}

const KIND_LABELS: Record<(typeof BRUSH_KINDS)[number], string> = {
    voxel: 'Voxel',
    face: 'Face',
    plane: 'Plane'
}

/**
 * The palette grid, and the two things a modified click on a swatch means.
 *
 * Shift takes every voxel of that colour — `FEATURESET.md` §7's "select all voxels of a color",
 * which has nowhere better to live than on the colour itself. Alt replaces the loaded colour with
 * it everywhere, which is §7's "replace color globally". Both are said out loud in the label,
 * because a modifier nobody can discover is not a feature.
 */
const Swatches = ({
    swatches,
    color,
    loaded,
    onColor,
    onReplace,
    onSelectColor
}: {
    swatches: readonly Swatch[]
    color: number
    loaded: number
    onColor: (index: number) => void
    onReplace: (from: number, to: number) => void
    onSelectColor: (index: number) => void
}) => (
    <div
        className='swatches'
        role='radiogroup'
        aria-label='Palette'
        style={{gridTemplateColumns: `repeat(${String(SWATCH_COLUMNS)}, minmax(0, 1fr))`}}
    >
        {swatches.map(swatch => (
            <button
                key={swatch.index}
                type='button'
                role='radio'
                aria-checked={swatch.index === color}
                // The index is the name a screen reader can act on; "used by this model" is the
                // fact the grid's ordering encodes, so it is said out loud rather than only shown.
                aria-label={
                    `Colour ${String(swatch.index)}`
                    + (swatch.isUsed ? ', used by this model' : '')
                    + '. Shift-click to select every voxel of it, alt-click to replace the loaded'
                    + ' colour with it.'
                }
                className='swatch'
                data-selected={swatch.index === color || undefined}
                style={{background: swatch.css}}
                onClick={event => {
                    if (event.shiftKey) onSelectColor(swatch.index)
                    else if (event.altKey) onReplace(loaded, swatch.index)
                    else onColor(swatch.index)
                }}
            />
        ))}
    </div>
)

export const BrushPanel = ({
    volume,
    brush,
    color,
    onBrush,
    onColor,
    onEmissive,
    recent,
    isLocked,
    onLock,
    onAdd,
    onEyedropper,
    onPaletteColor,
    onReplace,
    onSelectColor,
    onLoad,
    onSave
}: {
    volume: Volume
    brush: Brush
    color: number
    onBrush: (brush: Partial<Brush>) => void
    onColor: (index: number) => void
    onEmissive: (value: number) => void
    recent: readonly number[]
    isLocked: boolean
    onLock: (on: boolean) => void
    onAdd: () => void
    onEyedropper: () => void
    onPaletteColor: (css: string) => void
    onReplace: (from: number, to: number) => void
    onSelectColor: (index: number) => void
    onLoad: () => void
    onSave: () => void
}) => (
    <div className='panel'>
        <section className='section'>
            <SectionHead title='Brush' />
            <div className='section-body'>
                <Selector
                    label='Brush kind'
                    isLabelHidden
                    size='sm'
                    value={brush.kind}
                    options={BRUSH_KINDS.map(kind => ({value: kind, label: KIND_LABELS[kind]}))}
                    onChange={value => {
                        const kind = BRUSH_KINDS.find(entry => entry === value)
                        if (kind) onBrush({kind})
                    }}
                />

                <div className='field-row'>
                    <Text
                        type='supporting'
                        color='disabled'
                    >
                        Size
                    </Text>
                    <span className='spacer' />
                    <output className='stepper-value'>
                        <Text
                            type='supporting'
                            hasTabularNumbers
                        >
                            {brush.size}
                        </Text>
                    </output>
                    <IconButton
                        label='Smaller brush'
                        tooltip='Smaller brush'
                        icon={<MinusIcon />}
                        size='sm'
                        variant='ghost'
                        isDisabled={brush.size <= 1}
                        onClick={() => {
                            onBrush({size: brush.size - 1})
                        }}
                    />
                    <IconButton
                        label='Larger brush'
                        tooltip='Larger brush'
                        icon={<PlusIcon />}
                        size='sm'
                        variant='ghost'
                        isDisabled={brush.size >= MAX_BRUSH}
                        onClick={() => {
                            onBrush({size: brush.size + 1})
                        }}
                    />
                </div>

                <Text
                    type='supporting'
                    color='disabled'
                >
                    Shape
                </Text>
                <div
                    className='shape-row'
                    role='radiogroup'
                    aria-label='Brush shape'
                >
                    {SHAPES.map(shape => (
                        <button
                            key={shape}
                            type='button'
                            role='radio'
                            aria-checked={shape === brush.shape}
                            aria-label={SHAPE_LABELS[shape]}
                            className='shape'
                            data-selected={shape === brush.shape || undefined}
                            onClick={() => {
                                onBrush({shape})
                            }}
                        >
                            {SHAPE_ICONS[shape]}
                        </button>
                    ))}
                </div>

                {/*
                 * What a drag draws between its two ends — `FEATURESET.md` §5. Words rather than
                 * icons: a line, a rectangle and an ellipse have no icon that beats their own name
                 * at this size, and the Shape row above already spends the icons it has.
                 */}
                <Text
                    type='supporting'
                    color='disabled'
                >
                    Figure
                </Text>
                <div
                    className='figure-row'
                    role='radiogroup'
                    aria-label='Figure'
                >
                    {FIGURES.map(figure => (
                        <button
                            key={figure}
                            type='button'
                            role='radio'
                            aria-checked={figure === brush.figure}
                            aria-label={FIGURE_LABELS[figure]}
                            className='figure'
                            data-selected={figure === brush.figure || undefined}
                            onClick={() => {
                                onBrush({figure})
                            }}
                        >
                            {FIGURE_LABELS[figure]}
                        </button>
                    ))}
                </div>
            </div>
        </section>

        <section className='section section-grows'>
            <SectionHead title='Palette'>
                <IconButton
                    label='Load a palette'
                    tooltip={isLocked ? 'The palette is locked' : 'Load a .hex palette'}
                    icon={<UploadIcon />}
                    size='sm'
                    variant='ghost'
                    isDisabled={isLocked}
                    onClick={onLoad}
                />
                <IconButton
                    label='Save the palette'
                    tooltip='Save this palette as a .hex file'
                    icon={<DownloadIcon />}
                    size='sm'
                    variant='ghost'
                    onClick={onSave}
                />
            </SectionHead>
            <div className='section-body'>
                <Swatches
                    swatches={projectPalette(volume)}
                    color={color}
                    onColor={onColor}
                    onReplace={onReplace}
                    onSelectColor={onSelectColor}
                    loaded={color}
                />

                {/*
                 * Whether the loaded colour glows — the one material property this editor has, and
                 * it exists because `FEATURESET.md` §18 promises an emission map. On or off rather
                 * than a strength slider: a strength is a lighting decision, and the engine on the
                 * other end of the map is the thing making those.
                 */}
                <div className='field-row'>
                    <Text
                        type='supporting'
                        color='disabled'
                    >
                        Emissive
                    </Text>
                    <span className='spacer' />
                    <button
                        type='button'
                        role='switch'
                        aria-checked={(volume.emissive[color] ?? 0) > 0}
                        aria-label='This colour glows'
                        className='symmetry-axis'
                        data-on={(volume.emissive[color] ?? 0) > 0 || undefined}
                        onClick={() => {
                            onEmissive((volume.emissive[color] ?? 0) > 0 ? 0 : 255)
                        }}
                    >
                        {(volume.emissive[color] ?? 0) > 0 ? 'ON' : 'OFF'}
                    </button>
                </div>

                {/*
                 * The last eight colours loaded, most recent first — `FEATURESET.md` §7. It is
                 * one row of the swatch grid on purpose: a recent list long enough to need
                 * scanning is the palette again.
                 */}
                {recent.length > 1 ?
                    <div
                        className='swatches recent-swatches'
                        role='radiogroup'
                        aria-label='Recent colours'
                        style={{
                            gridTemplateColumns: `repeat(${String(SWATCH_COLUMNS)}, minmax(0, 1fr))`
                        }}
                    >
                        {recent.map(index => (
                            <button
                                key={index}
                                type='button'
                                role='radio'
                                aria-checked={index === color}
                                aria-label={`Recent colour ${String(index)}`}
                                className='swatch'
                                data-selected={index === color || undefined}
                                style={{background: colorCss(volume, index)}}
                                onClick={() => {
                                    onColor(index)
                                }}
                            />
                        ))}
                    </div>
                :   undefined}

                <div className='palette-actions'>
                    <IconButton
                        label='Add a colour to the palette'
                        tooltip={
                            isLocked ? 'The palette is locked' : (
                                'Load the first unused palette slot, ready to be given a colour'
                            )
                        }
                        icon={<PlusIcon />}
                        size='sm'
                        variant='ghost'
                        isDisabled={isLocked}
                        onClick={onAdd}
                    />
                    <IconButton
                        label='Pick a colour from the model'
                        tooltip='Pick a colour from the model'
                        icon={<PickIcon />}
                        size='sm'
                        variant='ghost'
                        onClick={onEyedropper}
                    />
                    <span className='spacer' />
                    <button
                        type='button'
                        role='switch'
                        aria-checked={isLocked}
                        aria-label='Lock the palette'
                        className='symmetry-axis'
                        data-on={isLocked || undefined}
                        onClick={() => {
                            onLock(!isLocked)
                        }}
                    >
                        {isLocked ? 'LOCKED' : 'OPEN'}
                    </button>
                </div>

                {/*
                 * The mockup's saturation field and hue strip, showing the loaded colour rather
                 * than offering a new one: a free colour picker in an indexed-palette editor is a
                 * way to make a voxel that no palette entry can name. It is a readout, and it is
                 * marked as one.
                 */}
                <div
                    className='color-field'
                    style={{['--swatch' as string]: colorCss(volume, color)}}
                    role='img'
                    aria-label={`Loaded colour ${colorCss(volume, color)}`}
                >
                    <span className='color-hue' />
                </div>

                {/*
                 * The one place a palette entry can be given a new colour. A native colour input
                 * rather than a hand-rolled wheel: the platform's picker is the one the artist's
                 * eyedropper, their recent colours and their screen profile already know about,
                 * and the field above stays the readout it was.
                 */}
                <div className='field-row'>
                    <Text
                        type='supporting'
                        color='disabled'
                    >
                        Entry {color}
                    </Text>
                    <span className='spacer' />
                    <input
                        type='color'
                        className='color-input'
                        aria-label={`Colour of palette entry ${String(color)}`}
                        disabled={isLocked}
                        value={colorCss(volume, color)}
                        onChange={event => {
                            onPaletteColor(event.target.value)
                        }}
                    />
                </div>
            </div>
        </section>
    </div>
)
