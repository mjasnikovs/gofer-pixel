import {faceAxis, type Axis, type Brush, type Offset} from './brush'
import {
    beginEdit,
    commitEdit,
    connected,
    fillRegion,
    strokeCells,
    writeCells,
    type Draft
} from './edits'
import {figureCells} from './figures'
import {record, type History} from './history'
import {lockedIds, objectCells, ownerAt, shownVolume, type Objects} from './objects'
import {remember} from './palette'
import {
    cellOf,
    EMPTY_SELECTION,
    facePatch,
    selectConnectedColor,
    selectObject,
    selectRect,
    selectionBounds,
    selectVoxel,
    type Cell,
    type Selection
} from './selection'
import {slicedVolume} from './slice'
import {symmetryMaps, type Symmetry} from './symmetry'
import {duplicateCells, extrudeCells, lossCount, moveCells, rotateCells} from './transform'
import {basisFor, type Basis, type Camera} from '../render/camera'
import {FACE_STEP} from '../render/faces'
import {pick, pickPlane, pickRay} from '../render/pick'
import {voxelIndex, type Volume} from '../render/volume'
import type {OrbitState, ViewportPointer} from '../viewport/orbit'

/**
 * What the pointer does to voxels: aiming, drawing, selecting, dragging, and the outline that says
 * what the next click would do before it happens.
 *
 * All of it used to live in `app/state.ts`, taking and returning the whole `AppState` — fifty
 * fields, of which these functions read eighteen and write ten. That interface was already written
 * down twice by hand, as `AimKey` and as a list called `AIMED_AT`, each with a comment saying that
 * a missing entry leaves the artist an outline that quietly lies. `Gesture` below is that list,
 * once, as a type; `changedAim` is the comparison; and `changed` is the only way anything here
 * writes, so what a gesture touches is visible at every return.
 *
 * The rule the whole file exists to keep: **the outline cannot disagree with the edit.** Every
 * branch of `hoverAt` is a branch of `beginStroke` or `beginSelect`, deliberately, and the
 * region a hover shows comes out of the same call the press makes.
 */

/**
 * The slice of the document a pointer gesture reads and writes.
 *
 * `AppState` satisfies it structurally, so the reducer passes itself and gets its own type back —
 * see `changed`. Nothing here can reach a camera list, an export preset or the undo *menu*, which
 * is the point: those are not things a click on the model may quietly alter.
 */
export interface Gesture {
    readonly volume: Volume
    /** The flat list of named objects over the one grid — see `objects.ts`. */
    readonly objects: Objects
    /** Which voxels the next transform will move — see `selection.ts`. */
    readonly selection: Selection
    readonly orbit: OrbitState
    readonly tool: Tool
    readonly brush: Brush
    /** 1-based index into `volume.palette`, the `.vox` format's own convention. */
    readonly color: number
    /** The last few colours loaded, most recent first — `FEATURESET.md` §7. */
    readonly recent: readonly number[]
    /**
     * Lock drawing to one plane of the grid rather than to the face under the cursor
     * (`FEATURESET.md` §5). `undefined` is the default: the face you click is the canvas.
     */
    readonly plane: Axis | undefined
    /**
     * Which layer slice mode is showing, or `undefined` when it is off — `FEATURESET.md` §6.
     *
     * The axis is the plane lock's; slice mode without a plane is a slice of nothing in particular,
     * so switching it on locks the XY plane if nothing is locked yet.
     */
    readonly slice: number | undefined
    /** Draw-time mirroring. Writes real voxels as the stroke happens — see `symmetry.ts`. */
    readonly symmetry: Symmetry
    /** Diffs, not volumes — see `history.ts`. */
    readonly history: History
    /** Non-`undefined` for exactly as long as the pointer is down on a writing tool. */
    readonly stroke: Stroke | undefined
    /** Non-`undefined` while voxels are being dragged — moved, cloned or pulled. */
    readonly drag: Drag | undefined
    /** Non-`undefined` while a rubber band is being dragged over the picture. */
    readonly band: Band | undefined
    /**
     * How many voxels the drag, as it stands right now, would destroy if it were dropped.
     *
     * Zero when nothing is being dragged. Move and clone overwrite, which is right — refusing would
     * mean never sliding a voxel one step along a surface — but it is the one loss undo cannot make
     * obvious afterwards, because a drop onto air looks exactly like a drop that ate three voxels.
     * Kept on the state rather than worked out by the bar, so the number the artist reads is the
     * number the reducer is about to act on.
     */
    readonly losing: number
    /**
     * The last place the pointer was seen over the viewport, and nothing else. `undefined` once it
     * has left. Kept because `hover` is a function of it *and* of the tool, the brush, the colour
     * and the model — all of which change without the mouse moving.
     */
    readonly aim: ViewportPointer | undefined
    /** Where the next click would go. `undefined` while a gesture owns the pointer, or off the model. */
    readonly hover: Hover | undefined
}

/**
 * The one way anything here writes.
 *
 * Generic in the caller's own state, so the reducer hands over its whole `AppState` and gets its
 * own type back with every field this module cannot see still on it. `Partial<Gesture>` is what
 * stops a gesture writing a field that is not one of the ten it is allowed to.
 */
const changed = <S extends Gesture>(state: S, next: Partial<Gesture>): S => ({...state, ...next})

/** The nine tools down the left rail of `docs/editor.png`, in the order the mockup lists them. */
export const TOOLS = [
    'draw',
    'erase',
    'fill',
    'pick',
    'move',
    'rotate',
    'scale',
    'clone',
    'measure'
] as const
export type Tool = (typeof TOOLS)[number]

/**
 * The tools that take the left button in the viewport. The rest still orbit with it, because a tool
 * that has not been built yet must not silently swallow the gesture that moves the camera.
 */
export const WRITES: ReadonlySet<Tool> = new Set<Tool>(['draw', 'erase', 'fill', 'pick'])

/**
 * The tools that work on a selection. Move is where selecting happens, because a selection with no
 * tool that consumes it is a highlight — `docs/editor.png` has no separate select tool, and
 * `FEATURESET.md` §39 is explicit that the rail should not grow one.
 */
export const SELECTS: ReadonlySet<Tool> = new Set<Tool>(['move', 'rotate', 'scale', 'clone'])

/**
 * The tools that read the brush — its size, its shape and its figure.
 *
 * Only the two that stamp a footprint. Fill floods a region, Pick samples one voxel, and the four
 * grab tools work on a selection; none of them consults the brush, so the panel greys those three
 * controls out rather than letting the artist set a size that quietly does nothing. Exported so the
 * panel and the stroke below cannot drift apart about which tools those are.
 */
export const USES_BRUSH: ReadonlySet<Tool> = new Set<Tool>(['draw', 'erase'])

