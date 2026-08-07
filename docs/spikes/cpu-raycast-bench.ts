// CPU voxel raycaster benchmark: ortho camera, DDA through a dense grid.
// Question: can a CPU version of the render algorithm run inside `bun test` fast enough
// to be the oracle for the GPU shader?

const makeGrid = (n: number): Uint8Array => {
    const g = new Uint8Array(n * n * n)
    const c = (n - 1) / 2
    // a solid-ish blob plus noise so rays actually terminate at varied depths
    for (let z = 0; z < n; z++)
        for (let y = 0; y < n; y++)
            for (let x = 0; x < n; x++) {
                const d = Math.hypot(x - c, y - c, z - c)
                if (d < n * 0.42 && (x * 7 + y * 13 + z * 29) % 11 !== 0) g[(z * n + y) * n + x] = 1 + ((x + y + z) % 15)
            }
    return g
}

type Hit = {v: number; nx: number; ny: number; nz: number; t: number}

const trace = (
    g: Uint8Array,
    n: number,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    out: Hit
): boolean => {
    // step the ray into the box first (ortho camera starts outside)
    let tmin = -Infinity
    let tmax = Infinity
    const slab = (o: number, d: number): boolean => {
        if (Math.abs(d) < 1e-9) return o >= 0 && o <= n
        const t1 = (0 - o) / d
        const t2 = (n - o) / d
        tmin = Math.max(tmin, Math.min(t1, t2))
        tmax = Math.min(tmax, Math.max(t1, t2))
        return tmax >= tmin
    }
    if (!slab(ox, dx) || !slab(oy, dy) || !slab(oz, dz)) return false
    let t = Math.max(tmin, 0) + 1e-4
    let x = Math.floor(ox + dx * t)
    let y = Math.floor(oy + dy * t)
    let z = Math.floor(oz + dz * t)
    const sx = dx > 0 ? 1 : -1
    const sy = dy > 0 ? 1 : -1
    const sz = dz > 0 ? 1 : -1
    const idx = Math.abs(dx) < 1e-9 ? Infinity : Math.abs(1 / dx)
    const idy = Math.abs(dy) < 1e-9 ? Infinity : Math.abs(1 / dy)
    const idz = Math.abs(dz) < 1e-9 ? Infinity : Math.abs(1 / dz)
    let mx = idx === Infinity ? Infinity : ((dx > 0 ? x + 1 - (ox + dx * t) : ox + dx * t - x) * idx)
    let my = idy === Infinity ? Infinity : ((dy > 0 ? y + 1 - (oy + dy * t) : oy + dy * t - y) * idy)
    let mz = idz === Infinity ? Infinity : ((dz > 0 ? z + 1 - (oz + dz * t) : oz + dz * t - z) * idz)
    let axis = 0
    for (let i = 0; i < n * 4; i++) {
        if (x < 0 || y < 0 || z < 0 || x >= n || y >= n || z >= n) return false
        const v = g[(z * n + y) * n + x]
        if (v !== undefined && v !== 0) {
            out.v = v
            out.nx = axis === 0 ? -sx : 0
            out.ny = axis === 1 ? -sy : 0
            out.nz = axis === 2 ? -sz : 0
            out.t = t
            return true
        }
        if (mx < my && mx < mz) { x += sx; t = mx; mx += idx; axis = 0 }
        else if (my < mz) { y += sy; t = my; my += idy; axis = 1 }
        else { z += sz; t = mz; mz += idz; axis = 2 }
    }
    return false
}

/** Render one ortho view: colour + normal + depth, one ray per output pixel. */
const render = (g: Uint8Array, n: number, w: number, h: number, yaw: number, pitch: number) => {
    const col = new Uint8Array(w * h * 4)
    const nrm = new Uint8Array(w * h * 4)
    const dep = new Float32Array(w * h)
    const cy = Math.cos(yaw), sy2 = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch)
    // camera basis
    const fx = -sy2 * cp, fy = -cy * cp, fz = -sp
    const rx = cy, ry = -sy2, rz = 0
    const ux = -sy2 * sp, uy = -cy * sp, uz = cp
    const c = n / 2
    const scale = n * 1.5 / w
    const hit: Hit = {v: 0, nx: 0, ny: 0, nz: 0, t: 0}
    for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
            const a = (px - w / 2 + 0.5) * scale
            const b = (h / 2 - py - 0.5) * scale
            const ox = c + rx * a + ux * b - fx * n * 2
            const oy = c + ry * a + uy * b - fy * n * 2
            const oz = c + rz * a + uz * b - fz * n * 2
            const i = (py * w + px) * 4
            if (trace(g, n, ox, oy, oz, fx, fy, fz, hit)) {
                col[i] = hit.v * 17; col[i + 1] = 255 - hit.v * 9; col[i + 2] = 128; col[i + 3] = 255
                nrm[i] = (hit.nx * 0.5 + 0.5) * 255
                nrm[i + 1] = (hit.ny * 0.5 + 0.5) * 255
                nrm[i + 2] = (hit.nz * 0.5 + 0.5) * 255
                nrm[i + 3] = 255
                dep[py * w + px] = hit.t
            }
        }
    }
    return {col, nrm, dep}
}

const bench = (n: number, w: number, iters: number): void => {
    const g = makeGrid(n)
    render(g, n, w, w, 0.7, 0.5) // warm
    const t0 = performance.now()
    for (let i = 0; i < iters; i++) render(g, n, w, w, 0.7 + i * 0.01, 0.5)
    const ms = (performance.now() - t0) / iters
    console.log(
        `grid ${n}³  out ${w}×${w}  ${ms.toFixed(2)} ms/frame  `
            + `(${((w * w) / ms / 1000).toFixed(1)}M rays/s)`
    )
}

for (const n of [16, 32, 64, 128]) {
    bench(n, 64, 50)
    bench(n, 128, 50)
    bench(n, 256, 20)
}
console.log('--- viewport-sized')
bench(64, 512, 10)
bench(128, 512, 10)
