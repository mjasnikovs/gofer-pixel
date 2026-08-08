import {expect, test} from 'bun:test'
import {createVolume, setVoxel, voxelAt} from '../render/volume'
import {eightDirections} from './cameras'
import {initialObjects, setHidden} from './objects'
import {DEFAULT_OUTPUT, loadDocument, saveDocument, SAVE_VERSION, type Document} from './save'
import type {Reference} from './reference'
import {
    clearSnapshots,
    latestSnapshot,
    memoryStore,
    putSnapshot,
    SNAPSHOTS,
    snapshots
} from './store'

const PIXEL = 'data:image/png;base64,iVBORw0KGgo='

const document = (): Document => {
    const volume = createVolume(16, 10, 7, new Uint8Array(256 * 4))
    for (let x = 0; x < 16; x += 1) {
        setVoxel(volume, x, 0, 0, (x % 5) + 1)
        setVoxel(volume, x, 9, 6, 200)
    }
    volume.palette.set([12, 34, 56, 255], 4)
    volume.emissive[4] = 255
    const objects = setHidden(initialObjects(volume, 'Body'), 1, true)
    const references: readonly Reference[] = [{plane: 1, url: PIXEL, opacity: 0.4, locked: true}]
    return {
        volume,
        objects,
        cameras: eightDirections(volume),
        references,
        symmetry: {x: true, y: false, z: false, radial: false},
        output: {
            cell: 32,
            padding: 2,
            bounds: true,
            preset: 'Sprite Sheet (Auto)',
            presets: [{name: 'Mine', maps: ['color', 'normal']}]
        }
    }
}

test('a document survives being written down and read back, byte for byte', () => {
    const doc = document()
    const {volume, objects} = doc
    const back = loadDocument(JSON.stringify(saveDocument(doc, 'car.gpix', 7)))
    if (!back) throw new Error('the document we just wrote is one of ours')

    expect([back.volume.sx, back.volume.sy, back.volume.sz]).toEqual([16, 10, 7])
    expect(back.volume.data).toEqual(volume.data)
    expect(back.volume.owner).toEqual(volume.owner)
    expect(back.volume.palette).toEqual(volume.palette)
    expect(back.volume.emissive).toEqual(volume.emissive)
    expect(back.objects).toEqual(objects)
    expect(back.cameras).toHaveLength(8)
    expect(back.name).toBe('car.gpix')
    expect(back.at).toBe(7)
    expect(back.version).toBe(SAVE_VERSION)
    expect(voxelAt(back.volume, 3, 0, 0)).toBe(voxelAt(volume, 3, 0, 0))
})

test('what version 2 added comes back too', () => {
    const doc = document()
    const back = loadDocument(JSON.stringify(saveDocument(doc, 'car.gpix')))

    expect(back?.references).toEqual(doc.references)
    expect(back?.symmetry).toEqual(doc.symmetry)
    expect(back?.output).toEqual(doc.output)
})

test('a version 1 file still opens, with the fields it never had at their defaults', () => {
    const doc = document()
    const v2 = saveDocument(doc, 'old.gpix', 3)
    const {references, symmetry, output, ...rest} = v2
    const back = loadDocument(JSON.stringify({...rest, version: 1}))

    expect(back?.version).toBe(1)
    expect(back?.volume.data).toEqual(doc.volume.data)
    expect(back?.references).toEqual([])
    expect(back?.symmetry).toEqual({x: false, y: false, z: false, radial: false})
    expect(back?.output).toEqual(DEFAULT_OUTPUT)
})

/*
 * The reference is art to trace over, not the model — so a bad one is dropped and the voxels
 * survive. A bad grid is the opposite call, and the test above the next one holds that line.
 */
