import {initialObjects, type Objects} from './objects'
import {createVolume, type Volume} from '../render/volume'
import {magicaPalette} from '../vox/vox-file'

/**
 * What a new project starts as — `FEATURESET.md` §36's templates, without §36's project browser.
 *
 * §36 names five and is postponed as a *browser*; the templates are the half of it worth having
 * now, because the alternative to a named size is an empty box the artist has to guess at. They
 * are sizes and nothing else: a template that pre-placed voxels would be a stamp library, which is
 * §35 and also postponed.
 *
 * Z is up — see `render/camera.ts`, where `up` is `(0, 0, 1)` at zero pitch — so a character is
 * tall in z and a tile is flat in it.
 */
export interface Template {
    readonly name: string
    /** `x`, `y`, `z`, in voxels. */
    readonly size: readonly [number, number, number]
}

export const TEMPLATES: readonly Template[] = [
    {name: 'Character', size: [16, 16, 24]},
    {name: 'Character (large)', size: [32, 32, 48]},
    {name: 'Isometric tile', size: [32, 32, 16]},
    {name: 'Prop', size: [32, 32, 32]},
    {name: 'Diorama', size: [64, 64, 64]}
]

/**
 * The largest grid a document may have, per axis.
 *
 * 256 is MagicaVoxel's own ceiling, which matters because `.vox` is the format artists arrive
 * with. It is also close to where this renderer stops being interactive: a 256³ grid is 16 million
 * cells and 32 MB across `data` and `owner`, against 2 million and 4 MB at 128³.
 */
export const MAX_AXIS = 256

export const DEFAULT_TEMPLATE = 'Prop'
export const DEFAULT_NAME = 'untitled'

/** Every axis an integer in `1 … MAX_AXIS`. What the custom fields are clamped by. */
export const clampAxis = (value: number): number =>
    Math.max(1, Math.min(MAX_AXIS, Math.round(Number.isFinite(value) ? value : 1)))

/**
 * An empty grid on a palette worth painting from.
 *
 * `magicaPalette` rather than 256 black entries, because `initialState` freshens the palette from
 * the colours a document *uses*, and a new document uses none — so without a ramp here the artist's
 * first click has nothing but black to draw with.
 */
export const newDocument = (
    size: readonly [number, number, number]
): {volume: Volume; objects: Objects} => {
    const [sx, sy, sz] = size
    const volume = createVolume(clampAxis(sx), clampAxis(sy), clampAxis(sz), magicaPalette())
    return {volume, objects: initialObjects(volume)}
}

export const templateNamed = (name: string): Template =>
    TEMPLATES.find(entry => entry.name === name)
    ?? TEMPLATES.find(entry => entry.name === DEFAULT_TEMPLATE) ?? {name, size: [32, 32, 32]}
