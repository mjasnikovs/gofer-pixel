/**
 * The six faces of a voxel, and the two tables that turn a face into pixels.
 *
 * Both backends read these. The GLSL is generated from them (`raycast.glsl.ts`), so a face's
 * colour or normal cannot drift between the CPU exporter and the viewport by editing one and
 * forgetting the other.
 *
 * A face code names the direction the visible surface points, not the direction the ray moved:
 * stepping in `+x` enters a cell through its `-x` side, so the face on screen is `X_NEG`.
 */
export const FACE_X_NEG = 1
export const FACE_X_POS = 2
export const FACE_Y_NEG = 3
export const FACE_Y_POS = 4
export const FACE_Z_NEG = 5
export const FACE_Z_POS = 6

/**
 * Flat per-face light, as an integer numerator over 256.
 *
 * Integer, and over a power of two, because this is the arithmetic that has to give the same byte
 * on both backends: `floor(channel * light / 256)` is exact in float32 for every input here
 * (`255 * 256` is far below the 2²⁴ where float32 stops counting), so the shader and the exporter
 * land on the same colour rather than on two colours a rounding mode apart.
 *
 * Voxel art wants flat faces, not a gradient — this is the whole lighting model, and there is
 * deliberately no light direction. `+z` is up, which is what `.vox` means by z.
 */
export const FACE_LIGHT = new Uint16Array([
    0, // unused: face codes are 1-based
    128, // -x
    208, // +x
    152, // -y
    176, // +y
    96, // -z, the underside
    256 // +z, the top
])

/**
 * The face normal, already encoded the way it is written to the normal map: `-1 → 0`, `0 → 128`,
 * `+1 → 255`. Stored encoded rather than as a vector so that neither backend has to round — the
 * shader emits these bytes directly and the exporter copies them.
 */
export const FACE_NORMAL_RGB: readonly (readonly [number, number, number])[] = [
    [128, 128, 128], // unused
    [0, 128, 128], // -x
    [255, 128, 128], // +x
    [128, 0, 128], // -y
    [128, 255, 128], // +y
    [128, 128, 0], // -z
    [128, 128, 255] // +z
]

/** The same table flat, three bytes per face, indexed `face * 3`. */
export const FACE_NORMAL = new Uint8Array(FACE_NORMAL_RGB.flat())
