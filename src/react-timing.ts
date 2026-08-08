/**
 * React's Performance track, off unless it is asked for. Add `?react-track` to the URL for it.
 *
 * React 19's development build writes every render into the Performance track, and part of what it
 * writes is a deep diff of every changed prop. A `Uint8Array` is not special to that diff: it is
 * walked one index at a time, the old buffer and the new one both. `Volume` carries two of them —
 * `data` and `owner` — an edit hands down a fresh pair, and the volume is a prop in about thirty
 * places once the thumbnails are counted.
 *
 * So one voxel cost 1.2 s on a 32³ document and 10 s on a 64³ one, all of it in dev and none of it
 * in the built bundle. With the track off the same edit is 50–85 ms at either size. Measured
 * 2026-08-08 in `vite dev`, Chromium, hardware Vulkan.
 *
 * `6aa6f5f` fixed this same defect for `PixelCanvas` by making the pixels a function, which the
 * walker stringifies instead of walking. That answer does not scale to `Volume`: the buffers *are*
 * the volume, and every renderer, overlay and panel takes one.
 *
 * The gate is React's own — it logs only when `console.timeStamp` and `performance.measure` both
 * exist — and it reads that gate once, when `react-dom` is evaluated. So this has to run *before*
 * that import rather than as a call inside `main.tsx`, which is why it is a module and why it is
 * the first line of the file.
 *
 * The built bundle is untouched. React's production build has no such logging, and the flag exists
 * so that profiling React itself is one query parameter away rather than a revert.
 */
const asked = globalThis.location.search.includes('react-track')

if (import.meta.env.DEV && !asked) {
    delete (console as {timeStamp?: unknown}).timeStamp
}
