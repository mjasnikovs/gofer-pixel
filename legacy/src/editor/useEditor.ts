import {useCallback, useMemo, useRef, useState} from 'react'
import {History} from '../doc/history'
import {
    addFrame,
    addLayer,
    addTag,
    celAt,
    createDocument,
    documentBytes,
    documentFromModel,
    documentFromScene,
    duplicateFrame,
    moveLayer,
    removeFrame,
    removeLayer,
    removeRamp,
    removeTag,
    setPalette,
    updateLayer,
    updateTag,
    type Document,
    type DocumentOrigin,
    type Layer,
    type Tag
} from '../doc/document'
import {loadProject, saveProject} from '../doc/serialize'
import {
    addGradientRamp,
    gradientBetween,
    mergeDuplicates,
    sortPalette,
    type SortKey
} from '../doc/palette'
import type {Rgba} from '../vox/palette'
import {copySlice, replaceColor} from '../doc/tools'
import {editCel} from '../doc/document'
import {Volume} from '../doc/volume'
import {applyBrush3d, applyVoxels, type Brush3D, type BrushMode, type BrushShape} from './brush3d'
import {pickColor, removeColor, selectRegion} from './select3d'
import {pickSurface, type Axis, type OrthoView} from './view3d'
import type {Clipboard} from '../doc/selection'
import type {VoxModel} from '../vox/model'
import type {VoxScene} from '../vox/vox-scene'
import {
    applyStroke,
    beginStroke,
    copyToClipboard,
    deleteSelected,
    deselect,
    extendStroke,
    labelFor,
    pasteAt,
    selectAll,
    type EditorSnapshot,
    type Stroke,
    type Tool
} from './state'

/**
 * The editor's React half: a `History` of snapshots, the in-flight gesture, and the settings that
 * are not part of the document.
 *
 * Undo and redo are event handlers rather than reducer actions on purpose. React re-invokes a
 * reducer in development to surface impure ones, and moving a history cursor twice per keypress
 * is exactly the bug that would produce.
 */
export interface EditorSettings {
    tool: Tool
    color: number
    mirrorX: boolean
    mirrorY: boolean
    filled: boolean
    onionSkin: boolean
    /** Ghost the same slice from the frames either side — the animation onion skin. */
    frameOnion: boolean
    /** 3D mode. `region` and `pick` act on a whole connected run and on the colour under the
     * cursor; the rest are the MagicaVoxel brush shapes. */
    shape3d: BrushShape | 'region' | 'pick'
    mode3d: BrushMode
    axisLock: Axis | null
    /** Slice lock: keep every 3D operation on the slice the 2D mode is editing. */
    sliceLock: boolean
}

const HISTORY_BYTES = 256 * 1024 * 1024

const initialSnapshot = (doc: Document): EditorSnapshot => ({
    doc,
    selection: null,
    slice: 0,
    layer: 0,
    frame: 0
})

/**
 * What the UI needs to know about the undo stack. Copied into state whenever the stack moves —
 * the stack itself is a mutable object, and reading it during render is how a greyed-out undo
 * button ends up one edit behind.
 */
interface HistoryView {
    canUndo: boolean
    canRedo: boolean
    undoLabel: string | null
    redoLabel: string | null
    bytes: number
}

const readHistory = (stack: History<EditorSnapshot>): HistoryView => ({
    canUndo: stack.canUndo,
    canRedo: stack.canRedo,
    undoLabel: stack.undoLabel,
    redoLabel: stack.redoLabel,
    bytes: stack.bytes
})

