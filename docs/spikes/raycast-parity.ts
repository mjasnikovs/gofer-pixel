// Unknown #1: does a TypeScript raycast and a GLSL raycast agree, on the SAME scene,
// with the SAME camera, pixel for pixel?
//
// Design that gives them the best chance: the camera basis is computed once on the CPU and
// uploaded as uniforms, so no trig runs twice. The only remaining divergence source is
// float64 (JS) against highp float32 (GLSL) inside the DDA itself.
import {chromium} from 'playwright'

const N = 32
const W = 128
const H = 128

const buildVolume = (): Uint8Array => {
    const g = new Uint8Array(N * N * N)
    const c = (N - 1) / 2
    for (let z = 0; z < N; z++)
        for (let y = 0; y < N; y++)
            for (let x = 0; x < N; x++) {
                const d = Math.hypot(x - c, y - c, z - c)
                // sphere with a bite out of it and a few floating cubes: lots of silhouette edges,
                // which is exactly where two raycasters disagree if they are going to
                const inSphere = d < N * 0.4
                const bite = x > c && y > c && z > c && d < N * 0.32
                const cube = x > 3 && x < 8 && y > 24 && y < 29 && z > 3 && z < 8
                if ((inSphere && !bite) || cube) g[(z * N + y) * N + x] = 1 + ((x * 5 + y * 3 + z) % 200)
            }
    return g
}

/** Camera basis, computed once, shared by both backends. */
const camera = (yaw: number, pitch: number) => {
    const cy = Math.cos(yaw)
    const sy = Math.sin(yaw)
    const cp = Math.cos(pitch)
    const sp = Math.sin(pitch)
    // snap: cos(pi/2) is 6.1e-17 in float64 and something else in float32, so an "axis-aligned"
    // camera is not actually axis-aligned and 1/dir explodes differently on each side.
    // fround: the GPU receives these as float32 uniforms, so the CPU must start from the same bits.
    const s32 = (v: number): number => Math.fround(Math.abs(v) < 1e-6 ? 0 : v)
    return {
        f: [s32(-sy * cp), s32(-cy * cp), s32(-sp)] as [number, number, number],
        r: [s32(cy), s32(-sy), 0] as [number, number, number],
        u: [s32(-sy * sp), s32(-cy * sp), s32(cp)] as [number, number, number],
        c: N / 2,
        scale: (N * 1.6) / W,
        dist: N * 2
    }
}

const DEPTH_RANGE = N * 6

/** The CPU raycaster. Writes R=value, G=normal code, B/A=depth fixed point. */
const renderCpu = (g: Uint8Array, cam: ReturnType<typeof camera>): Uint8Array => {
    const out = new Uint8Array(W * H * 4)
    const [fx, fy, fz] = cam.f
    const [rx, ry, rz] = cam.r
    const [ux, uy, uz] = cam.u
    const sx = fx > 0 ? 1 : -1
    const sy = fy > 0 ? 1 : -1
    const sz = fz > 0 ? 1 : -1
    const BIG = 1e18
    const inv = (v: number): number => (v === 0 ? BIG : Math.abs(1 / v))
    const dx = inv(fx)
    const dy = inv(fy)
    const dz = inv(fz)

    for (let py = 0; py < H; py++) {
        for (let px = 0; px < W; px++) {
            const a = (px - W / 2 + 0.5) * cam.scale
            const b = (py - H / 2 + 0.5) * cam.scale
            const ox = cam.c + rx * a + ux * b - fx * cam.dist
            const oy = cam.c + ry * a + uy * b - fy * cam.dist
            const oz = cam.c + rz * a + uz * b - fz * cam.dist

            // slab test into the box
            const t0x = fx === 0 ? -BIG : (0 - ox) / fx
            const t1x = fx === 0 ? BIG : (N - ox) / fx
            const t0y = fy === 0 ? -BIG : (0 - oy) / fy
            const t1y = fy === 0 ? BIG : (N - oy) / fy
            const t0z = fz === 0 ? -BIG : (0 - oz) / fz
            const t1z = fz === 0 ? BIG : (N - oz) / fz
            const tmin = Math.max(
                Math.min(t0x, t1x),
                Math.min(t0y, t1y),
                Math.min(t0z, t1z)
            )
            const tmax = Math.min(
                Math.max(t0x, t1x),
                Math.max(t0y, t1y),
                Math.max(t0z, t1z)
            )
            const i = (py * W + px) * 4
            if (tmax < Math.max(tmin, 0)) continue

            let t = Math.max(tmin, 0) + 1e-4
            let qx = ox + fx * t
            let qy = oy + fy * t
            let qz = oz + fz * t
            let cx = Math.floor(qx)
            let cy2 = Math.floor(qy)
            let cz = Math.floor(qz)
            let mx = fx === 0 ? BIG : (fx > 0 ? cx + 1 - qx : qx - cx) * dx
            let my = fy === 0 ? BIG : (fy > 0 ? cy2 + 1 - qy : qy - cy2) * dy
            let mz = fz === 0 ? BIG : (fz > 0 ? cz + 1 - qz : qz - cz) * dz
            let nCode = 0

            for (let step = 0; step < N * 4; step++) {
                if (cx < 0 || cy2 < 0 || cz < 0 || cx >= N || cy2 >= N || cz >= N) break
                const v = g[(cz * N + cy2) * N + cx] ?? 0
                if (v !== 0) {
                    const u = Math.min(Math.max(t / DEPTH_RANGE, 0), 1) * 65535
                    out[i] = v
                    out[i + 1] = nCode
                    out[i + 2] = Math.floor(u / 256)
                    out[i + 3] = Math.floor(u) % 256
                    break
                }
                if (mx < my && mx < mz) {
                    cx += sx
                    t = mx
                    mx += dx
                    nCode = fx > 0 ? 1 : 2
                } else if (my < mz) {
                    cy2 += sy
                    t = my
                    my += dy
                    nCode = fy > 0 ? 3 : 4
                } else {
                    cz += sz
                    t = mz
                    mz += dz
                    nCode = fz > 0 ? 5 : 6
                }
            }
        }
    }
    return out
}

