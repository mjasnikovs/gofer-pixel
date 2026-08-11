import {expect, test} from 'bun:test'
import {createVolume, setVoxel} from '../render/volume'
import {eightDirections} from './cameras'
import {MODEL_ACCEPT, volumeFromFile} from './models'
import {initialObjects} from './objects'
import {DEFAULT_OUTPUT, saveDocument, type Document} from './save'

const carBytes = async (): Promise<Uint8Array> => {
    const found = Bun.file(new URL('../assets/car.vox', import.meta.url))
    return new Uint8Array(await found.arrayBuffer())
}

/** A `.gpix` as bytes, which is what every caller of `volumeFromFile` actually holds. */
const gpixBytes = (): Uint8Array => {
    const volume = createVolume(4, 5, 6)
    setVoxel(volume, 1, 1, 1, 3)
    const doc: Document = {
        volume,
        objects: initialObjects(volume),
        cameras: eightDirections(volume),
        references: [],
        symmetry: {x: false, y: false, z: false, radial: false},
        output: DEFAULT_OUTPUT,
        origin: undefined
    }
    return new TextEncoder().encode(JSON.stringify(saveDocument(doc, 'x.gpix', 7)))
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

test('the extension decides the decoder, and the case is the artist’s', async () => {
    const vox = await carBytes()
    expect(volumeFromFile('car.vox', vox)?.data.length).toBeGreaterThan(0)
    expect(volumeFromFile('CAR.VOX', vox)).toBeDefined()
    expect(volumeFromFile('X.GPIX', gpixBytes())).toBeDefined()
})

/*
 * A `.vox` is a RIFF container, so anything that is not one throws somewhere inside the reader
 * rather than returning. `undefined` is the whole contract: no caller may see the throw, because
 * all three of them are handed a file the artist picked off their own disk.
 */
test('bytes that are not a .vox come back undefined, not thrown', () => {
    expect(volumeFromFile('car.vox', bytesOf('this is not a model'))).toBeUndefined()
    expect(volumeFromFile('car.vox', new Uint8Array(0))).toBeUndefined()
    // A real `.gpix` under the wrong name is still not a `.vox`. Guessing is not on offer.
    expect(volumeFromFile('x.vox', gpixBytes())).toBeUndefined()
})

test('a .gpix reads through the document loader, and junk in one is undefined', () => {
    const back = volumeFromFile('x.gpix', gpixBytes())
    expect([back?.sx, back?.sy, back?.sz]).toEqual([4, 5, 6])
    expect(volumeFromFile('x.gpix', bytesOf('{}'))).toBeUndefined()
    expect(volumeFromFile('x.gpix', bytesOf('not json'))).toBeUndefined()
})

test('an extension we do not read is undefined rather than a guess', async () => {
    const vox = await carBytes()
    expect(volumeFromFile('car.png', vox)).toBeUndefined()
    expect(volumeFromFile('car', vox)).toBeUndefined()
    expect(MODEL_ACCEPT.split(',')).toEqual(['.vox', '.gpix'])
})
