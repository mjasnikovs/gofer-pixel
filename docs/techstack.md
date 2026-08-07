# gofer-pixel — tech stack

Written 2026-08-07, against `docs/FEATURESET.md` and the two mockups beside it.

The product is a **pixel sprite editor**. An artist builds voxel art; the software turns cameras
into sprite sheets and geometry into colour, normal, depth, AO and emission maps. It is not a 3D
editor and it does not grow into one.

Every number in this document was measured on this machine on 2026-08-07. Where something is a
design intention rather than a measurement, it says so.

---

## 1. The stack

| Layer           | Choice                                      | Why                                                                 |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| Runtime + tests | Bun 1.3                                     | `bun test` starts in ~100 ms; already the repo's runner             |
| Language        | TypeScript 6, strict                        | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, no `!`    |
| Bundler / dev   | Vite 8                                      | Builds an app from `index.html`; gofer-pixel is not a package       |
| UI              | React 19 + astryx                           | Consistency with `~/hub/gofer`; the React layer holds no logic      |
| Viewport render | WebGL2, voxel raycast in a fragment shader  | Only place a GPU is needed                                          |
| Sprite render   | The same raycast, in TypeScript, on the CPU | Runs inside `bun test`; **this is the exporter, not a test double** |
| DOM in tests    | happy-dom via a Bun preload                 | Real DOM, real React, 0.6 ms per click                              |
| Browser tests   | Playwright 1.60 + Chromium, ~10 tests total | Only for what cannot exist outside a browser                        |
| Lint / format   | ESLint 10 type-aware, Prettier              | Copied from `~/hub/gofer`, stays in sync                            |

Deleted with this decision: sprite stacking (`src/vox/render.ts`, `slice.ts`, `render-worker.ts`,
`voxrender.py` and the Python parity contract), the effects/scripting surface (`src/fx/`), the bone
rig (`src/anim/rig.ts`), and the engine-specific exporters (`godot.ts`, `strip.ts`). Kept:
`src/doc/` (volume, document, history, palette, serialize), `.vox` read/write, PNG encoding,
`src/gen/`, and the pure gesture-replay pattern in `src/editor/state.ts`.

---

## 2. One algorithm, two backends

The renderer is a voxel **raycast**, not a rasteriser: one ray per output pixel, orthographic
camera, integer voxel grid, nearest everything. Written twice, deliberately.

- **TypeScript, on the CPU.** Produces every sprite the app exports, and runs inside `bun test`.
- **GLSL, on the GPU.** Produces the interactive viewport only.

This is the decision the whole testing story hangs on. Because the exporter is plain TypeScript, a
test of the actual shipped output is a plain unit test with no browser in it.

Raycasting also gives the output maps for free: a ray hit already knows the face it struck (normal),
the distance (depth), the voxel (colour, material, object id). All maps come from the same ray, so
they are aligned by construction — `FEATURESET.md` §18 and §19 are a consequence of the renderer
rather than features bolted onto it.

### Measured — CPU raycast in Bun, single-threaded

| Volume | Output    | Per frame | Rays/s |
| ------ | --------- | --------- | ------ |
| 32³    | 128 × 128 | 1.66 ms   | 9.9 M  |
| 64³    | 128 × 128 | 2.26 ms   | 7.3 M  |
| 128³   | 64 × 64   | 0.89 ms   | 4.6 M  |
| 128³   | 128 × 128 | 3.48 ms   | 4.7 M  |
| 128³   | 256 × 256 | 13.8 ms   | 4.7 M  |
| 128³   | 512 × 512 | 55.3 ms   | 4.7 M  |

A 48-sprite sheet (8 directions × 6 frames) at 128 × 128 from a 128³ model is ~170 ms of CPU. That
is an export, and it is also a test.

At 512 × 512 the CPU is 18 fps, which is why the viewport is on the GPU and nothing else is.

### Measured — GPU, headless Chromium, 512 × 512 through a 128³ volume

| Flags                                                                               | Renderer       | Per frame |
| ----------------------------------------------------------------------------------- | -------------- | --------- |
| default                                                                             | SwiftShader    | 61.7 ms   |
| `--use-angle=vulkan --enable-features=Vulkan --use-gl=angle --ignore-gpu-blocklist` | RTX 4070 SUPER | 1.21 ms   |

Including a full `readPixels` round trip. **The flags are mandatory**; without them headless
Chromium silently falls back to software and is 51× slower. Browser launch was 79 ms.