const FRAG = `#version 300 es
precision highp float; precision highp int; precision highp usampler3D;
out vec4 o;
uniform usampler3D vol;
uniform vec3 F, R, U;
uniform float C, SCALE, DIST, NN, WW, HH, DEPTH_RANGE;
void main(){
  float px = gl_FragCoord.x - 0.5;
  float py = gl_FragCoord.y - 0.5;
  float a = (px - WW*0.5 + 0.5) * SCALE;
  float b = (py - HH*0.5 + 0.5) * SCALE;
  vec3 org = vec3(C) + R*a + U*b - F*DIST;

  const float BIG = 1e18;
  bvec3 zero = equal(F, vec3(0.0));
  vec3 safeF = mix(F, vec3(1.0), vec3(zero));
  vec3 t0 = mix((vec3(0.0) - org) / safeF, vec3(-BIG), vec3(zero));
  vec3 t1 = mix((vec3(NN)  - org) / safeF, vec3( BIG), vec3(zero));
  vec3 lo = min(t0,t1), hi = max(t0,t1);
  float tmin = max(max(lo.x,lo.y),lo.z);
  float tmax = min(min(hi.x,hi.y),hi.z);
  o = vec4(0.0);
  if (tmax < max(tmin,0.0)) return;

  float t = max(tmin,0.0) + 1e-4;
  vec3 q = org + F*t;
  vec3 c = floor(q);
  vec3 s = vec3(F.x>0.0?1.0:-1.0, F.y>0.0?1.0:-1.0, F.z>0.0?1.0:-1.0);
  vec3 d = mix(abs(1.0/safeF), vec3(BIG), vec3(zero));
  vec3 m = mix(vec3(
    (F.x>0.0 ? c.x+1.0-q.x : q.x-c.x)*d.x,
    (F.y>0.0 ? c.y+1.0-q.y : q.y-c.y)*d.y,
    (F.z>0.0 ? c.z+1.0-q.z : q.z-c.z)*d.z), vec3(BIG), vec3(zero));
  float nCode = 0.0;

  for (int step = 0; step < 128*4; step++){
    if (any(lessThan(c, vec3(0.0))) || any(greaterThanEqual(c, vec3(NN)))) return;
    uint v = texelFetch(vol, ivec3(c), 0).r;
    if (v != 0u){
      float u = clamp(t/DEPTH_RANGE, 0.0, 1.0) * 65535.0;
      o = vec4(float(v)/255.0, nCode/255.0, floor(u/256.0)/255.0, floor(mod(u,256.0))/255.0);
      return;
    }
    if (m.x < m.y && m.x < m.z){ c.x += s.x; t = m.x; m.x += d.x; nCode = F.x>0.0?1.0:2.0; }
    else if (m.y < m.z){ c.y += s.y; t = m.y; m.y += d.y; nCode = F.y>0.0?3.0:4.0; }
    else { c.z += s.z; t = m.z; m.z += d.z; nCode = F.z>0.0?5.0:6.0; }
  }
}`

