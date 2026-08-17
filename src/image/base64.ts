/**
 * Bytes to base64 and back, chunked.
 *
 * One line of it is the whole reason this is a module: `String.fromCharCode(...bytes)` on a
 * megabyte blows the argument stack, so the loop below walks the buffer in 32 KB pieces. That fact
 * was written down twice — in `doc/save.ts`, which encodes whole documents, and in the generator's
 * `veto.ts`, which encoded a PNG for the naming judge — character for character, with the same
 * comment on both. Two copies of a workaround is one copy nobody will remember to fix.
 *
 * The second caller went with `src/gen/`. One is left, and the module stays: the argument-stack
 * limit is a property of the platform, not of how many places happen to hit it today.
 *
 * It lives beside the PNG encoder because binary into something a JSON body can carry is what both
 * of them were for.
 */

const CHUNK = 0x8000

export const toBase64 = (bytes: Uint8Array): string => {
    let binary = ''
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    return btoa(binary)
}

export const fromBase64 = (text: string): Uint8Array => {
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
}
