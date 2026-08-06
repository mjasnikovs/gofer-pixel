import {describe, expect, test} from 'bun:test'
import {
    addFrame,
    addLayer,
    addTag,
    celAt,
    createDocument,
    documentBytes,
    duplicateFrame,
    editCel,
    flattenFrame,
    frameToModel,
    moveLayer,
    removeFrame,
    removeLayer,
    removeTag,
    tagsAt,
    uniqueTagName,
    updateLayer,
    updateTag
} from './document'
import {frameToLayeredVox, frameToVox, frameToVoxScene} from './document'
import {readVox} from '../vox/vox-file'
import {readVoxScene} from '../vox/vox-scene'
import {packKey} from '../vox/model'
import {renderAngle} from '../vox/render'
import {Vox} from '../vox/grid'
import {Volume} from './volume'
import {PALETTE} from '../vox/palette'

const doc = () => createDocument({size: {sx: 16, sy: 16, sz: 16}, palette: PALETTE})

describe('document structure', () => {
    test('starts with one layer and one frame', () => {
        const d = doc()
        expect(d.layers.length).toBe(1)
        expect(d.frames).toBe(1)
        expect(celAt(d, 0, 0)).toBeNull()
    })

    test('editCel returns a new document and leaves the old one untouched', () => {
        const before = doc()
        const after = editCel(before, 0, 0, v =>
            v.fillBox({x0: 0, y0: 0, z0: 0, x1: 3, y1: 3, z1: 0}, 5)
        )

        expect(celAt(before, 0, 0)).toBeNull()
        expect(celAt(after, 0, 0)?.count).toBe(16)
        expect(after).not.toBe(before)
        expect(after.layers[0]?.id).toBe(before.layers[0]?.id ?? '')
    })

    test('a second edit does not disturb the first snapshot', () => {
        const one = editCel(doc(), 0, 0, v => v.set(1, 1, 1, 4))
        const two = editCel(one, 0, 0, v => v.set(2, 2, 2, 6))

        expect(celAt(one, 0, 0)?.count).toBe(1)
        expect(celAt(two, 0, 0)?.count).toBe(2)
        expect(celAt(one, 0, 0)?.get(2, 2, 2)).toBe(0)
    })

    test('a locked layer refuses edits', () => {
        const locked = updateLayer(doc(), 0, {locked: true})
        expect(editCel(locked, 0, 0, v => v.set(0, 0, 0, 1))).toBe(locked)
    })

    test('an out-of-range layer or frame is a no-op, not a crash', () => {
        const d = doc()
        expect(editCel(d, 5, 0, v => v.set(0, 0, 0, 1))).toBe(d)
        expect(editCel(d, 0, 3, v => v.set(0, 0, 0, 1))).toBe(d)
    })

    test('layers add, reorder and refuse to vanish entirely', () => {
        const three = addLayer(addLayer(doc(), 'b'), 'c')
        expect(three.layers.map(l => l.name)).toEqual(['Layer 1', 'b', 'c'])

        expect(moveLayer(three, 2, 0).layers.map(l => l.name)).toEqual(['c', 'Layer 1', 'b'])
        expect(removeLayer(three, 1).layers.map(l => l.name)).toEqual(['Layer 1', 'c'])

        const one = doc()
        expect(removeLayer(one, 0)).toBe(one)
    })

    test('a new layer gets a cel slot per existing frame', () => {
        const animated = addLayer(addFrame(addFrame(doc())), 'top')
        expect(animated.frames).toBe(3)
        expect(animated.layers[1]?.cels.length).toBe(3)
    })
})

