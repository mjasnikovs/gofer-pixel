import {AO_STEP} from './ao'
import {FACE_LIGHT, FACE_NORMAL_RGB, FACE_STEP, FACE_UV} from './faces'
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
 * Modes 0–5 are the exporter's six maps, byte for byte — they are what the parity test compares
 * against `RenderTarget`, so their encodings are fixed and cannot be chosen for how they look.
 * Two of them are data rather than pictures: depth is a 16-bit value split across two channels,
 * which on screen is a mess of contour stripes as the low byte wraps, and a voxel id is a palette
 * index, which on screen is a red ramp. The last two modes draw those same two quantities for a
 * human. Nothing exports them.
 */
export const MODE_COLOR = 0
export const MODE_NORMAL = 1
export const MODE_DEPTH = 2
export const MODE_ID = 3
export const MODE_AO = 4
export const MODE_EMISSION = 5
export const MODE_DEPTH_VIEW = 6
export const MODE_ID_VIEW = 7

export const VERTEX_SHADER = `#version 300 es
in vec2 aCorner;
void main(){ gl_Position = vec4(aCorner, 0.0, 1.0); }
`

/** GLSL has no implicit int-to-float conversion in a `float[]` initialiser, so `128` is not `128.0`. */
const glslFloat = (value: number): string =>
    Number.isInteger(value) ? `${String(value)}.0` : String(value)

const lightTable = Array.from(FACE_LIGHT, glslFloat).join(', ')
const normalTable = FACE_NORMAL_RGB.map(rgb => `vec3(${rgb.map(glslFloat).join(', ')})`).join(', ')
const stepTable = FACE_STEP.map(step => `ivec3(${step.map(String).join(', ')})`).join(', ')
const uvTable = FACE_UV.map(uv => `ivec2(${uv.map(String).join(', ')})`).join(', ')

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler3D;

uniform usampler3D uVolume;
uniform sampler2D uPalette;
uniform sampler2D uEmissive;
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
uniform int uEdges;

out vec4 fragColor;

const float BIG = ${glslFloat(BIG)};
const int MAX_STEPS = ${String(MAX_STEPS)};
const float LIGHT[7] = float[7](${lightTable});
const vec3 NORMAL[7] = vec3[7](${normalTable});
const ivec3 STEP[7] = ivec3[7](${stepTable});
const ivec2 UV[7] = ivec2[7](${uvTable});
const float AO_STEP = ${glslFloat(AO_STEP)};

/** Mirror of \`ao.ts\`. One is not the other's proof — the parity test is. */
bool solidAt(ivec3 cell){
    if (any(lessThan(cell, ivec3(0))) || any(greaterThanEqual(vec3(cell), uDim))) return false;
    return texelFetch(uVolume, cell, 0).r != 0u;
}

float aoCorner(bool s1, bool s2, bool d){
    if (s1 && s2) return 0.0;
    return 3.0 - float(s1) - float(s2) - float(d);
}

float occlusion(ivec3 cell, int face, float fu, float fv){
    ivec3 front = cell + STEP[face];
    ivec2 uv = UV[face];
    ivec3 du = ivec3(0); du[uv.x] = 1;
    ivec3 dv = ivec3(0); dv[uv.y] = 1;
    bool left = solidAt(front - du);
    bool right = solidAt(front + du);
    bool down = solidAt(front - dv);
    bool up = solidAt(front + dv);
    float c00 = aoCorner(left, down, solidAt(front - du - dv));
    float c10 = aoCorner(right, down, solidAt(front + du - dv));
    float c01 = aoCorner(left, up, solidAt(front - du + dv));
    float c11 = aoCorner(right, up, solidAt(front + du + dv));
    float bottom = c00 + (c10 - c00) * fu;
    float top = c01 + (c11 - c01) * fu;
    return floor((bottom + (top - bottom) * fv) * AO_STEP + 0.5);
}

/**
 * The voxel lattice, drawn on the face the ray struck. Viewport only, and off by default.
 *
 * A flat-shaded face is one tone across however many voxels it spans, so a wall reads as a single
 * slab and the artist cannot count cells on it. The alternative — an SVG overlay, the way
 * \`GroundGrid\` does it — cannot work here: those lines have to be occluded by the model they lie
 * on, and only the ray knows what it hit.
 *
 * It is therefore the one thing in this shader that the CPU raycaster does not mirror, and the
 * parity contract survives because \`uEdges\` is 0 everywhere except the viewport: nothing exports
 * it, and the parity test never turns it on.
 *
 * Width is held at about one device pixel — \`uScale\` is world units per pixel, so \`uScale\` *is* a
 * pixel in the units \`hitAt\` is measured in. The whole effect fades out below six pixels to the
 * voxel, where a line per cell stops being a lattice and becomes noise.
 */
vec3 lattice(vec3 lit, vec3 hitAt, int face){
    float perVoxel = 1.0 / uScale;
    float strength = smoothstep(6.0, 12.0, perVoxel);
    if (strength <= 0.0) return lit;
    ivec2 uv = UV[face];
    float u = clamp(hitAt[uv.x], 0.0, 1.0);
    float v = clamp(hitAt[uv.y], 0.0, 1.0);
    float edge = min(min(u, 1.0 - u), min(v, 1.0 - v));
    float line = (1.0 - smoothstep(uScale * 0.35, uScale * 1.1, edge)) * strength;
    // Dark voxels have no room to go darker, so on those the line is lifted instead. The pivot is
    // luminance rather than a fixed tint, so one rule covers a black model and a white one.
    float lum = dot(lit, vec3(0.299, 0.587, 0.114));
    vec3 ink = lum > 0.22 ? lit * 0.80 : lit + 0.08;
    return mix(lit, ink, line);
}

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
                vec3 lit = floor(rgb * LIGHT[face] / 256.0) / 255.0;
                if (uEdges != 0) lit = lattice(lit, org + f * (enter + walked) - cell, face);
                fragColor = vec4(lit, 1.0);
            } else if (uMode == ${String(MODE_NORMAL)}) {
                fragColor = vec4(NORMAL[face] / 255.0, 1.0);
            } else if (uMode == ${String(MODE_DEPTH)}) {
                float d = clamp((enter + walked) / uDepthRange, 0.0, 1.0) * 65535.0;
                fragColor = vec4(floor(d / 256.0) / 255.0, floor(mod(d, 256.0)) / 255.0, 0.0, 1.0);
            } else if (uMode == ${String(MODE_ID)}) {
                fragColor = vec4(float(value) / 255.0, 0.0, 0.0, 1.0);
            } else if (uMode == ${String(MODE_AO)}) {
                vec3 hitAt = org + f * (enter + walked) - cell;
                ivec2 uv = UV[face];
                float shade = occlusion(
                    ivec3(cell), face, clamp(hitAt[uv.x], 0.0, 1.0), clamp(hitAt[uv.y], 0.0, 1.0));
                fragColor = vec4(vec3(shade / 255.0), 1.0);
            } else if (uMode == ${String(MODE_EMISSION)}) {
                float glow = floor(texelFetch(uEmissive, ivec2(int(value), 0), 0).r * 255.0 + 0.5);
                fragColor = vec4(floor(rgb * glow / 255.0) / 255.0, 1.0);
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