const page = (frag: string): string => `<canvas id=c width=${W} height=${H}></canvas><script>
window.run = (volArr, cam, N, W, H, DR) => {
  const gl = document.getElementById('c').getContext('webgl2', {preserveDrawingBuffer: true, antialias: false})
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  const vsSrc = '#version 300 es\\nin vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }'
  const mk=(t,s)=>{const h=gl.createShader(t);gl.shaderSource(h,s);gl.compileShader(h);
    if(!gl.getShaderParameter(h,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(h)); return h}
  const pr=gl.createProgram()
  gl.attachShader(pr,mk(gl.VERTEX_SHADER,vsSrc))
  gl.attachShader(pr,mk(gl.FRAGMENT_SHADER,${JSON.stringify(frag)}))
  gl.linkProgram(pr)
  if(!gl.getProgramParameter(pr,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr))
  gl.useProgram(pr)
  const tex=gl.createTexture(); gl.bindTexture(gl.TEXTURE_3D,tex)
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MIN_FILTER,gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MAG_FILTER,gl.NEAREST)
  gl.texImage3D(gl.TEXTURE_3D,0,gl.R8UI,N,N,N,0,gl.RED_INTEGER,gl.UNSIGNED_BYTE,new Uint8Array(volArr))
  const uf=(n,v)=>gl.uniform1f(gl.getUniformLocation(pr,n),v)
  const u3=(n,v)=>gl.uniform3f(gl.getUniformLocation(pr,n),v[0],v[1],v[2])
  gl.uniform1i(gl.getUniformLocation(pr,'vol'),0)
  u3('F',cam.f); u3('R',cam.r); u3('U',cam.u)
  uf('C',cam.c); uf('SCALE',cam.scale); uf('DIST',cam.dist)
  uf('NN',N); uf('WW',W); uf('HH',H); uf('DEPTH_RANGE',DR)
  const buf=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buf)
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW)
  const p=gl.getAttribLocation(pr,'p'); gl.enableVertexAttribArray(p)
  gl.vertexAttribPointer(p,2,gl.FLOAT,false,0,0)
  gl.viewport(0,0,W,H)
  gl.drawArrays(gl.TRIANGLES,0,3)
  const px=new Uint8Array(W*H*4)
  gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px)
  return {renderer: dbg?gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL):'?', px: Array.from(px)}
}
</script>`

const compare = (cpu: Uint8Array, gpu: Uint8Array, label: string): void => {
    let hitDiff = 0
    let valDiff = 0
    let nrmDiff = 0
    let maxDepth = 0
    let opaque = 0
    for (let i = 0; i < W * H; i++) {
        const a = cpu[i * 4] ?? 0
        const b = gpu[i * 4] ?? 0
        const ah = a !== 0
        const bh = b !== 0
        if (ah) opaque++
        if (ah !== bh) {
            hitDiff++
            continue
        }
        if (!ah) continue
        if (a !== b) valDiff++
        if ((cpu[i * 4 + 1] ?? 0) !== (gpu[i * 4 + 1] ?? 0)) nrmDiff++
        const da = (cpu[i * 4 + 2] ?? 0) * 256 + (cpu[i * 4 + 3] ?? 0)
        const db = (gpu[i * 4 + 2] ?? 0) * 256 + (gpu[i * 4 + 3] ?? 0)
        maxDepth = Math.max(maxDepth, Math.abs(da - db))
    }
    const px = W * H
    console.log(
        `${label}\n`
            + `  opaque pixels      ${opaque} / ${px}\n`
            + `  silhouette differs ${hitDiff}  (${((hitDiff / px) * 100).toFixed(4)} % of frame)\n`
            + `  voxel id differs   ${valDiff}\n`
            + `  normal differs     ${nrmDiff}\n`
            + `  max depth delta    ${maxDepth} / 65535  (${((maxDepth / 65535) * DEPTH_RANGE).toFixed(4)} voxels)`
    )
}

const vol = buildVolume()
const browser = await chromium.launch({
    args: [
        '--use-angle=vulkan',
        '--enable-features=Vulkan',
        '--use-gl=angle',
        '--ignore-gpu-blocklist',
        '--enable-gpu-rasterization'
    ]
})
const p = await browser.newPage()
await p.setContent(page(FRAG))

for (const [yaw, pitch, name] of [
    [0.7, 0.5, 'oblique (0.7, 0.5)'],
    [Math.PI / 4, Math.atan(Math.SQRT1_2), 'isometric'],
    [0, 0, 'axis-aligned front'],
    [Math.PI / 2, 0, 'axis-aligned side'],
    [1.234567, 0.345678, 'arbitrary']
] as [number, number, string][]) {
    const cam = camera(yaw, pitch)
    const cpu = renderCpu(vol, cam)
    const res = (await p.evaluate(
        ([v, c, n, w, h, dr]) =>
            (window as unknown as {run: (...a: unknown[]) => {renderer: string; px: number[]}}).run(
                v,
                c,
                n,
                w,
                h,
                dr
            ),
        [Array.from(vol), cam, N, W, H, DEPTH_RANGE] as unknown[]
    )) as {renderer: string; px: number[]}
    compare(cpu, new Uint8Array(res.px), `\n${name}   [${res.renderer.slice(0, 60)}]`)
}
await browser.close()