describe('frames', () => {
    test('duplicateFrame shares the cel until one side is edited', () => {
        const drawn = editCel(doc(), 0, 0, v =>
            v.fillBox({x0: 0, y0: 0, z0: 0, x1: 7, y1: 7, z1: 7}, 3)
        )
        const copied = duplicateFrame(drawn, 0)

        expect(copied.frames).toBe(2)
        expect(celAt(copied, 0, 1)).toBe(celAt(copied, 0, 0))
        expect(documentBytes([copied])).toBe(documentBytes([drawn]))

        const edited = editCel(copied, 0, 1, v => v.set(0, 0, 0, 9))
        expect(celAt(edited, 0, 0)?.get(0, 0, 0)).toBe(3)
        expect(celAt(edited, 0, 1)?.get(0, 0, 0)).toBe(9)
    })

    test('inserting and removing frames moves the tags with them', () => {
        const tagged = addTag(addFrame(addFrame(addFrame(doc()))), {name: 'walk', from: 1, to: 3})

        expect(addFrame(tagged, 0).tags[0]).toEqual({name: 'walk', from: 2, to: 4})
        expect(removeFrame(tagged, 0).tags[0]).toEqual({name: 'walk', from: 0, to: 2})
    })

    test('a tag whose whole range is deleted goes away', () => {
        const tagged = addTag(addFrame(doc()), {name: 'blink', from: 1, to: 1})
        expect(removeFrame(tagged, 1).tags).toEqual([])
    })

    test('the last frame cannot be removed', () => {
        const d = doc()
        expect(removeFrame(d, 0)).toBe(d)
    })
})

describe('tags', () => {
    const fourFrames = () => addFrame(addFrame(addFrame(doc())))

    test('a range beyond the last frame is clamped, and a reversed one is put in order', () => {
        const d = fourFrames()
        expect(addTag(d, {name: 'walk', from: 2, to: 99}).tags[0]).toEqual({
            name: 'walk',
            from: 2,
            to: 3
        })
        expect(addTag(d, {name: 'walk', from: 3, to: 1}).tags[0]).toEqual({
            name: 'walk',
            from: 1,
            to: 3
        })
    })

    test('adding a tag whose name is taken replaces it', () => {
        const d = addTag(addTag(fourFrames(), {name: 'walk', from: 0, to: 1}), {
            name: 'walk',
            from: 2,
            to: 3
        })
        expect(d.tags).toEqual([{name: 'walk', from: 2, to: 3}])
    })

    test('updateTag moves a range and renames', () => {
        const d = addTag(fourFrames(), {name: 'walk', from: 0, to: 1})
        expect(updateTag(d, 'walk', {to: 3}).tags[0]).toEqual({name: 'walk', from: 0, to: 3})
        expect(updateTag(d, 'walk', {name: 'run'}).tags[0]).toEqual({
            name: 'run',
            from: 0,
            to: 1
        })
        expect(updateTag(d, 'missing', {to: 3})).toBe(d)
    })

    test('renaming onto a name that exists is refused', () => {
        const d = addTag(addTag(fourFrames(), {name: 'walk', from: 0, to: 1}), {
            name: 'idle',
            from: 2,
            to: 3
        })
        expect(updateTag(d, 'idle', {name: 'walk'})).toBe(d)
    })

    test('tagsAt reports every tag covering a frame', () => {
        let d = addTag(fourFrames(), {name: 'walk', from: 0, to: 2})
        d = addTag(d, {name: 'all', from: 0, to: 3})
        expect(tagsAt(d, 1).map(tag => tag.name)).toEqual(['walk', 'all'])
        expect(tagsAt(d, 3).map(tag => tag.name)).toEqual(['all'])
    })

    test('uniqueTagName avoids collisions', () => {
        const d = addTag(fourFrames(), {name: 'tag', from: 0, to: 0})
        expect(uniqueTagName(d)).toBe('tag 2')
        expect(uniqueTagName(addTag(d, {name: 'tag 2', from: 0, to: 0}))).toBe('tag 3')
    })

    test('removeTag drops it by name', () => {
        const d = addTag(fourFrames(), {name: 'walk', from: 0, to: 1})
        expect(removeTag(d, 'walk').tags).toEqual([])
        expect(removeTag(d, 'nope').tags.length).toBe(1)
    })
})