/**
 * Every tool that does something with the left button, and therefore every tool that owes the artist
 * a picture of what that something is before they commit to it.
 *
 * Measure is the only one missing, because it is not built: arming it leaves the button to the
 * camera, and previewing a gesture that does not exist would be the worst lie of the lot.
 */
const AIMS: ReadonlySet<Tool> = new Set<Tool>([...WRITES, ...SELECTS])

/**
 * How many cells the overlay will draw one cube each for, before it gives up and draws the box.
 *
 * Measured, in `bun test` under happy-dom, by rendering `BrushGhost` at sizes from 64 to 14 000
 * cells: the cost is linear at 10 µs a cell from 500 cells up, so 512 is about 5 ms — one pointer
 * move's worth, and the number stays honest on the slow side of the 14× spread `CLAUDE.md` records
 * for a busy GPU.
 *
 * 512 is also exactly the largest brush there is, a `MAX_BRUSH` cube, so the brush panel on its own
 * can never push the ghost over. What does push it over is a flood fill, a whole object, or that
 * same cube under eight-way symmetry — answers that are a region rather than a footprint, and that
 * read better as a box than as four thousand wireframed cubes would.
 */
export const GHOST_CELLS = 512

/**
 * A drag that is moving voxels rather than choosing them.
 *
 * Replayed from its start on every pointer move, never accumulated — the same pattern as
 * `viewport/orbit.ts`, and for the same three reasons: the gesture is reproducible from its start
 * plus a position, a test can jump straight to the end of a drag, and a dropped move event cannot
 * leave the model somewhere the mouse is not. Accumulating would also mean a drag that wanders
 * back and forth grinds the model up, because each step would move whatever it happened to hit.
 *
 * The cost is one grid copy per pointer move. On a 128³ document that is 2 MB of memcpy at mouse
 * rate, which is far cheaper than the alternative being wrong.
 */
export interface Drag {
    readonly kind: 'move' | 'clone' | 'extrude' | 'turn'
    /** The document and the selection as they were when the pointer went down. */
    readonly volume: Volume
    readonly selection: Selection
    /** The cell under the cursor at the start, on the plane of the face that was grabbed. */
    readonly from: Cell
    readonly axis: number
    readonly layer: number
    readonly face: number
    /**
     * Pointer position at the start, for the two drags that measure the hand rather than the grid:
     * the extrude, which projects onto the normal, and the turn, which counts sideways pixels.
     */
    readonly x: number
    readonly y: number
}

/** A rubber band while the pointer is down, in the viewport's own pixels. */
export interface Band {
    readonly x0: number
    readonly y0: number
    readonly x1: number
    readonly y1: number
    readonly width: number
    readonly height: number
}

/**
 * A stroke in progress: one draft, and the layer it is pinned to.
 *
 * The layer is decided by the first click and never re-picked, which is what stops a drag climbing
 * towards the camera over the voxels it is laying down. See `pickPlane`.
 */
export interface Stroke {
    readonly draft: Draft
    /**
     * The document the stroke opened on. A figure is redrawn from here on every move — a rectangle
     * that grew by appending would leave every intermediate rectangle behind it.
     */
    readonly base: Volume
    /** Where the pointer went down. One end of the figure; the cursor is the other. */
    readonly origin: Cell
    /** `0` = x, `1` = y, `2` = z — the axis the drawing plane is perpendicular to. */
    readonly axis: Axis
    readonly layer: number
    /** The face the first click struck, which is what orients a flat brush. */
    readonly face: number
    readonly value: number
    readonly at: Cell
    /**
     * The figure's cells on the base plane, as of the last move with Shift up — what an extrude
     * repeats along the normal.
     *
     * Held separately from the draft because the draft is bytes and an extrude needs the shape
     * back. It is also why the flat part of a stroke holds still while Shift is down: the drag has
     * stopped feeding this and started feeding `depth`.
     */
    readonly spots: readonly Cell[]
    /** How far out the extrude has reached, as a layer along `axis`. Equal to `layer` when flat. */
    readonly depth: number
}

/**
 * What kind of change the press would be, which is what the overlay draws it as.
 *
 * The kind rather than the tool, because eight tools make five kinds of promise and the overlay
 * should be answering "what is about to happen here" rather than "which button is lit". Two tools
 * that do the same thing to the voxels — Move and Rotate both pick a selection up — have no
 * business looking different before the press.
 */
export type HoverKind =
    /** Voxels appear, in the loaded colour. Draw. */
    | 'write'
    /** Voxels go. Erase. */
    | 'clear'
    /** Voxels that are already there change colour. Fill. */
    | 'recolour'
    /** Nothing changes in the grid; a colour comes back out of it. Pick. */
    | 'sample'
    /** Nothing changes yet; these are the voxels the gesture takes hold of. Move, Rotate, Scale, Clone. */
    | 'grab'

/**
 * Where the next click would land, computed on every pointer move that is not already a gesture.
 *
 * It is not a hint and not an approximation: every tool's answer comes out of the same function the
 * press itself uses — `strokeCells` and the symmetry maps for Draw and Erase, `connected` for Fill,
 * `pressSelection` for the four that take hold of voxels — so the outline on screen cannot disagree
 * with the edit it is previewing. Without it the artist aims a one-voxel brush at a 3-pixel voxel
 * and finds out where it went afterwards — and finds out nothing at all when the answer is
 * `blocked`.
 */
export interface Hover {
    /** The cell the click would write into: in front of the face for Draw, the voxel for the rest. */
    readonly cell: Cell
    /** What the press would do to the voxels below, which is what the overlay draws. */
    readonly kind: HoverKind
    /** The face the ray struck, which is what a flat brush lies in. */
    readonly face: number
    /**
     * The grid plane the outline is drawn on, along the face's own axis.
     *
     * Decided here rather than in the overlay, because it is not the same side of the cell for every
     * tool: Draw aims at the empty cell in front of the surface and wants the near side of it, Erase
     * and Paint aim at the voxel itself and want its outer side. Both are the *struck face* — one
     * plane, arrived at from the two directions the tools approach it from.
     */
    readonly surface: number
    /**
     * Every cell the press acts on, mirrors included, as triples — which is what the overlay draws
     * one cube per. May be empty because all of them are off-grid, and may be empty because there
     * are more than `GHOST_CELLS` of them; `region` and `bounds` are the answer in that case.
     *
     * Triples rather than the flat indices `region` uses, because a brush hanging over the edge of
     * the grid has cells at negative coordinates and no index can hold one. That overhang is
     * exactly what `blocked` is reporting, so it has to survive as far as the screen.
     */
    readonly cells: readonly Offset[]
    /**
     * The same answer as flat cell indices, for the tools whose answer has no size limit: a fill can
     * be the whole grid and a grab can be a whole object. Undefined for Draw, Erase and Pick, whose
     * footprint is the brush and is never larger than `MAX_BRUSH` cubed.
     *
     * Indices rather than triples so a two-million-cell region costs one integer each instead of one
     * array each, and so `previewVolume` can write it straight into the grid.
     */
    readonly region: Selection | undefined
    /** The integer box the whole answer occupies, so a footprint too big to draw still says where it is. */
    readonly bounds: {min: Cell; max: Cell} | undefined
    /**
     * The palette index the proposal should be drawn in, or `undefined` for the kinds that put no
     * paint anywhere. Draw and Fill propose the loaded colour; Pick proposes the colour it would
     * take *out* of the model, which is not the loaded one and must not be drawn as though it were.
     */
    readonly paint: number | undefined
    /**
     * Why the press would change nothing, or `undefined` when it would. A press there is silent, so
     * the outline has to say it — and say *which* silence — before the press rather than after.
     */
    readonly blocked: Blocked | undefined
}

