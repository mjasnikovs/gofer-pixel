import {voxelIndex, type Volume} from '../render/volume'
import type {Cell, Selection} from './selection'

/**
 * Objects, not layers — `FEATURESET.md` §8 and §28.
 *
 * An object is a **named set of cells of the one world grid**, tracked by `Volume.owner`, rather
 * than a grid of its own at an offset. That choice is the whole of this file's design:
 *
 * - every tool, transform, selection and symmetry plane already written works in world coordinates
 *   and keeps working unchanged;
 * - the renderer never learns what an object is, so the CPU and GPU raycasters cannot start
 *   disagreeing about compositing;
 * - hide, lock and solo are lookups rather than passes.
 *
 * What it costs is that two objects cannot occupy one cell. A voxel grid holds one voxel per cell
 * anyway, so the thing being given up is overlap the format could not represent.
 *
 * The list is flat and stays flat. Parenting is `FEATURESET.md` §8's own postponed bullet.
 */
export interface VoxObject {
    /** 1-based, and the value written into `Volume.owner`. `0` means unowned. */
    readonly id: number
    readonly name: string
    readonly hidden: boolean
    readonly locked: boolean
}

export interface Objects {
    /** In draw order, which is the order the panel lists them. */
    readonly list: readonly VoxObject[]
    /** Which object new voxels join. */
    readonly active: number
    /** When set, only this object is shown, whatever the hidden flags say. */
    readonly solo: number | undefined
}

/** Room for 255 objects: `owner` is one byte a cell, and `0` is taken by "unowned". */
export const MAX_OBJECTS = 255

/**
 * A freshly opened `.vox` file is one object holding everything, because that is what it is: a
 * model. Splitting it is the artist's job and takes one click.
 */
export const initialObjects = (volume: Volume, name = 'Model'): Objects => {
    volume.owner.fill(0)
    for (let i = 0; i < volume.data.length; i += 1)
        if ((volume.data[i] ?? 0) !== 0) volume.owner[i] = 1
    return {list: [{id: 1, name, hidden: false, locked: false}], active: 1, solo: undefined}
}

export const objectAt = ({list}: Objects, id: number): VoxObject | undefined =>
    list.find(entry => entry.id === id)

export const isShown = (objects: Objects, id: number): boolean => {
    if (objects.solo !== undefined) return id === objects.solo
    return !(objectAt(objects, id)?.hidden ?? false)
}

/** The objects an edit may not touch: locked ones, and hidden ones, which cannot be aimed at. */
export const lockedIds = (objects: Objects): ReadonlySet<number> => {
    const locked = new Set<number>()
    for (const entry of objects.list) {
        if (entry.locked || !isShown(objects, entry.id)) locked.add(entry.id)
    }
    return locked
}

/**
 * The grid as it should be drawn: hidden objects' cells emptied.
 *
 * A separate volume rather than a flag the renderer checks, so that everything downstream — the
 * viewport, every thumbnail, the exported sheet, the picker — sees exactly one grid and agrees
 * about it. What the artist can see is what they can click, and what gets exported.
 *
 * Returns the volume itself when nothing is hidden, which is the usual case and costs nothing.
 */
export const shownVolume = (volume: Volume, objects: Objects): Volume => {
    const hidden = new Set<number>()
    for (const entry of objects.list) if (!isShown(objects, entry.id)) hidden.add(entry.id)
    if (hidden.size === 0) return volume

    const data = new Uint8Array(volume.data)
    for (let i = 0; i < data.length; i += 1) if (hidden.has(volume.owner[i] ?? 0)) data[i] = 0
    return {...volume, data}
}

/** Every cell one object owns. What Solo, Focus and "select this object" are all made of. */
export const objectCells = (volume: Volume, id: number): Selection => {
    const found = new Set<number>()
    for (let i = 0; i < volume.owner.length; i += 1) if (volume.owner[i] === id) found.add(i)
    return found
}

