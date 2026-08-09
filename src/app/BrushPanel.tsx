import {IconButton} from '@astryxdesign/core/IconButton'
import {Switch} from '@astryxdesign/core/Switch'
import {Text} from '@astryxdesign/core/Text'
import type {Dispatch, ReactNode} from 'react'
import type {Files} from '../doc/files'
import {colorCss, projectPalette, SWATCH_COLUMNS, toHexPalette, type Swatch} from '../doc/palette'
import {
    CircleIcon,
    CubeIcon,
    DownloadIcon,
    EllipseIcon,
    FreeIcon,
    LineIcon,
    MinusIcon,
    PickIcon,
    PlusIcon,
    RectFillIcon,
    RectIcon,
    RingIcon,
    SquareIcon,
    UploadIcon
} from './icons'
import {SectionHead} from './SectionHead'
import {writePalette} from './download'
import {FIGURES, type Figure} from '../doc/figures'
import {
    MAX_BRUSH,
    SHAPES,
    USES_BRUSH,
    type AppAction,
    type AppState,
    type Brush,
    type Shape,
    type Tool
} from './state'

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

const FIGURE_ICONS: Record<Figure, ReactNode> = {
    free: <FreeIcon />,
    line: <LineIcon />,
    rect: <RectIcon />,
    rectFill: <RectFillIcon />,
    ellipse: <EllipseIcon />
}