test('a reference that will not read is dropped rather than taking the file with it', () => {
    const doc = document()
    const saved = saveDocument(doc, 'car.gpix')
    const back = loadDocument(
        JSON.stringify({
            ...saved,
            references: [
                {plane: 7, url: PIXEL, opacity: 0.5, locked: false},
                // A dead object URL from somebody else's session, and an outbound request from a
                // document this artist did not write. Both refused.
                {plane: 0, url: 'blob:http://localhost:1430/8f3a', opacity: 0.5, locked: false},
                {plane: 0, url: 'https://example.com/a.png', opacity: 0.5, locked: false},
                {plane: 2, url: PIXEL, opacity: 2, locked: false},
                {plane: 2, url: PIXEL, opacity: 0.5, locked: false}
            ]
        })
    )

    expect(back?.references).toEqual([{plane: 2, url: PIXEL, opacity: 0.5, locked: false}])
    expect(back?.volume.data).toEqual(doc.volume.data)
})

test('the emptiness is counted rather than stored', () => {
    const doc = document()
    const text = JSON.stringify(saveDocument(doc, 'car.gpix'))
    // 1 120 cells of grid twice over, and the whole save — cameras, palette and all — is smaller
    // than the raw grid would be even before base64 inflated it by a third.
    expect(text.length).toBeLessThan(doc.volume.data.length * 2)
})

test('a run longer than a 16-bit count is split rather than lost', () => {
    const volume = createVolume(100, 100, 10, new Uint8Array(256 * 4))
    setVoxel(volume, 99, 99, 9, 3)
    const back = loadDocument(
        JSON.stringify(saveDocument({...document(), volume, cameras: []}, 'big.gpix'))
    )

    expect(back?.volume.data).toEqual(volume.data)
    expect(voxelAt(back?.volume ?? volume, 99, 99, 9)).toBe(3)
})

test('anything that is not one of ours is refused rather than half-loaded', () => {
    expect(loadDocument('not json')).toBeUndefined()
    expect(loadDocument('null')).toBeUndefined()
    expect(loadDocument('{"format":"something-else"}')).toBeUndefined()
    expect(loadDocument('{"format":"gofer-pixel/document","version":99}')).toBeUndefined()
    // Ours, but with the grid missing: a document that looks right with something quietly gone is
    // worse than one that does not open.
    expect(
        loadDocument('{"format":"gofer-pixel/document","version":1,"size":[2,2,2]}')
    ).toBeUndefined()
    expect(
        loadDocument('{"format":"gofer-pixel/document","version":1,"size":[0,2,2]}')
    ).toBeUndefined()
    // Export settings that will not read are refused, unlike a reference: a cell size of zero packs
    // a sheet of nothing, and the artist would find out at export time.
    expect(
        loadDocument(JSON.stringify({...saveDocument(document(), 'x.gpix'), output: {cell: 0}}))
    ).toBeUndefined()
})

test('snapshots rotate, newest first, and stop at the limit', () => {
    const store = memoryStore()
    const doc = document()

    for (let i = 1; i <= SNAPSHOTS + 3; i += 1) {
        putSnapshot(store, saveDocument(doc, `take ${String(i)}`, i))
    }

    const kept = snapshots(store)
    expect(kept).toHaveLength(SNAPSHOTS)
    expect(kept[0]?.at).toBe(SNAPSHOTS + 3)
    expect(kept.at(-1)?.at).toBe(4)
    // The name is read back without parsing a megabyte of base64 into a document.
    expect(kept[0]?.name).toBe(`take ${String(SNAPSHOTS + 3)}`)

    const newest = latestSnapshot(store)
    if (!newest) throw new Error('there is a newest snapshot')
    expect(loadDocument(newest)?.at).toBe(SNAPSHOTS + 3)

    clearSnapshots(store)
    expect(snapshots(store)).toHaveLength(0)
    expect(latestSnapshot(store)).toBeUndefined()
})

test('a store that refuses to write loses the new snapshot and keeps the old ones', () => {
    const backing = new Map<string, string>()
    const store = memoryStore(backing)
    const doc = document()
    putSnapshot(store, saveDocument(doc, 'kept', 1))

    const full = {...store, set: () => undefined}
    putSnapshot(full, saveDocument(doc, 'lost', 2))

    expect(snapshots(store)).toHaveLength(1)
    expect(snapshots(store)[0]?.name).toBe('kept')
})
