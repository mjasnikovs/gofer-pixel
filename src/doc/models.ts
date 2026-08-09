import type {Volume} from '../render/volume'
import {readVox} from '../vox/vox-file'
import {loadDocument} from './save'

/**
 * Bytes off a disk into a `Volume`, whichever of the two model formats they are.
 *
 * One function rather than a branch at each call site, because there are now three: the file
 * picker, the worked-example bank and the drop target on the generate dialog. All three have to
 * agree about what "a model file" is.
 *
 * The extension decides which decoder is tried, and only that one. A `.vox` is a RIFF container
 * full of arbitrary bytes; read as text and re-encoded it would corrupt everything above `0x7f`
 * quietly, so guessing is not on offer. `undefined` for anything that will not read.
 */
export const volumeFromFile = (name: string, bytes: Uint8Array): Volume | undefined => {
    const lower = name.toLowerCase()
    if (lower.endsWith('.vox')) {
        try {
            return readVox(bytes)
        } catch {
            // Not a `.vox` whatever it was called.
            return undefined
        }
    }
    if (!lower.endsWith('.gpix')) return undefined
    return loadDocument(new TextDecoder().decode(bytes))?.volume
}

/** The extensions `volumeFromFile` will read, as an `<input accept>` takes them. */
export const MODEL_ACCEPT = '.vox,.gpix'