const FIGURE_LABELS: Record<Figure, string> = {
    free: 'Freehand — the stroke follows the cursor',
    line: 'Line between the two ends of the drag',
    rect: 'Rectangle between the two ends of the drag',
    rectFill: 'Filled rectangle between the two ends of the drag',
    ellipse: 'Ellipse inscribed in the drag'
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
                title={
                    `${swatch.css}${swatch.isUsed ? ' — used by this model' : ''}`
                    + '\nShift-click: select every voxel of it'
                    + '\nAlt-click: replace the loaded colour with it'
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

/**
 * What the greyed-out brush row says for itself.
 *
 * Named after the tool that is armed rather than left as a generic "not available", because the
 * question the artist is actually asking is why *this* tool ignores it.
 */
const idleReason = (tool: Tool): string =>
    `${tool[0]?.toUpperCase() ?? ''}${tool.slice(1)} does not use the brush — only Draw and Erase do`

export const BrushPanel = ({
    state,
    dispatch,
    files,
    onLoad
}: {
    state: AppState
    dispatch: Dispatch<AppAction>
    /**
     * The disk the palette is written back to — see `doc/files.ts`.
     *
     * The port itself rather than a callback, unlike `onLoad`: a write has no picker and no cancel,
     * so there is nothing to come back and dispatch. It used to be an anchor this panel built for
     * itself, which is the one thing a panel must not do.
     */
    files: Files
    /**
     * Loading a palette off the disk — the one control in this panel that is not a dispatch.
     *
     * A callback rather than the port, because a read *can* be cancelled and what comes back is an
     * `AppAction` the app has to dispatch. See `app/session.ts`.
     */
    onLoad: () => void
}) => {
    const {volume, brush, color, recent, paletteLocked: isLocked, tool} = state
    const onBrush = (next: Partial<Brush>): void => {
        dispatch({type: 'brush', brush: next})
    }
    const onColor = (index: number): void => {
        dispatch({type: 'color', color: index})
    }
    const onReplace = (from: number, to: number): void => {
        dispatch({type: 'replace-color', from, to})
    }
    const onSelectColor = (index: number): void => {
        dispatch({type: 'select-color', color: index})
    }
    /*
     * Size, shape and figure belong to a stroke, and only Draw and Erase make one. Greyed rather
     * than hidden: a control that vanishes when a tool is armed reads as a bug, and the artist who
     * came here to widen the brush needs to be told the tool is the reason, not the panel.
     *
     * The palette below stays live for every tool on purpose. Shift-clicking a swatch selects every
     * voxel of that colour, alt-clicking replaces a colour across the model, and the entry editor,
     * the emissive switch and the lock all change the document rather than the next stroke — none of
     * which cares which tool is armed.
     */
    const idle = !USES_BRUSH.has(tool)
    const reason = idle ? idleReason(tool) : undefined

    return (
        <div className='panel'>
            <section className='section'>
                <SectionHead title='Brush' />
                <div className='section-body'>
                    <div
                        className='field-row'
                        title={reason}
                    >
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
                            tooltip={reason ?? 'Smaller brush'}
                            icon={<MinusIcon />}
                            size='sm'
                            variant='ghost'
                            isDisabled={idle || brush.size <= 1}
                            onClick={() => {
                                onBrush({size: brush.size - 1})
                            }}
                        />
                        <IconButton
                            label='Larger brush'
                            tooltip={reason ?? 'Larger brush'}
                            icon={<PlusIcon />}
                            size='sm'
                            variant='ghost'
                            isDisabled={idle || brush.size >= MAX_BRUSH}
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
                        aria-disabled={idle || undefined}
                    >
                        {SHAPES.map(shape => (
                            <button
                                key={shape}
                                type='button'
                                role='radio'
                                aria-checked={shape === brush.shape}
                                aria-disabled={idle || undefined}
                                aria-label={
                                    reason ?
                                        `${SHAPE_LABELS[shape]} — ${reason}`
                                    :   SHAPE_LABELS[shape]
                                }
                                title={reason ?? SHAPE_LABELS[shape]}
                                className='shape'
                                data-selected={shape === brush.shape || undefined}
                                onClick={() => {
                                    if (!idle) onBrush({shape})
                                }}
                            >
                                {SHAPE_ICONS[shape]}
                            </button>
                        ))}
                    </div>

                    {/*
                     * What a drag draws between its two ends — `FEATURESET.md` §5. Icons, matching the
                     * two rows above it: this is the third of three "which one" choices in one panel,
                     * and one of them spelling itself out in words made the column read as two unrelated
                     * halves. Each glyph is the shape it draws with its two endpoints marked, which is
                     * the actual distinction between them.
                     */}
                    <Text
                        type='supporting'
                        color='disabled'
                    >
                        Figure
                    </Text>
                    <div
                        className='shape-row'
                        role='radiogroup'
                        aria-label='Figure'
                        aria-disabled={idle || undefined}
                    >
                        {FIGURES.map(figure => (
                            <button
                                key={figure}
                                type='button'
                                role='radio'
                                aria-checked={figure === brush.figure}
                                aria-disabled={idle || undefined}
                                aria-label={
                                    reason ?
                                        `${FIGURE_LABELS[figure]} — ${reason}`
                                    :   FIGURE_LABELS[figure]
                                }
                                title={reason ?? FIGURE_LABELS[figure]}
                                className='shape'
                                data-selected={figure === brush.figure || undefined}
                                onClick={() => {
                                    if (!idle) onBrush({figure})
                                }}
                            >
                                {FIGURE_ICONS[figure]}
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
                        onClick={() => {
                            void writePalette(files, toHexPalette(volume.palette))
                        }}
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
                    <div
                        className='field-row grows'
                        title='Whether the loaded colour glows in the emission map'
                    >
                        <Switch
                            label='Emissive'
                            size='sm'
                            width='100%'
                            labelPosition='start'
                            labelSpacing='spread'
                            value={(volume.emissive[color] ?? 0) > 0}
                            onChange={on => {
                                dispatch({type: 'emissive', color, value: on ? 255 : 0})
                            }}
                        />
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
                                    title={`${colorCss(volume, index)} — used recently`}
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
                            onClick={() => {
                                dispatch({type: 'palette-add'})
                            }}
                        />
                        <IconButton
                            label='Pick a colour from the model'
                            tooltip='Pick a colour from the model'
                            icon={<PickIcon />}
                            size='sm'
                            variant='ghost'
                            onClick={() => {
                                dispatch({type: 'tool', tool: 'pick'})
                            }}
                        />
                        <span className='spacer' />
                        <span title='A locked palette still draws and fills; its entries stop changing'>
                            <Switch
                                label='Lock'
                                size='sm'
                                labelPosition='start'
                                value={isLocked}
                                onChange={on => {
                                    dispatch({type: 'palette-lock', on})
                                }}
                            />
                        </span>
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
                                dispatch({
                                    type: 'palette-color',
                                    color,
                                    css: event.target.value
                                })
                            }}
                        />
                    </div>
                </div>
            </section>
        </div>
    )
}
