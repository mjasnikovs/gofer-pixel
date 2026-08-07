import {IconButton} from '@astryxdesign/core/IconButton'
import {Selector} from '@astryxdesign/core/Selector'
import {Text} from '@astryxdesign/core/Text'
import type {ReactNode} from 'react'
import {colorCss, projectPalette, SWATCH_COLUMNS, type Swatch} from '../doc/palette'
import type {Volume} from '../render/volume'
import {CircleIcon, CubeIcon, MinusIcon, PickIcon, PlusIcon, RingIcon, SquareIcon} from './icons'
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

const Swatches = ({
    swatches,
    color,
    onColor
}: {
    swatches: readonly Swatch[]
    color: number
    onColor: (index: number) => void
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
                aria-label={`Colour ${String(swatch.index)}${swatch.isUsed ? ', used by this model' : ''}`}
                className='swatch'
                data-selected={swatch.index === color || undefined}
                style={{background: swatch.css}}
                onClick={() => {
                    onColor(swatch.index)
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
    onColor
}: {
    volume: Volume
    brush: Brush
    color: number
    onBrush: (brush: Partial<Brush>) => void
    onColor: (index: number) => void
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
            <SectionHead title='Palette' />
            <div className='section-body'>
                <Swatches
                    swatches={projectPalette(volume)}
                    color={color}
                    onColor={onColor}
                />

                <div className='palette-actions'>
                    <IconButton
                        label='Add a colour to the palette'
                        tooltip='The palette comes from the .vox file — editing it needs an editable document'
                        icon={<PlusIcon />}
                        size='sm'
                        variant='ghost'
                        isDisabled
                    />
                    <IconButton
                        label='Pick a colour from the model'
                        tooltip='Pick a colour from the model'
                        icon={<PickIcon />}
                        size='sm'
                        variant='ghost'
                        isDisabled
                    />
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
            </div>
        </section>
    </div>
)