/**
 * Why a press is about to do nothing.
 *
 * One boolean used to carry all of these, and one boolean is what made a locked object read as a
 * broken tool: the ghost went dashed for "locked", for "already that colour" and for "off the edge
 * of the grid" alike, so the one case the artist can actually fix looked like the two they cannot.
 *
 * - **`locked`** — a locked object owns the cells. `object` names it, so the message can too.
 * - **`outside`** — the whole footprint is off the grid.
 * - **`nothing`** — the cells already hold exactly what the press would write. For Erase that is
 *   empty space; for Draw and Fill it is the loaded colour; for a grab it is nothing to take hold of.
 */
export interface Blocked {
    readonly reason: 'locked' | 'outside' | 'nothing'
    /** The locked object standing in the way, when that is the reason. */
    readonly object: number | undefined
}

/** The two reasons that name nothing. Shared rather than rebuilt, so a hover allocates less. */
const NOTHING: Blocked = {reason: 'nothing', object: undefined}
const OUTSIDE: Blocked = {reason: 'outside', object: undefined}

/**
 * The volume as it now stands mid-stroke: a fresh identity over the draft's own buffer.
 *
 * React and the GL uploader both watch identity, and the draft's buffer is mutated in place, so
 * without the new wrapper a stroke would be invisible until the pointer came up. Copying the bytes
 * instead would be a megabyte a mouse-move on a large model, for a copy nothing reads.
 */
const live = (draft: Draft): Volume => ({...draft.volume})

/**
 * The second half of `visible`: the layers in front of the slice taken away — `FEATURESET.md` §6.
 *
 * Split out from it, and this is the only reason: the app has to memoise the two halves against
 * different things. Hiding an object rebuilds a grid, so `shownVolume` must not re-run while the
 * view turns; slicing depends on which way the camera faces, so it must. Composing them here
 * rather than in `App.tsx` is what stops the picture on screen being derived from a *different*
 * rule than the pointer and the bake — which is what it was, and in slice mode the model on screen
 * was whole while the click landed on a model with everything in front of the layer removed.
 *
 * Returns `shown` itself when slice mode is off, which is the usual case and is what makes it
 * cheap enough to sit inside a memo that the camera invalidates.
 */
export const slicedFor = (state: Gesture, shown: Volume): Volume => {
    if (state.slice === undefined) return shown
    const axis = state.plane ?? 2
    const {forward} = basisFor(state.orbit.camera, state.volume, 1)
    return slicedVolume(shown, {axis, layer: state.slice}, forward)
}

/**
 * The grid as the artist sees it: hidden objects emptied out of it, and in slice mode the layers in
 * front of the current one as well.
 *
 * Everything that renders, picks or exports goes through here or through `slicedFor`, so what is on
 * screen is what can be clicked and what gets written. It returns the volume itself when nothing is
 * hidden and nothing is sliced, which is the usual case and the reason this is cheap enough to call
 * per pointer event.
 */
export const visible = (state: Gesture): Volume =>
    slicedFor(state, shownVolume(state.volume, state.objects))

/** A draft that knows which object new voxels join and which objects refuse to be touched. */
export const openDraft = (state: Gesture, volume: Volume = state.volume): Draft =>
    beginEdit(volume, state.objects.active, lockedIds(state.objects))

/**
 * Every cell of a stroke, plus every image of every cell.
 *
 * Cells, not stamp centres. An even-sized brush grows towards `+`, so it is not its own mirror
 * image and reflecting where it was stamped leaves the reflection one voxel over — a seam down the
 * middle of the model. Reflecting the cells themselves is exact for every brush and for the radial
 * quarter turn as well, which swaps the x and y axes a flat footprint lies in.
 */
export const mirrored = (state: Gesture, cells: readonly Offset[]): readonly Offset[] => {
    const maps = symmetryMaps(state.volume, state.symmetry)
    if (maps.length === 1) return cells
    return maps.flatMap(map => cells.map(map))
}

/**
 * Why writing `value` here would be dropped, or `undefined` when it would land. The ways a write is
 * silently dropped, asked in one place — see `writeOwned`, which is where they are actually enforced.
 *
 * Out of bounds, owned by a locked object, or already exactly what is being written. A tool whose
 * click does nothing is not a bug on its own; a tool that gives no sign of it beforehand is.
 */
const writeBlock = (
    state: Gesture,
    locked: ReadonlySet<number>,
    [x, y, z]: Offset,
    value: number
): Blocked | undefined => {
    const {sx, sy, sz, data, owner} = state.volume
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return OUTSIDE
    const index = voxelIndex(state.volume, x, y, z)
    const wasOwner = owner[index] ?? 0
    if (locked.has(wasOwner)) return {reason: 'locked', object: wasOwner}
    const nowOwner = value === 0 ? 0 : state.objects.active
    if ((data[index] ?? 0) !== value || wasOwner !== nowOwner) return undefined
    return NOTHING
}

/**
 * How informative each reason is, when a footprint straddles more than one of them.
 *
 * `locked` wins outright, because it is the only one of the three the artist can do something about
 * — a brush half off the grid and half over a locked object is, to the hand holding it, a locked
 * object. Between the other two, "these cells are already like that" says more than "they are not
 * on the grid", which the outline is already showing by hanging over the edge.
 */
const RANK: Record<Blocked['reason'], number> = {outside: 0, nothing: 1, locked: 2}

/**
 * The one reason to report for a whole footprint, or `undefined` as soon as any cell would write.
 *
 * A single blocked cell is not a blocked press: a brush that overlaps a locked object with one
 * corner still writes with the other three, and saying otherwise would cry wolf on every stroke
 * along a locked edge.
 */
