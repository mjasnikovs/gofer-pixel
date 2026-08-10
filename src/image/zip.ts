import {crc32} from './png'

/**
 * A zip writer with no dependencies and no compression.
 *
 * Store-only, deliberately. Everything that goes in an export pack is either a PNG — already
 * deflated by `encodePng` — or a few kilobytes of JSON, so a second deflate pass buys single-digit
 * bytes on the one and costs a `CompressionStream` per entry on both. What the pack is for is
 * *one file instead of nine*, not a smaller file.
 *
 * The format is PKZIP's original: a local header in front of every entry, a central directory
 * listing them all, and an end-of-central-directory record pointing at it. No zip64, so a pack is
 * capped at 4 GB and 65535 entries, which is four orders of magnitude past a sprite sheet.
 */
export interface ZipEntry {
    /** The path inside the archive. Flat here — `sprites.png`, not `color/sprites.png`. */
    readonly name: string
    readonly bytes: Uint8Array
}

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const END_SIG = 0x06054b50

/** PKZIP 2.0, which is the version that introduced everything used here and nothing that is not. */
const VERSION = 20

/** Bit 11: the name is UTF-8. Set unconditionally, because the alternative is CP437. */
const UTF8_NAME = 0x0800

/** Stored, not deflated. */
const STORE = 0

/**
 * MS-DOS time and date, which is what a zip carries instead of a real timestamp.
 *
 * Two seconds of resolution and an epoch of 1980, both of them the format's. A date before 1980
 * cannot be written at all, so it clamps rather than wrapping into a year some unarchiver reads as
 * 2076.
 */
const dosStamp = (at: Date): {time: number; date: number} => {
    const year = Math.max(1980, at.getFullYear())
    return {
        time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
        date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()
    }
}

interface Placed extends ZipEntry {
    readonly name8: Uint8Array
    readonly crc: number
    /** Where this entry's local header starts, which is what the central directory records. */
    readonly at: number
}

export const zip = (entries: readonly ZipEntry[], at: Date = new Date()): Uint8Array => {
    const {time, date} = dosStamp(at)
    const encoder = new TextEncoder()

    /*
     * Sized before anything is written. Every part of a zip is fixed-width apart from the names and
     * the payloads, so the total is arithmetic rather than a growing array — which matters because
     * a pack of eight 128 px sheets is several megabytes and `[...a, ...b]` over that is a copy per
     * entry.
     */
    const named = entries.map(entry => ({...entry, name8: encoder.encode(entry.name)}))
    const localSize = named.reduce((sum, e) => sum + 30 + e.name8.length + e.bytes.length, 0)
    const centralSize = named.reduce((sum, e) => sum + 46 + e.name8.length, 0)
    const out = new Uint8Array(localSize + centralSize + 22)
    const view = new DataView(out.buffer)

    let cursor = 0
    const placed: Placed[] = named.map(entry => {
        const start = cursor
        const crc = crc32(entry.bytes)
        view.setUint32(cursor, LOCAL_SIG, true)
        view.setUint16(cursor + 4, VERSION, true)
        view.setUint16(cursor + 6, UTF8_NAME, true)
        view.setUint16(cursor + 8, STORE, true)
        view.setUint16(cursor + 10, time, true)
        view.setUint16(cursor + 12, date, true)
        view.setUint32(cursor + 14, crc, true)
        // Stored, so the compressed and uncompressed sizes are the same number twice.
        view.setUint32(cursor + 18, entry.bytes.length, true)
        view.setUint32(cursor + 22, entry.bytes.length, true)
        view.setUint16(cursor + 26, entry.name8.length, true)
        view.setUint16(cursor + 28, 0, true)
        out.set(entry.name8, cursor + 30)
        out.set(entry.bytes, cursor + 30 + entry.name8.length)
        cursor += 30 + entry.name8.length + entry.bytes.length
        return {...entry, crc, at: start}
    })

    const directory = cursor
    for (const entry of placed) {
        view.setUint32(cursor, CENTRAL_SIG, true)
        view.setUint16(cursor + 4, VERSION, true)
        view.setUint16(cursor + 6, VERSION, true)
        view.setUint16(cursor + 8, UTF8_NAME, true)
        view.setUint16(cursor + 10, STORE, true)
        view.setUint16(cursor + 12, time, true)
        view.setUint16(cursor + 14, date, true)
        view.setUint32(cursor + 16, entry.crc, true)
        view.setUint32(cursor + 20, entry.bytes.length, true)
        view.setUint32(cursor + 24, entry.bytes.length, true)
        view.setUint16(cursor + 28, entry.name8.length, true)
        // No extra field, no comment, one disk, no attributes: a sprite pack has no use for any of
        // them and every one written is a byte an unarchiver has to be told to ignore.
        view.setUint16(cursor + 30, 0, true)
        view.setUint16(cursor + 32, 0, true)
        view.setUint16(cursor + 34, 0, true)
        view.setUint16(cursor + 36, 0, true)
        view.setUint32(cursor + 38, 0, true)
        view.setUint32(cursor + 42, entry.at, true)
        out.set(entry.name8, cursor + 46)
        cursor += 46 + entry.name8.length
    }

    view.setUint32(cursor, END_SIG, true)
    view.setUint16(cursor + 4, 0, true)
    view.setUint16(cursor + 6, 0, true)
    view.setUint16(cursor + 8, placed.length, true)
    view.setUint16(cursor + 10, placed.length, true)
    view.setUint32(cursor + 12, cursor - directory, true)
    view.setUint32(cursor + 16, directory, true)
    view.setUint16(cursor + 20, 0, true)

    return out
}