describe('composite', () => {
    test('a higher layer paints over a lower one, and an invisible layer paints nothing', () => {
        let d = addLayer(doc(), 'top')
        d = editCel(d, 0, 0, v => v.fillBox({x0: 0, y0: 0, z0: 0, x1: 3, y1: 3, z1: 0}, 5))
        d = editCel(d, 1, 0, v => v.set(0, 0, 0, 9))

        expect(flattenFrame(d, 0).get(0, 0, 0)).toBe(9)
        expect(flattenFrame(updateLayer(d, 1, {visible: false}), 0).get(0, 0, 0)).toBe(5)
    })

    test('a layer offset shifts its voxels', () => {
        const d = updateLayer(
            editCel(doc(), 0, 0, v => v.set(0, 0, 0, 7)),
            0,
            {offset: {x: 2, y: 3, z: 4}}
        )
        expect(flattenFrame(d, 0).get(2, 3, 4)).toBe(7)
    })

    test('frameToModel renders identically to the same shape built as a dense grid', () => {
        const vox = new Vox({sx: 16, sy: 16, sz: 16})
        vox.ellipsoid(8, 8, 8, 5, 4, 3, 7)
        vox.box(0, 0, 0, 15, 15, 0, 2)

        const d = editCel(doc(), 0, 0, v => {
            v.paste(Volume.fromVox(vox))
        })

        const fromDoc = renderAngle(frameToModel(d, 0), 30, {scale: 2})
        const fromGrid = renderAngle(
            {
                sx: 16,
                sy: 16,
                sz: 16,
                voxels: (() => {
                    const voxels = new Map<number, number>()
                    Volume.fromVox(vox).forEach((x, y, z, c) =>
                        voxels.set((x * 256 + y) * 256 + z, c)
                    )
                    return voxels
                })(),
                palette: PALETTE
            },
            30,
            {scale: 2}
        )

        expect(fromDoc.albedo.data).toEqual(fromGrid.albedo.data)
    })

    test('voxels pushed outside the canvas by an offset are dropped on export', () => {
        const d = updateLayer(
            editCel(doc(), 0, 0, v => v.set(1, 1, 1, 7)),
            0,
            {offset: {x: 100, y: 0, z: 0}}
        )
        expect(frameToModel(d, 0).voxels.size).toBe(0)
    })
})

describe('layered .vox export', () => {
    test('one model per layer, with names and visibility, and the voxels kept apart', () => {
        let d = addLayer(doc(), 'top')
        d = updateLayer(d, 1, {visible: false})
        d = editCel(d, 0, 0, v => {
            v.set(1, 1, 1, 4)
        })
        d = editCel(d, 1, 0, v => {
            v.set(2, 2, 2, 6)
        })

        const scene = frameToVoxScene(d, 0)
        expect(scene.map(entry => entry.name)).toEqual(['Layer 1', 'top'])
        expect(scene.map(entry => entry.hidden)).toEqual([false, true])
        expect(scene[0]?.model.voxels.size).toBe(1)
        expect(scene[1]?.model.voxels.size).toBe(1)

        const read = readVoxScene(frameToLayeredVox(d, 0))
        expect(read.models.length).toBe(2)
        expect(read.layers.map(layer => layer.name)).toEqual(['Layer 1', 'top'])
        expect(read.layers[1]?.hidden).toBe(true)
        expect(read.models[0]?.voxels.get(packKey(1, 1, 1))).toBe(4)
        expect(read.models[1]?.voxels.get(packKey(2, 2, 2))).toBe(6)
    })

    test('the flat export still flattens, so both paths stay available', () => {
        let d = addLayer(doc(), 'top')
        d = editCel(d, 0, 0, v => {
            v.set(1, 1, 1, 4)
        })
        d = editCel(d, 1, 0, v => {
            v.set(2, 2, 2, 6)
        })
        expect(readVox(frameToVox(d, 0)).voxels.size).toBe(2)
        expect(readVoxScene(frameToLayeredVox(d, 0)).models.length).toBe(2)
    })

    test('a layer offset becomes the model transform', () => {
        let d = addLayer(doc(), 'shifted')
        d = updateLayer(d, 1, {offset: {x: 1, y: 2, z: 3}})
        d = editCel(d, 1, 0, v => {
            v.set(0, 0, 0, 5)
        })
        expect(frameToVoxScene(d, 0)[1]?.offset).toEqual([1, 2, 3])
    })
})