const blockedBy = (
    state: Gesture,
    locked: ReadonlySet<number>,
    cells: Iterable<Offset>,
    value: number
): Blocked | undefined => {
    let worst: Blocked | undefined
    for (const cell of cells) {
        const block = writeBlock(state, locked, cell, value)
        if (!block) return undefined
        if (!worst || RANK[block.reason] > RANK[worst.reason]) worst = block
    }
    // No cells at all is a press with nothing to do, which is the same silence by another route.
    return worst ?? NOTHING
}

/**
 * The reason a grab is silent. A grab writes no value of its own, so `blockedBy` cannot answer it:
 * the question is whether the *transform* that follows would be allowed to move these cells.
 */
const blockedGrab = (
    state: Gesture,
    locked: ReadonlySet<number>,
    region: Selection
): Blocked | undefined => {
    if (region.size === 0) return NOTHING
    if (locked.size === 0) return undefined
    let held: number | undefined
    for (const index of region) {
        const id = state.volume.owner[index] ?? 0
        if (!locked.has(id)) return undefined
        held ??= id
    }
    return {reason: 'locked', object: held}
}

/** A region's cells, one at a time, so a two-million-cell answer costs one triple rather than two million. */
function* regionCells(volume: Volume, region: Selection): Generator<Cell> {
    for (const index of region) yield cellOf(volume, index)
}

/**
 * The grid the *viewport* draws, which is not always the grid the document holds.
 *
 * Two of the five hover kinds change voxels that are already there, and a change to a voxel that is
 * already there cannot be shown by drawing a block over it — the block would be covering the very
 * pixels whose change is the point. So those two are rendered: the grid handed to the viewport is
 * the document with the proposal already applied.
 *
 * - **`clear`.** Erasing into a solid, evenly coloured block is otherwise invisible: measured on
 *   `car.vox`, up to 18 of 41 erases left the clicked pixel byte for byte identical, the voxel
 *   exposed behind carrying the same palette entry and the same face.
 * - **`recolour`.** A fill's whole answer is *which* voxels change, and that answer is a region the
 *   artist has no other way to see. An outline round two thousand cells says where; only the paint
 *   says what.
 *
 * It costs a grid copy per pointer move, which is the same bill a stroke already pays.
 *
 * `write` is deliberately not here. Draw's new voxels sit in empty space, where the translucent
 * block in `BrushGhost` already reads correctly, and painting them into the render would make a
 * proposal look like a fact. `sample` and `grab` change no voxels at all.
 */
export const previewVolume = (state: Gesture, shown: Volume): Volume => {
    const {hover} = state
    if (!hover || hover.blocked) return shown
    if (hover.kind === 'clear') {
        const data = new Uint8Array(shown.data)
        for (const [x, y, z] of hover.cells) {
            if (x < 0 || y < 0 || z < 0) continue
            if (x >= shown.sx || y >= shown.sy || z >= shown.sz) continue
            data[voxelIndex(shown, x, y, z)] = 0
        }
        return {...shown, data}
    }
    if (hover.kind === 'recolour' && hover.region) {
        const data = new Uint8Array(shown.data)
        /*
         * Indices, straight in — the region was flooded over the document, which has these same
         * dimensions, so no index can be out of range.
         *
         * Only into cells that are still occupied here. The fill floods the whole document, hidden
         * objects included, but `shown` has emptied those out; writing paint into one would make a
         * hidden voxel appear, which is a bigger lie than not previewing a change nobody can see.
         */
        for (const index of hover.region) if (data[index] !== 0) data[index] = state.color
        return {...shown, data}
    }
    return shown
}

const withHover = <S extends Gesture>(state: S, hover: Hover | undefined): S =>
    state.hover === undefined && hover === undefined ? state : changed(state, {hover})

/**
 * Which voxels a press with a selecting tool takes hold of — `FEATURESET.md` §31's four gestures,
 * plus the surface patch a pull grabs.
 *
 * One function, called twice: by `beginSelect` when the button goes down, and by `hoverAt` a moment
 * earlier so the artist sees the answer first. Two copies of this reasoning would be two chances for
 * the outline to promise a selection the press does not make, and the whole point of the outline is
 * that it cannot.
 */
const pressSelection = (
    state: Gesture,
    volume: Volume,
    hit: {x: number; y: number; z: number; face: number},
    event: {clicks: number; alt: boolean; ctrl: boolean}
): Selection => {
    /*
     * The Scale tool pulls a surface. What it grabs is the patch under the cursor rather than the
     * standing selection, because a pull is aimed at a face and the artist is pointing at one.
     */
    if (state.tool === 'scale') {
        return facePatch(volume, hit.x, hit.y, hit.z, FACE_STEP[hit.face] ?? [0, 0, 0])
    }
    /*
     * Pressing on a voxel that is *already* selected keeps the whole selection instead of collapsing
     * it to one cell, which is what makes a rubber-banded group draggable.
     */
    const already = state.selection.has(voxelIndex(state.volume, hit.x, hit.y, hit.z))
    // Alt means the *named* object, not the connected solid: with a list of objects to point at,
    // `FEATURESET.md` §31's "modifier-click = whole object" has an exact answer, and two pieces of
    // one object that do not touch are still one object.
    const owned = ownerAt(state.volume, hit.x, hit.y, hit.z)
    const picked =
        event.clicks >= 2 ? selectConnectedColor(volume, hit.x, hit.y, hit.z)
        : event.alt && owned !== 0 ? objectCells(state.volume, owned)
        : event.alt ? selectObject(volume, hit.x, hit.y, hit.z)
        : already && !event.ctrl ? state.selection
        : selectVoxel(volume, hit.x, hit.y, hit.z)

    /*
     * Control adds — `FEATURESET.md` §39's selection, built one piece at a time.
     *
     * Without it a selection can only ever be one click's worth: a press outside what is selected
     * replaces it, which is what every editor does and what an artist assembling two arms and a
     * head out of separate clicks has no answer to. It stacks with the other two, so
     * Control-double-click adds a whole colour and Control-Alt-click adds a whole object.
     *
     * Shift would be the usual key and it is spoken for: Shift always pans, whatever is armed, and
     * a modifier that means "add" over the model and "move the camera" two pixels off it is a
     * modifier nobody can trust.
     */
    if (!event.ctrl || state.selection.size === 0) return picked
    return new Set([...state.selection, ...picked])
}

/**
 * The last region a hover computed, so the pointer moving inside one voxel does not re-flood it.
 *
 * Fill and the grab tools answer with a traversal rather than with a footprint, and a traversal is
 * not free: measured, a 128³ grid of a single colour is 487 ms to flood, of which 200 ms is building
 * the `Set` — so running one per pointer move would be a two-frames-a-second editor on any document
 * that is mostly one paint. A realistic model is microseconds, but "realistic" is not a guarantee.
 *
 * The pointer is in one place at a time, so one entry is the whole cache. `reduce` stays pure: this
 * returns only what recomputing would have returned, and the key holds the identity of every input
 * the answer is derived from, so anything changing is a miss.
 */