### Validated — the two backends agree exactly

Both raycasters were written out in full and run against the same 32³ volume with the same camera,
at 128 × 128, on five cameras. Result, on **both** the NVIDIA driver and SwiftShader:

| Camera                       | Silhouette differs | Voxel id differs | Normal differs |
| ---------------------------- | ------------------ | ---------------- | -------------- |
| oblique (yaw 0.7, pitch 0.5) | 0                  | 0                | 0              |
| isometric                    | 0                  | 0                | 0              |
| axis-aligned front           | 0                  | 0                | 0              |
| axis-aligned side            | 0                  | 0                | 0              |
| arbitrary (1.2346, 0.3457)   | 0                  | 0                | 0              |

Colour and normal are byte-identical. Depth differs by at most 1 part in 65 535 — 0.003 voxels —
which is the rounding in the fixed-point depth encoding, not a disagreement between the backends.

That is not free. It only holds because of two rules, and **both are hard requirements on the
renderer, not test-only concessions:**

1. **Snap the camera basis.** `cos(π/2)` is `6.1e-17` in float64 and a different tiny number in
   float32, so an "axis-aligned" camera is not actually axis-aligned and `1/dir` explodes
   differently on each side. Any basis component under `1e-6` becomes exactly `0`, and the whole
   basis is passed through `Math.fround` so the CPU starts from the same bits the GPU is handed as a
   uniform.
2. **A zero direction component uses a shared finite sentinel (`1e18`), never `Infinity`.** In the
   slab test, in `tDelta`, and in the initial `tMax`. `Infinity` arithmetic is where JS and GLSL
   part company.

Without rule 1 the axis-aligned side view disagreed on 12 silhouette pixels and 60 voxel ids, and
depth was off by 4 whole voxels. It also **lost 20 % of the model** — the un-snapped axis-aligned
views rendered 2 684 and 2 708 opaque pixels against 3 354 and 3 366 once snapped. That is the same
defect class as the striping bug in `CLAUDE.md`, arriving by a different route. It will keep coming
back at 0/90/180/270° until the snap is a property test.

The consequence for testing:

- **Golden hashes come from the CPU raycaster.** It is deterministic, it needs no GPU, and it is the
  thing that actually ships the sprite.
- One Playwright test asserts the shader matches that render — **exactly** on colour and normal,
  within one unit on encoded depth.
- Measured on two drivers that could hardly be more different, not on all drivers. If a third ever
  disagrees, the CPU is right by definition and the shader is the bug.

---

## 3. Testing — the law

**Nothing waits.** Not for a timer, not for an animation, not for a scroll, not for a network retry,
not for "the UI to settle". A test that contains a duration is a broken test.

Concretely banned, with no exceptions:

- `sleep`, `setTimeout` in a test body, `page.waitForTimeout`, `await new Promise(r => …)`
- `waitFor`, `waitUntil`, polling loops, retry-until-true helpers
- `@testing-library/user-event` — it simulates human typing with real per-keystroke delays
- animated scrolling, smooth scrolling, or any assertion that follows one
- CSS transitions or animations left running during a test
- `page.screenshot` diffing of layout

Every one of those is replaced by something event-driven:

| Instead of                     | Do this                                                               |
| ------------------------------ | --------------------------------------------------------------------- |
| waiting for React to re-render | `act()` — it flushes synchronously, there is nothing to wait for      |
| `userEvent.click`              | `element.click()`, or call the handler directly                       |
| waiting for a frame to draw    | `await renderer.renderNow()` — resolves when the frame has landed     |
| waiting for a drag to "finish" | call `apply(state, {type: 'pointermove', …})` — it is a pure function |
| waiting for a scroll           | set `scrollTop`; assert the derived state, not the pixels             |
| waiting for a worker           | `await` its promise; the bake job is a pure function anyway           |

The viewport exposes an explicit `renderNow()` and a monotonic frame counter. A test awaits _a frame
having happened_, never a number of milliseconds. This is a hard requirement on the renderer's API,
not a testing convenience — it is why the render loop must be drivable, not
`requestAnimationFrame`-owned.

### The four layers, and what each costs

**1. Pure logic — `bun test`, no DOM.** The state machine, camera maths, pixel snapping, screen →
voxel picking, palette reindexing, the document model, serialisation. Where the real coverage lives.

> Current suite, unchanged and still valid: **398 tests in 724 ms.**