export const useEditor = (initial?: Document) => {
    const [stack] = useState(
        () =>
            new History<EditorSnapshot>(initialSnapshot(initial ?? createDocument()), {
                maxBytes: HISTORY_BYTES,
                measure: states => documentBytes(states.map(state => state.doc))
            })
    )

    const [snapshot, setSnapshot] = useState<EditorSnapshot>(() => stack.current)
    const [history, setHistory] = useState<HistoryView>(() => readHistory(stack))
    const [settings, setSettings] = useState<EditorSettings>({
        tool: 'pencil',
        color: 1,
        mirrorX: false,
        mirrorY: false,
        filled: true,
        onionSkin: true,
        frameOnion: false,
        shape3d: 'voxel',
        mode3d: 'attach',
        axisLock: null,
        sliceLock: false
    })
    const [clipboard, setClipboard] = useState<Clipboard | null>(null)
    const stroke = useRef<{base: EditorSnapshot; stroke: Stroke} | null>(null)
    const sync = useCallback(() => {
        setHistory(readHistory(stack))
    }, [stack])

    /** Commit a finished change. Anything that does not change the document skips the stack. */
    const commit = useCallback(
        (next: EditorSnapshot, label: string, changed = true) => {
            setSnapshot(next)
            if (changed) {
                stack.commit(next, label)
            } else {
                stack.replace(next)
            }
            sync()
        },
        [stack, sync]
    )

    const pointerDown = useCallback(
        (x: number, y: number) => {
            const started = beginStroke(settings.tool, [x, y], settings)
            stroke.current = {base: snapshot, stroke: started}
            const result = applyStroke(snapshot, started)
            if (result.pickedColor !== undefined && result.pickedColor !== 0) {
                setSettings(s => ({...s, color: result.pickedColor ?? s.color}))
            }
            setSnapshot(result.snapshot)
        },
        [settings, snapshot]
    )

    const pointerMove = useCallback((x: number, y: number) => {
        const active = stroke.current
        if (!active) {
            return
        }
        const extended = extendStroke(active.stroke, [x, y])
        if (extended === active.stroke) {
            return
        }
        stroke.current = {...active, stroke: extended}
        setSnapshot(applyStroke(active.base, extended).snapshot)
    }, [])

    const pointerUp = useCallback(() => {
        const active = stroke.current
        stroke.current = null
        if (!active) {
            return
        }
        const result = applyStroke(active.base, active.stroke)
        commit(result.snapshot, labelFor(active.stroke.tool), result.changed)
    }, [commit])

    /**
     * The brush the 3D viewports are holding.
     *
     * `region` and `pick` borrow the voxel brush's targeting — they differ in what they do with
     * the hit, not in how they find it.
     */
    const brush3d = useMemo(
        (): Brush3D => ({
            shape:
                settings.shape3d === 'region' || settings.shape3d === 'pick' ?
                    'voxel'
                :   settings.shape3d,
            mode: settings.mode3d,
            color: settings.color,
            mirrorX: settings.mirrorX,
            mirrorY: settings.mirrorY,
            axisLock: settings.axisLock,
            ...(settings.sliceLock ? {lockZ: snapshot.slice} : {})
        }),
        [settings, snapshot.slice]
    )

    /**
     * A 3D gesture replays from the snapshot it started on, exactly as a 2D stroke does, so the
     * drag preview and the committed result come out of one code path.
     *
     * Picking reads the *active cel*, not the composite: the views show every visible layer, but
     * building against a voxel on a layer you are not editing would put the new voxel somewhere
     * you cannot see it.
     */
    const gesture3d = useRef<{
        base: EditorSnapshot
        view: OrthoView
        from: [number, number]
    } | null>(null)

    /**
     * `editCel` hands back a new document whether or not the edit wrote anything, so "did the
     * object identity change" is not the question — a click on empty space would otherwise land
     * an empty entry on the undo stack. The brush's changed count is the answer, and a gesture
     * that changed nothing gives the original document straight back.
     */
    const run3d = useCallback(
        (
            base: EditorSnapshot,
            view: OrthoView,
            from: [number, number],
            to: [number, number]
        ): {doc: Document; changed: boolean} => {
            let changed = 0
            const doc = editCel(base.doc, base.layer, base.frame, volume => {
                changed = applyBrush3d(volume, base.doc.size, brush3d, {view, from, to})
            })
            return changed > 0 ? {doc, changed: true} : {doc: base.doc, changed: false}
        },
        [brush3d]
    )

    const pointerDown3d = useCallback(
        (view: OrthoView, h: number, v: number) => {
            const cel = celAt(snapshot.doc, snapshot.layer, snapshot.frame) ?? new Volume()
            const options = settings.sliceLock ? {lockZ: snapshot.slice} : {}

            if (settings.shape3d === 'pick') {
                const color = pickColor(cel, view, h, v, snapshot.doc.size, brush3d)
                if (color !== null) {
                    setSettings(s => ({...s, color}))
                }
                return
            }
            if (settings.shape3d === 'region') {
                const seed = pickSurface(cel, view, h, v, snapshot.doc.size, options)
                if (!seed) {
                    return
                }
                let changed = 0
                const doc = editCel(snapshot.doc, snapshot.layer, snapshot.frame, volume => {
                    changed = applyVoxels(
                        volume,
                        snapshot.doc.size,
                        brush3d,
                        selectRegion(volume, seed, snapshot.doc.size)
                    )
                })
                commit({...snapshot, doc}, `${settings.mode3d} region`, changed > 0)
                return
            }

            gesture3d.current = {base: snapshot, view, from: [h, v]}
            setSnapshot({...snapshot, doc: run3d(snapshot, view, [h, v], [h, v]).doc})
        },
        [snapshot, settings, brush3d, commit, run3d]
    )

    const pointerMove3d = useCallback(
        (h: number, v: number) => {
            const active = gesture3d.current
            if (!active) {
                return
            }
            setSnapshot({
                ...active.base,
                doc: run3d(active.base, active.view, active.from, [h, v]).doc
            })
        },
        [run3d]
    )

    const pointerUp3d = useCallback(
        (h: number, v: number) => {
            const active = gesture3d.current
            gesture3d.current = null
            if (!active) {
                return
            }
            const {doc, changed} = run3d(active.base, active.view, active.from, [h, v])
            commit({...active.base, doc}, `${settings.mode3d} ${settings.shape3d}`, changed)
        },
        [commit, run3d, settings]
    )

    const undo = useCallback(() => {
        setSnapshot(stack.undo())
        sync()
    }, [stack, sync])

    const redo = useCallback(() => {
        setSnapshot(stack.redo())
        sync()
    }, [stack, sync])

    /** Change where the artist is without putting a new entry on the stack. */
    const navigate = useCallback(
        (patch: Partial<Pick<EditorSnapshot, 'slice' | 'layer' | 'frame' | 'selection'>>) => {
            const next = {...snapshot, ...patch}
            setSnapshot(next)
            stack.replace(next)
        },
        [snapshot, stack]
    )

    const mutate = useCallback(
        (label: string, change: (doc: Document) => Document) => {
            const doc = change(snapshot.doc)
            commit({...snapshot, doc}, label, doc !== snapshot.doc)
        },
        [snapshot, commit]
    )

    /**
     * Change the document and where the artist is in one commit.
     *
     * Doing it as `mutate` then `navigate` looks equivalent and is not: `navigate` spreads the
     * snapshot captured when the handler was created, so the second call would put the *old*
     * document back. Removing a frame has to move the cursor, so it has to go through here.
     */
    const mutateAndGo = useCallback(
        (
            label: string,
            change: (doc: Document) => Document,
            where: (doc: Document) => Partial<Pick<EditorSnapshot, 'slice' | 'layer' | 'frame'>>
        ) => {
            const doc = change(snapshot.doc)
            commit({...snapshot, doc, ...where(doc)}, label, doc !== snapshot.doc)
        },
        [snapshot, commit]
    )

    const actions = useMemo(
        () => ({
            copy: () => {
                setClipboard(copyToClipboard(snapshot))
            },
            cut: () => {
                setClipboard(copyToClipboard(snapshot))
                const result = deleteSelected(snapshot)
                commit(result.snapshot, 'cut', result.changed)
            },
            paste: () => {
                if (clipboard) {
                    const result = pasteAt(snapshot, clipboard)
                    commit(result.snapshot, 'paste', result.changed)
                }
            },
            remove: () => {
                const result = deleteSelected(snapshot)
                commit(result.snapshot, 'delete', result.changed)
            },
            selectAll: () => {
                navigate({selection: selectAll(snapshot).selection})
            },
            deselect: () => {
                navigate({selection: deselect(snapshot).selection})
            },
            addLayer: () => {
                mutate('add layer', doc => addLayer(doc))
            },
            removeLayer: () => {
                mutateAndGo(
                    'remove layer',
                    doc => removeLayer(doc, snapshot.layer),
                    doc => ({layer: Math.min(snapshot.layer, doc.layers.length - 1)})
                )
            },
            moveLayer: (to: number) => {
                mutateAndGo(
                    'reorder layers',
                    doc => moveLayer(doc, snapshot.layer, to),
                    () => ({layer: to})
                )
            },
            patchLayer: (index: number, patch: Partial<Omit<Layer, 'id' | 'cels'>>) => {
                mutate('layer settings', doc => updateLayer(doc, index, patch))
            },
            addFrame: () => {
                mutateAndGo(
                    'add frame',
                    doc => addFrame(doc, snapshot.frame + 1),
                    () => ({frame: snapshot.frame + 1})
                )
            },
            duplicateFrame: () => {
                mutateAndGo(
                    'duplicate frame',
                    doc => duplicateFrame(doc, snapshot.frame),
                    () => ({frame: snapshot.frame + 1})
                )
            },
            removeFrame: () => {
                mutateAndGo(
                    'remove frame',
                    doc => removeFrame(doc, snapshot.frame),
                    doc => ({frame: Math.min(snapshot.frame, doc.frames - 1)})
                )
            },
            addTag: (name: string, from: number, to: number) => {
                mutate('add tag', doc => addTag(doc, {name, from, to}))
            },
            updateTag: (name: string, patch: Partial<Tag>) => {
                mutate('edit tag', doc => updateTag(doc, name, patch))
            },
            removeTag: (name: string) => {
                mutate('remove tag', doc => removeTag(doc, name))
            },
            sortPalette: (by: SortKey) => {
                mutate(`sort palette by ${by}`, doc => sortPalette(doc, by))
            },
            setPalette: (palette: readonly Rgba[]) => {
                mutate('import palette', doc => setPalette(doc, palette))
            },
            gradientBetween: (a: number, b: number, byHue: boolean) => {
                mutate('palette gradient', doc => gradientBetween(doc, a, b, byHue))
            },
            addGradientRamp: (
                name: string,
                a: number,
                b: number,
                steps: number,
                byHue: boolean
            ) => {
                mutate('add ramp', doc => addGradientRamp(doc, name, a, b, steps, byHue))
            },
            removeRamp: (name: string) => {
                mutate('remove ramp', doc => removeRamp(doc, name))
            },
            mergeDuplicates: (tolerance: number) => {
                mutate('merge duplicate colours', doc => mergeDuplicates(doc, tolerance))
            },
            removeColor: (color: number) => {
                mutate('remove colour', doc =>
                    editCel(doc, snapshot.layer, snapshot.frame, volume => {
                        removeColor(volume, color)
                    })
                )
            },
            replaceColorInCel: (from: number, to: number) => {
                mutate('replace colour', doc =>
                    editCel(doc, snapshot.layer, snapshot.frame, volume => {
                        replaceColor(volume, from, to)
                    })
                )
            },
            copySliceTo: (to: number) => {
                mutateAndGo(
                    'copy slice',
                    doc =>
                        editCel(doc, snapshot.layer, snapshot.frame, volume => {
                            copySlice(volume, {size: doc.size}, snapshot.slice, to)
                        }),
                    () => ({slice: to})
                )
            },
            importModel: (model: VoxModel, name: string, origin?: DocumentOrigin) => {
                commit(initialSnapshot(documentFromModel(model, name, origin)), `import ${name}`)
            },
            importScene: (scene: VoxScene, name: string) => {
                commit(
                    initialSnapshot(
                        documentFromScene(scene.models, scene.layers, scene.modelLayer, name)
                    ),
                    `import ${name}`
                )
            },
            loadText: (text: string) => {
                commit(initialSnapshot(loadProject(text)), 'open project')
            },
            saveText: (): string => saveProject(snapshot.doc)
        }),
        [snapshot, clipboard, commit, mutate, mutateAndGo, navigate]
    )

    return {
        snapshot,
        settings,
        setSettings,
        clipboard,
        brush3d,
        pointerDown,
        pointerMove,
        pointerUp,
        pointerDown3d,
        pointerMove3d,
        pointerUp3d,
        undo,
        redo,
        navigate,
        mutate,
        actions,
        canUndo: history.canUndo,
        canRedo: history.canRedo,
        undoLabel: history.undoLabel,
        redoLabel: history.redoLabel,
        historyBytes: history.bytes
    }
}

export type Editor = ReturnType<typeof useEditor>