interface AimKey {
    readonly tool: Tool
    readonly seed: number
    readonly volume: Volume
    readonly objects: Objects
    readonly selection: Selection
    readonly slice: number | undefined
    readonly plane: Axis | undefined
    readonly camera: Camera
    readonly color: number
    readonly alt: boolean
    readonly ctrl: boolean
    readonly clicks: number
    readonly face: number
}

interface AimAnswer {
    readonly region: Selection
    readonly cells: readonly Offset[]
    readonly bounds: {min: Cell; max: Cell} | undefined
    readonly blocked: Blocked | undefined
}

let aimed: {key: AimKey; answer: AimAnswer} | undefined

const sameAim = (a: AimKey, b: AimKey): boolean =>
    a.tool === b.tool
    && a.seed === b.seed
    && a.volume === b.volume
    && a.objects === b.objects
    && a.selection === b.selection
    && a.slice === b.slice
    && a.plane === b.plane
    && a.camera === b.camera
    && a.color === b.color
    && a.alt === b.alt
    && a.ctrl === b.ctrl
    && a.clicks === b.clicks
    && a.face === b.face

/** A region as triples, but only when there are few enough for the overlay to draw one cube each. */
const drawable = (volume: Volume, region: Selection): readonly Offset[] =>
    region.size > GHOST_CELLS ? [] : [...region].map(index => cellOf(volume, index))

/**
 * Where the next click would land, decided by the same reasoning the press itself uses.
 *
 * Every branch below is one from `beginStroke` or `beginSelect`, deliberately: which cell Draw aims
 * at, which face orients the brush, what a plane lock and slice mode override, which grid a fill
 * floods and which one a grab selects on. The preview is worth having only for as long as it cannot
 * be more optimistic than the edit.
 *
 * It reads `aim` — the last place the pointer was seen — rather than an event, so that changing the
 * brush, the colour, the tool or the model re-aims without the artist having to jiggle the mouse.
 * `reduce` is what notices those, at the bottom of this file.
 */
export const hoverAt = <S extends Gesture>(state: S): S => {
    const event = state.aim
    if (!event) return withHover(state, undefined)
    // A gesture owns the pointer: a stroke is already showing its own voxels, and an outline that
    // chased an orbit would be aiming at a picture that is still moving.
    if (state.stroke || state.drag || state.band) return withHover(state, undefined)
    if (state.orbit.gesture !== undefined) return withHover(state, undefined)
    if (!AIMS.has(state.tool)) return withHover(state, undefined)
    if (event.height <= 0 || event.width <= 0) return withHover(state, undefined)
    const volume = visible(state)
    const basis = basisFor(state.orbit.camera, volume, event.height)
    const hit = pick(volume, basis, event.x, event.y, event.width, event.height)
    if (!hit) return withHover(state, undefined)

    const outward = state.tool === 'draw' && !event.alt
    const cell: Cell = outward ? hit.place : [hit.x, hit.y, hit.z]
    // The floor is a surface to draw on, and nothing to erase, recolour, sample or take hold of.
    if (!outward && hit.value === 0) return withHover(state, undefined)

    const axis = state.plane ?? faceAxis(hit.face)
    const face = state.plane === undefined ? hit.face : axis * 2 + 1
    /*
     * The struck face, as a plane. Face codes pair up odd-negative, even-positive, so a `+` face
     * sits at the far side of the voxel it belongs to and at the near side of the cell in front of
     * it — which is why `outward` flips the offset rather than the axis.
     */
    const positive = face % 2 === 0
    const surface = cell[axis] + (positive === outward ? 0 : 1)
    const at = {cell, face, surface}
    const locked = lockedIds(state.objects)

    // Pick reads the model and writes nothing, so it proposes the colour it would take out rather
    // than the one that is loaded — and it is blocked when that colour is already the loaded one,
    // which is the one press with this tool that genuinely does nothing.
    if (state.tool === 'pick') {
        return withHover(state, {
            ...at,
            kind: 'sample',
            cells: [cell],
            region: undefined,
            bounds: {min: cell, max: cell},
            paint: hit.value,
            blocked: hit.value === state.color ? NOTHING : undefined
        })
    }

    if (USES_BRUSH.has(state.tool)) {
        const cells = mirrored(state, strokeCells(state.brush, face, cell, cell))
        const value = state.tool === 'erase' ? 0 : state.color
        return withHover(state, {
            ...at,
            kind: state.tool === 'erase' ? 'clear' : 'write',
            // The whole footprint, off-grid cells included — `blocked` is exactly the report that
            // some of them are, so it is asked before anything is trimmed.
            blocked: blockedBy(state, locked, cells, value),
            cells: cells.length > GHOST_CELLS ? [] : cells,
            region: undefined,
            bounds: footprintBox(cells),
            paint: state.tool === 'erase' ? undefined : state.color
        })
    }

    /*
     * Fill and the four grab tools answer with a traversal. Both go through the cache, and both run
     * the traversal against the grid the press will run it against — which is not the same grid for
     * the two of them, and getting that wrong is how a preview starts lying:
     *
     * - **Fill** floods the *document*. `beginStroke` opens a draft over `state.volume`, so a fill
     *   crosses into hidden objects and out of the current slice, and a preview that stopped at the
     *   visible surface would under-promise.
     * - **Grab** selects on the *visible* grid, because a rubber band and a click both mean "what I
     *   can see", and `beginSelect` picks against `visible(state)` for that reason.
     */
    const seed = voxelIndex(state.volume, hit.x, hit.y, hit.z)
    const key: AimKey = {
        tool: state.tool,
        seed,
        volume: state.volume,
        objects: state.objects,
        selection: state.selection,
        slice: state.slice,
        plane: state.plane,
        camera: state.orbit.camera,
        color: state.color,
        alt: event.alt,
        ctrl: event.ctrl,
        clicks: event.clicks,
        face: hit.face
    }
    const answer =
        aimed && sameAim(aimed.key, key) ?
            aimed.answer
        :   solveRegion(state, volume, hit, event, locked)
    aimed = {key, answer}

    return withHover(state, {
        ...at,
        kind: state.tool === 'fill' ? 'recolour' : 'grab',
        cells: answer.cells,
        region: answer.region,
        bounds: answer.bounds,
        paint: state.tool === 'fill' ? state.color : undefined,
        blocked: answer.blocked
    })
}

