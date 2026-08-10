import {expect, test} from 'bun:test'
import {eightDirections} from '../doc/cameras'
import {initialObjects} from '../doc/objects'
import {readVox} from '../vox/vox-file'
import {emptyMaps} from './empty'
import {renderSheet} from './sheet'

const volume = readVox(
    new Uint8Array(await Bun.file(new URL('../assets/car.vox', import.meta.url)).arrayBuffer())
)
initialObjects(volume)
const cameras = eightDirections(volume)

/** 32 px, which is the smallest the export offers: what is being asked is about values, not detail. */
const bake = () => renderSheet(volume, cameras, 32)

test('a model with nothing glowing and one object has an empty emission and object map', () => {
    // `car.vox` as MagicaVoxel wrote it: no emissive palette entry, and `initialObjects` puts the
    // whole thing in one object, which is what every freshly opened file looks like.
    expect([...emptyMaps(bake())].sort()).toEqual(['emission', 'object'])
})

test('one glowing palette entry is enough to fill the emission map', () => {
    const swatch = volume.data.find(index => index !== 0) ?? 1
    volume.emissive[swatch] = 255
    try {
        expect(emptyMaps(bake()).has('emission')).toBe(false)
    } finally {
        volume.emissive[swatch] = 0
    }
})

test('a second object fills the object map, and taking it away empties it again', () => {
    const at = volume.data.findIndex(index => index !== 0)
    try {
        volume.owner[at] = 2
        expect(emptyMaps(bake()).has('object')).toBe(false)
    } finally {
        volume.owner[at] = 1
    }
    expect(emptyMaps(bake()).has('object')).toBe(true)
})

/*
 * Absent and empty are different answers. A sheet baked without a map has nothing to say about it,
 * and reporting it blank would let the dialog grey out a map nobody had rendered yet.
 */
test('a map the sheet was never baked with is not reported as empty', () => {
    const colourOnly = renderSheet(volume, cameras, 32, ['color'])
    expect(emptyMaps(colourOnly).size).toBe(0)
})

/*
 * The other six are never reported. Colour and the geometry maps cannot be blank for anything with
 * voxels in it, and the palette index is data whatever the palette's size — an engine reading
 * indices wants the index, not an opinion about how many distinct ones there are.
 */
test('nothing but emission and object is ever reported', () => {
    const at = volume.data.findIndex(index => index !== 0)
    const swatch = volume.data[at] ?? 1
    volume.emissive[swatch] = 200
    volume.owner[at] = 2
    try {
        expect(emptyMaps(bake()).size).toBe(0)
    } finally {
        volume.emissive[swatch] = 0
        volume.owner[at] = 1
    }
})
