import {FACE_LIGHT, FACE_NORMAL_RGB} from './faces'
import {BIG, MAX_STEPS} from './raycast'

/**
 * The raycaster again, as a fragment shader, for the viewport only.
 *
 * It is a line-for-line mirror of `raycast.ts` and is held to that by a browser test that renders
 * both and compares bytes. Where the two look different — `mix(…, zero)` instead of a ternary,
 * `bvec3` instead of three booleans — the arithmetic is identical; where they would actually
 * differ, they do not, because:
 *
 * - the camera basis is computed once on the CPU and uploaded, so no trigonometry runs twice;
 * - a zero direction component uses the same finite `BIG` sentinel, never `Infinity`;
 * - the light and normal tables below are generated from `faces.ts`, so they cannot drift;
 * - every colour is integer arithmetic small enough to be exact in float32.
 *
 * The framebuffer's row 0 is the bottom and `RenderTarget`'s is the top. That is the one difference
 * the parity test has to reconcile, and it is why `py` here is `gl_FragCoord.y` rather than a row.
 */

/**
 * What a draw writes into the RGBA8 framebuffer. One draw per map.
 *
 * Modes 0–3 are the exporter's four maps, byte for byte — they are what the parity test compares
 * against `RenderTarget`, so their encodings are fixed and cannot be chosen for how they look.
 * Two of them are data rather than pictures: depth is a 16-bit value split across two channels,
 * which on screen is a mess of contour stripes as the low byte wraps, and a voxel id is a palette
 * index, which on screen is a red ramp. Modes 4 and 5 draw those same two quantities for a human.
 * Nothing exports them.
 */
export const MODE_COLOR = 0
export const MODE_NORMAL = 1
export const MODE_DEPTH = 2
export const MODE_ID = 3
export const MODE_DEPTH_VIEW = 4
export const MODE_ID_VIEW = 5

export const VERTEX_SHADER = `#version 300 es
in vec2 aCorner;
void main(){ gl_Position = vec4(aCorner, 0.0, 1.0); }
`

/** GLSL has no implicit int-to-float conversion in a `float[]` initialiser, so `128` is not `128.0`. */
const glslFloat = (value: number): string =>
    Number.isInteger(value) ? `${String(value)}.0` : String(value)

const lightTable = Array.from(FACE_LIGHT, glslFloat).join(', ')
const normalTable = FACE_NORMAL_RGB.map(rgb => `vec3(${rgb.map(glslFloat).join(', ')})`).join(', ')

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler3D;

uniform usampler3D uVolume;
uniform sampler2D uPalette;
uniform vec3 uForward;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uCenter;
uniform vec3 uDim;
uniform float uScale;
uniform float uDist;
uniform float uDepthRange;
uniform float uWidth;
uniform float uHeight;
uniform int uMode;

out vec4 fragColor;

const float BIG = ${glslFloat(BIG)};
const int MAX_STEPS = ${String(MAX_STEPS)};
const float LIGHT[7] = float[7](${lightTable});
const vec3 NORMAL[7] = vec3[7](${normalTable});

void main(){
    float px = gl_FragCoord.x - 0.5;
    float py = gl_FragCoord.y - 0.5;
    float a = (px - uWidth * 0.5 + 0.5) * uScale;
    float b = (py - uHeight * 0.5 + 0.5) * uScale;
    vec3 org = uCenter + uRight * a + uUp * b - uForward * uDist;

    vec3 f = uForward;
    bvec3 isZero = equal(f, vec3(0.0));
    vec3 safeF = mix(f, vec3(1.0), isZero);
    vec3 near = mix((vec3(0.0) - org) / safeF, vec3(-BIG), isZero);
    vec3 far = mix((uDim - org) / safeF, vec3(BIG), isZero);
    vec3 lo = min(near, far);
    vec3 hi = max(near, far);
    float tmin = max(max(lo.x, lo.y), lo.z);
    float tmax = min(min(hi.x, hi.y), hi.z);

    fragColor = vec4(0.0);
    if (tmax < max(tmin, 0.0)) return;

    int faceX = f.x > 0.0 ? 1 : 2;
    int faceY = f.y > 0.0 ? 3 : 4;
    int faceZ = f.z > 0.0 ? 5 : 6;
    int face = faceX;
    float entryT = lo.x;
    if (lo.y > entryT) { entryT = lo.y; face = faceY; }
    if (lo.z > entryT) { face = faceZ; }

    float enter = max(tmin, 0.0) + 1e-4;
    float walked = 0.0;
    vec3 q = org + f * enter;
    vec3 cell = floor(q);
    vec3 stride = vec3(f.x > 0.0 ? 1.0 : -1.0, f.y > 0.0 ? 1.0 : -1.0, f.z > 0.0 ? 1.0 : -1.0);
    vec3 delta = mix(abs(1.0 / safeF), vec3(BIG), isZero);
    vec3 next = mix(vec3(
        (f.x > 0.0 ? cell.x + 1.0 - q.x : q.x - cell.x) * delta.x,
        (f.y > 0.0 ? cell.y + 1.0 - q.y : q.y - cell.y) * delta.y,
        (f.z > 0.0 ? cell.z + 1.0 - q.z : q.z - cell.z) * delta.z), vec3(BIG), isZero);

    for (int step = 0; step < MAX_STEPS; step++){
        if (any(lessThan(cell, vec3(0.0))) || any(greaterThanEqual(cell, uDim))) return;
        uint value = texelFetch(uVolume, ivec3(cell), 0).r;
        if (value != 0u){
            vec3 rgb = floor(texelFetch(uPalette, ivec2(int(value), 0), 0).rgb * 255.0 + 0.5);
            if (uMode == ${String(MODE_COLOR)}) {
                fragColor = vec4(floor(rgb * LIGHT[face] / 256.0) / 255.0, 1.0);
            } else if (uMode == ${String(MODE_NORMAL)}) {
                fragColor = vec4(NORMAL[face] / 255.0, 1.0);
            } else if (uMode == ${String(MODE_DEPTH)}) {
                float d = clamp((enter + walked) / uDepthRange, 0.0, 1.0) * 65535.0;
                fragColor = vec4(floor(d / 256.0) / 255.0, floor(mod(d, 256.0)) / 255.0, 0.0, 1.0);
            } else if (uMode == ${String(MODE_ID)}) {
                fragColor = vec4(float(value) / 255.0, 0.0, 0.0, 1.0);
            } else if (uMode == ${String(MODE_DEPTH_VIEW)}) {
                // Stretched across the volume's own diagonal rather than across the depth range:
                // the model occupies a sliver of that range, and the sliver would be one flat grey.
                float spread = length(uDim);
                float near = uDist - spread * 0.5;
                float grey = 1.0 - clamp(((enter + walked) - near) / spread, 0.0, 1.0);
                fragColor = vec4(vec3(grey), 1.0);
            } else {
                fragColor = vec4(rgb / 255.0, 1.0);
            }
            return;
        }
        if (next.x < next.y && next.x < next.z){
            cell.x += stride.x; walked = next.x; next.x += delta.x; face = faceX;
        } else if (next.y < next.z){
            cell.y += stride.y; walked = next.y; next.y += delta.y; face = faceY;
        } else {
            cell.z += stride.z; walked = next.z; next.z += delta.z; face = faceZ;
        }
    }
}
`