/** The box a list of offsets occupies, off-grid ends included. `undefined` for an empty list. */
const footprintBox = (cells: readonly Offset[]): {min: Cell; max: Cell} | undefined => {
    if (cells.length === 0) return undefined
    let [x0, y0, z0] = [Infinity, Infinity, Infinity]
    let [x1, y1, z1] = [-Infinity, -Infinity, -Infinity]
    for (const [x, y, z] of cells) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        z0 = Math.min(z0, z)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
        z1 = Math.max(z1, z)
    }
    return {min: [x0, y0, z0], max: [x1, y1, z1]}
}

/** The expensive half of `hoverAt`, split out so the cache above has one thing to guard. */
const solveRegion = (
    state: Gesture,
    volume: Volume,
    hit: {x: number; y: number; z: number; face: number},
    event: {clicks: number; alt: boolean; ctrl: boolean},
    locked: ReadonlySet<number>
): AimAnswer => {
    if (state.tool === 'fill') {
        // `fillRegion` is this traversal plus a write, over the document. Same seed, same grid.
        const region = connected(state.volume, hit.x, hit.y, hit.z)
        return {
            region,
            cells: drawable(state.volume, region),
            bounds: selectionBounds(state.volume, region),
            // A region that is already the loaded colour, or entirely locked, recolours to nothing.
            blocked: blockedBy(state, locked, regionCells(state.volume, region), state.color)
        }
    }
    const region = pressSelection(state, volume, hit, event)
    return {
        region,
        cells: drawable(state.volume, region),
        bounds: selectionBounds(state.volume, region),
        blocked: blockedGrab(state, locked, region)
    }
}

export const beginStroke = <S extends Gesture>(state: S, event: ViewportPointer): S => {
    const {tool, color, brush} = state
    // A viewport with no size has no pixels to cast a ray through, and `zoom / 0` would send one
    // off to infinity. happy-dom reports exactly this, so it is a real case and not a guard.
    if (event.height <= 0 || event.width <= 0) return state
    // Picked against what is on screen: a hidden object is not something the cursor can land on.
    const volume = visible(state)
    const basis = basisFor(state.orbit.camera, volume, event.height)
    const hit = pick(volume, basis, event.x, event.y, event.width, event.height)
    if (!hit) return state

    // Pick is not an edit and does not open a stroke; it loads the colour and gets out of the way.
    if (tool === 'pick') {
        return hit.value === 0 ?
                state
            :   changed(state, {color: hit.value, recent: remember(state.recent, hit.value)})
    }

    if (tool === 'fill') {
        const draft = openDraft(state)
        fillRegion(draft, hit.x, hit.y, hit.z, color)
        const edit = commitEdit(draft)
        if (!edit) return state
        return changed(state, {volume: draft.volume, history: record(state.history, edit)})
    }

    /*
     * `FEATURESET.md` §4, decided one way rather than guessed at every click: Draw writes into the
     * empty cell in front of the face — the cell the artist is pointing at across the surface —
     * and Alt writes into the voxel itself, which is Paint. Erase always means the voxel itself.
     * Nothing here inspects what colour is already there, because a tool whose meaning depends on
     * the model under the cursor is a tool the artist cannot aim.
     */
    const outward = tool === 'draw' && !event.alt
    const cell = outward ? hit.place : ([hit.x, hit.y, hit.z] as const)
    // The floor is a surface to draw on, not a voxel to recolour or rub out.
    if (!outward && hit.value === 0) return state

    const value = tool === 'erase' ? 0 : color
    const draft = openDraft(state)
    /*
     * With no plane lock the canvas is the face that was clicked — `FEATURESET.md` §5's "click a
     * face to temporarily make it your canvas", which falls out of the stroke pinning to a layer.
     * With a lock it is that plane of the grid, at whatever layer the click landed on, so drawing
     * stays flat across a surface that is not.
     */
    const axis = state.plane ?? faceAxis(hit.face)
    const face = state.plane === undefined ? hit.face : axis * 2 + 1
    // In slice mode the layer is the slice, not whatever the ray happened to land on: the point of
    // the mode is that the artist is working on one layer and can see it.
    const layer = state.slice ?? cell[axis]
    writeCells(draft, mirrored(state, strokeCells(brush, face, cell, cell)), value)
    return changed(state, {
        volume: live(draft),
        stroke: {
            draft,
            base: state.volume,
            origin: cell,
            axis,
            layer,
            face,
            value,
            at: cell,
            spots: [cell],
            depth: layer
        }
    })
}

/**
 * The plane a Shift-held drag measures depth on — the other half of `FEATURESET.md` §5.
 *
 * A stroke pins itself to the plane of the click, which is what a drag *along* a surface wants and
 * gives no way at all to leave it. Depth has to be read off a plane the normal lies in, and two of
 * them do: pick the more face-on to the camera. The other is nearer edge-on, where `pickPlane` has
 * no cell to answer with and a drag of any length maps to a handful of voxels.
 */
const sideAxis = (axis: Axis, forward: readonly [number, number, number]): Axis => {
    const a: Axis = axis === 0 ? 1 : 0
    const b: Axis = axis === 2 ? 1 : 2
    return Math.abs(forward[a]) >= Math.abs(forward[b]) ? a : b
}

/**
 * The flat stroke, repeated out along its own normal — Shift held mid-drag.
 *
 * The shape stops following the cursor and the depth starts, so the gesture reads as pulling the
 * thing already drawn out of the surface. It is drawn from `base` every move for the same reason a
 * figure is: dragging back towards the surface has to *take away* layers, which appending cannot
 * do. Letting Shift go hands the cursor back to the shape and collapses the stroke flat again —
 * nothing here is stored across a move, so the key is the whole of the mode.
 *
 * Depth is a layer rather than a count, which is what lets it go negative: an extrude dragged past
 * the surface digs in behind it instead of stopping dead at zero.
 */
const extrudeStroke = <S extends Gesture>(
    state: S,
    stroke: Stroke,
    basis: Basis,
    event: ViewportPointer
): S => {
    const side = sideAxis(stroke.axis, basis.forward)
    const cell = pickPlane(
        basis,
        event.x,
        event.y,
        event.width,
        event.height,
        side,
        stroke.at[side]
    )
    if (!cell) return state
    const depth = cell[stroke.axis]
    if (depth === stroke.depth) return state

    const draft = openDraft(state, stroke.base)
    const lo = Math.min(stroke.layer, depth)
    const hi = Math.max(stroke.layer, depth)
    const cells: Cell[] = []
    for (let at = lo; at <= hi; at += 1) {
        for (const spot of stroke.spots) {
            const moved: [number, number, number] = [spot[0], spot[1], spot[2]]
            moved[stroke.axis] = at
            cells.push(...strokeCells(state.brush, stroke.face, moved, moved))
        }
    }
    writeCells(draft, mirrored(state, cells), stroke.value)
    return changed(state, {volume: live(draft), stroke: {...stroke, draft, depth}})
}

