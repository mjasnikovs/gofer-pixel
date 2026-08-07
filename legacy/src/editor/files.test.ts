import {describe, expect, test} from 'bun:test'
import {createDocument} from '../doc/document'
import {saveProject} from '../doc/serialize'
import {writeVox} from '../vox/vox-file'
import {DEFAULT_PALETTE, packKey, type VoxModel} from '../vox/model'
import {toGpl, toHex, toPal, toStrip} from '../doc/palette-formats'
import {encodePng} from '../image/png'
import type {Rgba} from '../vox/palette'
import {baseName, isVoxBytes, readImport, readPalette} from './files'

const encoder = new TextEncoder()

const sample: Rgba[] = [
    {r: 0, g: 0, b: 0, a: 255},
    {r: 255, g: 64, b: 0, a: 255},
    {r: 12, g: 200, b: 190, a: 255}
]

const model = (): VoxModel => ({
    sx: 4,
    sy: 4,
    sz: 4,
    voxels: new Map([[packKey(1, 1, 1), 2]]),
    palette: DEFAULT_PALETTE
})

describe('baseName', () => {
    test('drops directories and the extension', () => {
        expect(baseName('out/truck/best.vox')).toBe('best')
        expect(baseName('car.vox')).toBe('car')
        expect(baseName('noext')).toBe('noext')
    })
})

describe('readImport', () => {
    test('recognises a .vox by its magic bytes, whatever it is called', () => {
        const file = readImport('anything.bin', writeVox(model()))
        expect(file.kind).toBe('vox')
        if (file.kind === 'vox') {
            expect(file.name).toBe('anything')
            expect(file.model.voxels.size).toBe(1)
        }
    })

    test('recognises a saved project', () => {
        const text = saveProject(createDocument({name: 'demo'}))
        const file = readImport('demo.json', encoder.encode(text))
        expect(file.kind).toBe('project')
        if (file.kind === 'project') {
            expect(file.text).toBe(text)
        }
    })

    test('a project named .vox is reported as a project, not parsed as a model', () => {
        const bytes = encoder.encode(saveProject(createDocument()))
        expect(readImport('mislabelled.vox', bytes).kind).toBe('project')
    })

    test('anything else fails with the file name in the message', () => {
        expect(() => readImport('notes.txt', encoder.encode('hello'))).toThrow('notes.txt')
    })

    test('a palette file is not a document', () => {
        expect(() => readImport('lospec.gpl', encoder.encode(toGpl(sample)))).toThrow('lospec.gpl')
    })

    test('isVoxBytes needs the whole magic', () => {
        expect(isVoxBytes(new Uint8Array([0x56, 0x4f, 0x58]))).toBe(false)
        expect(isVoxBytes(writeVox(model()))).toBe(true)
    })
})

describe('readPalette', () => {
    test('reads every text format', async () => {
        for (const [name, text] of [
            ['a.gpl', toGpl(sample)],
            ['a.hex', toHex(sample)],
            ['a.pal', toPal(sample)]
        ] as [string, string][]) {
            expect(await readPalette(name, encoder.encode(text))).toEqual(sample)
        }
    })

    test('reads a PNG strip', async () => {
        expect(await readPalette('strip.png', await encodePng(toStrip(sample, 4)))).toEqual(sample)
    })

    test('an empty file fails with its name', async () => {
        let message = ''
        try {
            await readPalette('empty.hex', encoder.encode(''))
        } catch (error) {
            message = String(error)
        }
        expect(message).toContain('empty.hex')
    })
})