/** The box an object fills, for focusing the camera on it. `undefined` when it holds nothing. */
export const objectBounds = (
    volume: Volume,
    id: number
): {min: Cell; max: Cell; count: number} | undefined => {
    const {sx, sy, owner} = volume
    let count = 0
    let [x0, y0, z0] = [Infinity, Infinity, Infinity]
    let [x1, y1, z1] = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < owner.length; i += 1) {
        if (owner[i] !== id) continue
        count += 1
        const z = Math.floor(i / (sx * sy))
        const rest = i - z * sx * sy
        const x = rest % sx
        const y = Math.floor(rest / sx)
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        z0 = Math.min(z0, z)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
        z1 = Math.max(z1, z)
    }
    if (count === 0) return undefined
    return {min: [x0, y0, z0], max: [x1, y1, z1], count}
}

const nextId = ({list}: Objects): number => {
    for (let id = 1; id <= MAX_OBJECTS; id += 1) {
        if (!list.some(entry => entry.id === id)) return id
    }
    return 0
}

/** A new, empty object, made active so the next stroke goes into it. `undefined` when full. */
export const addObject = (objects: Objects, name?: string): Objects | undefined => {
    const id = nextId(objects)
    if (id === 0) return undefined
    const added: VoxObject = {
        id,
        name: name ?? `Object ${String(objects.list.length + 1)}`,
        hidden: false,
        locked: false
    }
    return {...objects, list: [...objects.list, added], active: id}
}

export const renameObject = (objects: Objects, id: number, name: string): Objects => ({
    ...objects,
    list: objects.list.map(entry => (entry.id === id ? {...entry, name} : entry))
})

export const setHidden = (objects: Objects, id: number, hidden: boolean): Objects => ({
    ...objects,
    // Hiding the soloed object is the artist saying they are done soloing.
    solo: objects.solo === id && hidden ? undefined : objects.solo,
    list: objects.list.map(entry => (entry.id === id ? {...entry, hidden} : entry))
})

export const setLocked = (objects: Objects, id: number, locked: boolean): Objects => ({
    ...objects,
    list: objects.list.map(entry => (entry.id === id ? {...entry, locked} : entry))
})

/** Solo is a toggle, and soloing something makes it active — it is the only thing left to draw on. */
export const soloObject = (objects: Objects, id: number): Objects =>
    objects.solo === id ? {...objects, solo: undefined} : {...objects, solo: id, active: id}

/**
 * Drop an object and everything it owns.
 *
 * The last object cannot go: a document with no object has nowhere to put the next voxel, and
 * "add one back" is a worse answer than "you cannot remove this one".
 */
export const canRemove = ({list}: Objects): boolean => list.length > 1

export const removeObject = (objects: Objects, id: number): Objects => {
    if (!canRemove(objects)) return objects
    const list = objects.list.filter(entry => entry.id !== id)
    const first = list[0]
    if (!first) return objects
    return {
        list,
        active: objects.active === id ? first.id : objects.active,
        solo: objects.solo === id ? undefined : objects.solo
    }
}

/** Reorder by drag: `FEATURESET.md` §28's flat-list answer to a hierarchy. */
export const moveObject = (objects: Objects, id: number, to: number): Objects => {
    const from = objects.list.findIndex(entry => entry.id === id)
    if (from < 0) return objects
    const list = [...objects.list]
    const [taken] = list.splice(from, 1)
    if (!taken) return objects
    list.splice(Math.max(0, Math.min(list.length, to)), 0, taken)
    return {...objects, list}
}

/** The panel's search box, over a list small enough that a filter is the whole feature. */
export const matching = ({list}: Objects, query: string): readonly VoxObject[] => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return list
    return list.filter(entry => entry.name.toLowerCase().includes(needle))
}

/** Which object owns the cell under a hit, for "modifier-click selects the whole object". */
export const ownerAt = (volume: Volume, x: number, y: number, z: number): number => {
    const {sx, sy, sz} = volume
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return 0
    return volume.owner[voxelIndex(volume, x, y, z)] ?? 0
}