export const continueStroke = <S extends Gesture>(state: S, event: ViewportPointer): S => {
    const {stroke} = state
    if (!stroke) return state
    const basis = basisFor(state.orbit.camera, state.volume, event.height)
    if (event.shift) return extrudeStroke(state, stroke, basis, event)

    const cell = pickPlane(
        basis,
        event.x,
        event.y,
        event.width,
        event.height,
        stroke.axis,
        stroke.layer
    )
    if (!cell) return state
    const [x, y, z] = cell
    const still = x === stroke.at[0] && y === stroke.at[1] && z === stroke.at[2]
    // An extrude that has just been let go has to be undone even when the cursor has not moved,
    // or the depth outlives the key that asked for it.
    if (still && stroke.depth === stroke.layer) return state

    /*
     * Freehand appends to the draft it already has. A figure is redrawn from the document the
     * stroke opened on, because a rectangle that grew by appending would leave every intermediate
     * rectangle behind it — and because dragging back the way you came has to shrink the figure,
     * which appending cannot do.
     */
    if (state.brush.figure === 'free') {
        // Freehand is the one stroke whose shape is history rather than arithmetic, so the cells an
        // extrude would repeat have to be kept as the drag lays them down.
        const spots = [...stroke.spots, ...figureCells('free', stroke.at, cell, stroke.axis)]
        const draft = stroke.depth === stroke.layer ? stroke.draft : openDraft(state, stroke.base)
        const cells =
            draft === stroke.draft ?
                strokeCells(state.brush, stroke.face, stroke.at, cell)
            :   spots.flatMap(spot => strokeCells(state.brush, stroke.face, spot, spot))
        writeCells(draft, mirrored(state, cells), stroke.value)
        return changed(state, {
            volume: live(draft),
            stroke: {...stroke, draft, at: cell, spots, depth: stroke.layer}
        })
    }

    const draft = openDraft(state, stroke.base)
    const spots = figureCells(state.brush.figure, stroke.origin, cell, stroke.axis)
    const cells = spots.flatMap(spot => strokeCells(state.brush, stroke.face, spot, spot))
    writeCells(draft, mirrored(state, cells), stroke.value)
    return changed(state, {
        volume: live(draft),
        stroke: {...stroke, draft, at: cell, spots, depth: stroke.layer}
    })
}

/**
 * `FEATURESET.md` §31's four gestures, on one click.
 *
 * Click a voxel takes the voxel; double-click takes its connected colour; Alt-click takes the whole
 * connected solid. A click on air starts a rubber band instead — the only reading of a drag over
 * nothing that does not throw the current selection away by accident.
 */
export const beginSelect = <S extends Gesture>(state: S, event: ViewportPointer): S => {
    if (event.height <= 0 || event.width <= 0) return state
    const volume = visible(state)
    const basis = basisFor(state.orbit.camera, volume, event.height)
    const hit = pickRay(volume, basis, event.x, event.y, event.width, event.height)
    if (!hit) {
        return changed(state, {
            band: {
                x0: event.x,
                y0: event.y,
                x1: event.x,
                y1: event.y,
                width: event.width,
                height: event.height
            }
        })
    }

    if (state.tool === 'scale') {
        const patch = pressSelection(state, volume, hit, event)
        return changed(state, {
            selection: patch,
            drag: {
                kind: 'extrude',
                volume: state.volume,
                selection: patch,
                from: [hit.x, hit.y, hit.z],
                axis: faceAxis(hit.face),
                layer: hit[AXIS_KEYS[faceAxis(hit.face)]],
                face: hit.face,
                x: event.x,
                y: event.y
            }
        })
    }

    /*
     * Selecting and dragging are the same gesture. A press picks what is under the cursor, and if
     * the pointer then moves, that is what gets carried — so moving one voxel is one gesture rather
     * than click, then aim again, then drag. A press that never moves writes nothing and commits
     * nothing, because the move only fires when the cell under the cursor changes.
     *
     * What the carrying *is* is the tool: Move slides the voxels, Clone leaves a copy behind, and
     * Rotate turns them a quarter at a time about the face that was grabbed.
     */
    const selection = pressSelection(state, volume, hit, event)

    const axis = faceAxis(hit.face)
    return changed(state, {
        selection,
        band: undefined,
        drag: {
            kind:
                state.tool === 'clone' ? 'clone'
                : state.tool === 'rotate' ? 'turn'
                : 'move',
            volume: state.volume,
            selection,
            // The plane of the face that was grabbed: dragging follows the surface under the hand.
            from: [hit.x, hit.y, hit.z],
            axis,
            layer: hit[AXIS_KEYS[axis]],
            face: hit.face,
            x: event.x,
            y: event.y
        }
    })
}

const AXIS_KEYS = ['x', 'y', 'z'] as const

/**
 * How many voxels along the face normal a pointer has travelled.
 *
 * A world step of one voxel along `n` moves the picture by `n · right` and `-n · up` voxels, which
 * is that over `scale` in pixels. Projecting the pointer's travel back onto that direction is the
 * least-squares answer, and rounding it is what makes a pull land on whole layers. Edge-on to the
 * normal there is no answer, and the pull does nothing rather than something arbitrary.
 */
const layersPulled = (state: Gesture, drag: Drag, event: ViewportPointer): number => {
    const basis = basisFor(state.orbit.camera, drag.volume, event.height)
    const step = FACE_STEP[drag.face] ?? [0, 0, 0]
    const along = step[0] * basis.right[0] + step[1] * basis.right[1] + step[2] * basis.right[2]
    const over = -(step[0] * basis.up[0] + step[1] * basis.up[1] + step[2] * basis.up[2])
    const squared = along * along + over * over
    if (squared < 1e-6) return 0
    const dx = event.x - drag.x
    const dy = event.y - drag.y
    return Math.round(((dx * along + dy * over) * basis.scale) / squared)
}

/** How far sideways the hand goes before the turn commits. */
const TURN_PIXELS = 48

/**
 * Which way one drag turns the selection: a quarter left, a quarter right, or not yet.
 *
 * Sideways pixels, not a swept angle. A turn has no length in the world to project the pointer onto
 * the way a pull does, so there is nothing to measure but how far the hand went; and a straight
 * sideways drag is the one gesture in the viewport that cannot be mistaken for an orbit.
 *
 * **One quarter per drag, however far the hand goes.** Counting a quarter every 48 px was the
 * obvious reading and it was wrong on the screen: four quarters is the identity, so a long drag
 * walked the model back to where it started, and two quarters is the identity for anything
 * symmetric — which a two-voxel bar is. Measured across a 320 px drag it flipped between exactly
 * two pictures eight times. A ratchet has one boundary instead of six and cannot flicker; turning
 * twice is two drags, which is also what the buttons on the selection bar cost.
 *
 * The sign follows the grabbed face rather than the axis. A quarter turn about `z` reads clockwise
 * from above and anticlockwise from below, so an artist who has orbited under the model and drags
 * right would otherwise watch it turn the opposite way from the one they just learned.
 */