**2. Sprite pixels — `bun test`, no DOM.** The CPU raycaster renders the actual exported sprite and
the test hashes it. This is possible only because the exporter is TypeScript.

> **3.5 ms** for a 128 × 128 sprite from a 128³ model. A hundred golden sprites is ~350 ms.

**3. UI — `bun test` + happy-dom.** Real React 19 `createRoot`, real DOM nodes, real clicks.

> **0.607 ms** per click-and-rerender pair on plain React, measured over 200 pairs. **1.31 ms** with
> real astryx `Button` / `HStack` / `VStack` / `NumberInput` / `TextInput` mounted, measured over
> 100 clicks — they need **no shims**. A stateless panel skips the DOM entirely with
> `renderToStaticMarkup` at **0.117 ms**. Whole file, including Bun startup: **309 ms**.

The preload is three lines:

```ts
import {GlobalRegistrator} from '@happy-dom/global-registrator'
GlobalRegistrator.register()
globalThis.IS_REACT_ACT_ENVIRONMENT = true
```

A UI test reads: render this state, `element.click()` the control, assert the resulting DOM and the
resulting state. Wiring bugs, stale renders and wrong-action bugs all die here, in under a
millisecond each.

**4. Reality — Playwright, ~10 tests, target under 5 seconds total.** Only these four things:

- the GLSL raycast matches the CPU raycast — exactly on colour and normal, ±1 on encoded depth
- the app boots, the canvas is non-empty, the console is clean
- a real pointer drag with pointer capture reaches the state machine
- layout sanity as **bounding-box assertions** — nothing overlaps the viewport, nothing is clipped,
  nothing overflows the window — because happy-dom returns zeros from `getBoundingClientRect`

Screenshot diffing is not in that list on purpose. It is the standard source of the slow, flaky
suite this stack exists to avoid.

### The whole gate

`bun run check` stays `format:check && lint && typecheck && test`, all of it browser-free and in
around a second. Playwright is a separate script and does not gate the inner loop.

---

## 4. What is settled, and what still is not

Both load-bearing unknowns were closed on 2026-08-07 by writing the spikes, not by argument:

- **The CPU and GPU raycasters agree exactly** — §2, five cameras, two drivers, zero colour and
  normal differences. Conditional on the snap and sentinel rules, which are now part of the
  renderer's contract.
- **Astryx mounts under happy-dom with no shims** — `Button`, `HStack`, `VStack`, `NumberInput` and
  `TextInput` render, click and update at 1.31 ms per interaction.

Closed since, by building the proof of concept:

- **What a camera is.** A stored orthographic transform plus a name — yaw, pitch, zoom and a
  two-axis pan (`src/doc/cameras.ts`). The named list is the data; "create 8 directions" is a
  generator that produces eight of them and nothing more. Sprite size is not part of a camera: it
  belongs to the export, so one camera list can be rendered at 32, 64 or 128 px.
- **How lighting works, to the extent the renderer needs one.** Flat per-face light, as an integer
  numerator over 256 (`src/render/faces.ts`). Integer and over a power of two because that is the
  arithmetic both backends have to agree on byte-for-byte; it also happens to be the look voxel art
  wants. There is no light direction.

Still open, and each one is a decision rather than a measurement:

1. **How a render becomes pixel art.** One ray per output pixel is crisp and aliased. Whether the
   pipeline also quantises shading into N palette-aware steps (`FEATURESET.md` §22) changes the
   renderer's output stage. Not decided — and not on `docs/TASKS.md`, because §22 is postponed and
   the output stage should not be reshaped for something that is not being built.
2. **What happens to `src/gen/`.** It survives the cut, but it currently scores candidates by
   rendering them with the sprite-stacking renderer that is being deleted. It has to be repointed at
   the raycaster.
3. ~~**Whether 2D slice editing survives.**~~ **Closed 2026-08-07: it survives, as a clip.**
   `FEATURESET.md` §6 asks for the current slice solid and the rest ghosted. What it asks for it
   _for_ is drawing interiors without fighting the camera, and what achieves that is the layers in
   front going away. Ghosting would mean alpha in the raycaster — a change to the one algorithm the
   two backends are held to agreeing on byte for byte — in exchange for scenery the artist still
   cannot click through. `src/doc/slice.ts` masks a grid the way a hidden object does, and costs the
   renderer nothing.

    It is also not a second editing mode. The plane lock of §5 already answers "which plane am I
    drawing on"; slice mode answers "which layer of it, and can I see it".
