import {expect, test} from 'bun:test'
import {crc32} from './png'
import {zip} from './zip'

/**
 * The archive is read back the way an unarchiver reads one: find the end-of-central-directory
 * record, walk the directory it points at, and take every entry's bytes from the offset the
 * *directory* recorded — never from the order they happened to be written in.
 *
 * That direction is the whole point of the test. An encoder that writes its own local headers and
 * is then checked by walking those same local headers cannot catch the one mistake that actually
 * breaks a zip, which is a central directory pointing at the wrong place.
 */
const unzip = (bytes: Uint8Array): {name: string; bytes: Uint8Array; crc: number}[] => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const end = bytes.length - 22
    expect(view.getUint32(end, true)).toBe(0x06054b50)
    const count = view.getUint16(end + 10, true)
    let cursor = view.getUint32(end + 16, true)
    const decoder = new TextDecoder()

    const out: {name: string; bytes: Uint8Array; crc: number}[] = []
    for (let i = 0; i < count; i += 1) {
        expect(view.getUint32(cursor, true)).toBe(0x02014b50)
        const crc = view.getUint32(cursor + 16, true)
        const size = view.getUint32(cursor + 24, true)
        const nameLength = view.getUint16(cursor + 28, true)
        const at = view.getUint32(cursor + 42, true)
        const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))

        // Follow the offset into the local header and check it agrees about who lives there.
        expect(view.getUint32(at, true)).toBe(0x04034b50)
        const localName = view.getUint16(at + 26, true)
        const extra = view.getUint16(at + 28, true)
        const from = at + 30 + localName + extra
        out.push({name, crc, bytes: bytes.subarray(from, from + size)})
        cursor += 46 + nameLength
    }
    return out
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

/*
 * The standard check value: CRC-32/ISO-HDLC of the nine ASCII digits is 0xCBF43926. It is here
 * rather than in `png.test.ts` because a wrong table still produces a PNG every decoder accepts —
 * libpng warns and carries on — while a wrong CRC in a zip is a refusal.
 */
test('the checksum is the standard CRC-32, against the standard check value', () => {
    expect(crc32(bytesOf('123456789'))).toBe(0xcbf43926)
})

test('every entry comes back through the central directory, byte for byte', () => {
    const one = bytesOf('{"format":"gofer-pixel/sheet"}')
    const two = Uint8Array.from({length: 5000}, (_, i) => i & 0xff)
    const archive = zip([
        {name: 'sprites.json', bytes: one},
        {name: 'sprites.png', bytes: two}
    ])

    const back = unzip(archive)
    expect(back.map(entry => entry.name)).toEqual(['sprites.json', 'sprites.png'])
    expect(back[0]?.bytes).toEqual(one)
    expect(back[1]?.bytes).toEqual(two)
    expect(back[0]?.crc).toBe(crc32(one))
    expect(back[1]?.crc).toBe(crc32(two))
})

test('nothing is compressed, so the archive is its contents plus its bookkeeping', () => {
    const payload = new Uint8Array(1024)
    const archive = zip([{name: 'sprites-normal.png', bytes: payload}])
    // 30 + name + payload, then 46 + name, then 22. Store-only is what makes this arithmetic.
    expect(archive.length).toBe(30 + 18 + 1024 + (46 + 18) + 22)
})

/*
 * An empty pack is still a valid archive rather than zero bytes. It cannot happen through the export
 * dialog — colour is always written — but a zip writer that produces a truncated file for the empty
 * case is one that produces a truncated file the first time a caller filters everything out.
 */
test('an archive with nothing in it is still an archive', () => {
    const archive = zip([])
    expect(archive.length).toBe(22)
    expect(unzip(archive)).toEqual([])
})

/*
 * MS-DOS packs the date into 16 bits with an epoch of 1980, so there is no way to write an earlier
 * one. Clamping keeps a bad clock out of the file; wrapping would put 2076 in it.
 */
test('a date before the format’s epoch clamps instead of wrapping', () => {
    const archive = zip([{name: 'a', bytes: new Uint8Array(0)}], new Date(1970, 0, 1))
    const view = new DataView(archive.buffer)
    expect(view.getUint16(12, true) >> 9).toBe(0)
})