const quartersTurned = (state: Gesture, drag: Drag, event: ViewportPointer): number => {
    const dx = event.x - drag.x
    if (Math.abs(dx) < TURN_PIXELS) return 0
    const basis = basisFor(state.orbit.camera, drag.volume, event.height)
    const step = FACE_STEP[drag.face] ?? [0, 0, 0]
    const into =
        step[0] * basis.forward[0] + step[1] * basis.forward[1] + step[2] * basis.forward[2]
    const facing = into <= 0 ? 1 : -1
    return facing * Math.sign(dx)
}

export const continueDrag = <S extends Gesture>(state: S, event: ViewportPointer): S => {
    const {drag} = state
    if (!drag) return state
    const draft = openDraft(state, drag.volume)

    if (drag.kind === 'turn') {
        const quarters = quartersTurned(state, drag, event)
        if (quarters === 0) {
            return changed(state, {volume: drag.volume, selection: drag.selection, losing: 0})
        }
        const turned = rotateCells(draft, drag.selection, faceAxis(drag.face), quarters)
        /*
         * A turn is a bijection: every voxel has exactly one destination, so an answer that came
         * back smaller lost some off the edge of the grid. Refuse it whole and leave the model where
         * it was — the same rule the keyboard transform applies, and for the same reason. The draft
         * is a throwaway copy, so dropping it costs nothing.
         */
        if (turned.size !== drag.selection.size) {
            return changed(state, {volume: drag.volume, selection: drag.selection, losing: 0})
        }
        return changed(state, {volume: draft.volume, selection: turned})
    }

    if (drag.kind === 'extrude') {
        const layers = layersPulled(state, drag, event)
        if (layers === 0) {
            return changed(state, {volume: drag.volume, selection: drag.selection, losing: 0})
        }
        const face = extrudeCells(draft, drag.selection, FACE_STEP[drag.face] ?? [0, 0, 0], layers)
        return changed(state, {volume: draft.volume, selection: face})
    }

    const basis = basisFor(state.orbit.camera, drag.volume, event.height)
    const cell = pickPlane(
        basis,
        event.x,
        event.y,
        event.width,
        event.height,
        drag.axis,
        drag.layer
    )
    if (!cell) return state
    const delta: Cell = [cell[0] - drag.from[0], cell[1] - drag.from[1], cell[2] - drag.from[2]]
    if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0) {
        return changed(state, {volume: drag.volume, selection: drag.selection, losing: 0})
    }
    /*
     * Counted against the grid the drag *started* on, which is the one the drop is about to be
     * replayed over. Counting against `state.volume` would count the previous position of this same
     * gesture, and read as a warning about voxels the artist has not lost.
     */
    const losing = lossCount(drag.volume, drag.selection, delta, drag.kind !== 'clone')
    const selection =
        drag.kind === 'clone' ?
            duplicateCells(draft, drag.selection, delta)
        :   moveCells(draft, drag.selection, delta)
    return changed(state, {volume: draft.volume, selection, losing})
}

export const endDrag = <S extends Gesture>(state: S): S => {
    const {drag} = state
    if (!drag) return state
    // The document already shows the result, so the commit is only about the history: replay the
    // whole gesture once against the volume it started from and record that as one diff.
    const draft = openDraft(state, drag.volume)
    draft.volume.data.set(state.volume.data)
    draft.volume.owner.set(state.volume.owner)
    for (let i = 0; i < draft.volume.data.length; i += 1) {
        const was = drag.volume.data[i] ?? 0
        const owned = drag.volume.owner[i] ?? 0
        if (was === (draft.volume.data[i] ?? 0) && owned === (draft.volume.owner[i] ?? 0)) continue
        draft.before.set(i, was)
        draft.beforeOwner.set(i, owned)
    }
    const edit = commitEdit(draft)
    return changed(state, {
        drag: undefined,
        // The warning was about a drop that had not happened yet. It has now.
        losing: 0,
        history: edit ? record(state.history, edit) : state.history
    })
}

export const endBand = <S extends Gesture>(state: S): S => {
    const {band} = state
    if (!band) return state
    const basis = basisFor(state.orbit.camera, state.volume, band.height)
    // A band that never moved is a click on air, and a click on air deselects.
    const moved = Math.abs(band.x1 - band.x0) > 1 || Math.abs(band.y1 - band.y0) > 1
    return changed(state, {
        band: undefined,
        selection:
            moved ? selectRect(state.volume, basis, band, band.width, band.height) : EMPTY_SELECTION
    })
}

export const endStroke = <S extends Gesture>(state: S): S => {
    const {stroke} = state
    if (!stroke) return state
    const edit = commitEdit(stroke.draft)
    return changed(state, {
        stroke: undefined,
        history: edit ? record(state.history, edit) : state.history
    })
}

/**
 * What `hover` depends on. Anything here changing means the outline on screen is now describing a
 * click that would do something else.
 *
 * A comparison rather than a `hoverAt` call in each of the reducer's fifty cases, because the list
 * can be read and the fifty call sites could not — and a case that forgot one would leave the
 * artist an outline that is quietly lying, which is worse than the nothing this replaces.
 *
 * It used to be a hand-written array of `keyof AppState`, sitting a thousand lines away from the
 * `AimKey` that lists the same fields for the cache. One of the two would eventually have been
 * updated on its own. Both are now this file's `Gesture`.
 */
export const changedAim = (before: Gesture, after: Gesture): boolean =>
    before.aim !== after.aim
    || before.volume !== after.volume
    || before.tool !== after.tool
    || before.brush !== after.brush
    || before.color !== after.color
    || before.plane !== after.plane
    || before.slice !== after.slice
    || before.symmetry !== after.symmetry
    || before.objects !== after.objects
    || before.orbit !== after.orbit
    || before.stroke !== after.stroke
    || before.drag !== after.drag
    || before.band !== after.band
    // The grab tools read it: a press on a voxel that is already selected keeps the whole selection
    // rather than collapsing to that one cell, so what is outlined changes when the selection does.
    || before.selection !== after.selection

/**
 * Forget the hover cache — see `aimed`.
 *
 * A module-level cache is a module-level fact, and two tests in a row that build the same document
 * and aim at the same voxel would otherwise share one. Only tests call this; the app has one
 * pointer and wants the cache it has.
 */
export const forgetAim = (): void => {
    aimed = undefined
}
