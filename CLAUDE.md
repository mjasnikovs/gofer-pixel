# gofer-pixel

A local pixel sprite editor. An artist builds voxel art; the software turns cameras into sprite
sheets and turns geometry into colour, normal, depth, AO and emission maps.

It is **not** a 3D editor and does not grow into one. Every feature is judged by whether it helps
produce pixels.

## Read these first, in order

1. `docs/techstack.md` — the stack, the renderer architecture, and the testing law. §4 lists what is
   still undecided.
2. `docs/FEATURESET.md` — the product intent, 40 items. Treat it as a someday-list.
3. `docs/editor.png` and `docs/featureset.png` — **these two mockups are the spec.** When the two
   disagree with FEATURESET.md, the mockups win.
4. `docs/POC_PROMPT.md` — the brief the current `src/` was built against, with its do-not-build list
   and its measurable done criteria. All six steps are built; the list of things it says not to
   build is still the list of things not to build.

## The rebuild

The project was restarted on 2026-08-07. Everything built before that is in `legacy/`, which is
excluded from lint, format, typecheck, test and build. Read `legacy/README.md` before opening
anything in there — it says what is worth reading and what is superseded.

Code from `legacy/` is carried over deliberately, file by file, with its tests — never by import.
Carried over so far: the `.vox` reader (`src/vox/`), the PNG encoder (`src/image/`), the gesture
replay pattern (`src/viewport/orbit.ts`), and `assets/car.vox` itself. Everything else in `src/` is
new.

What is there now, and roughly in dependency order:

| Path            | Holds                                                                            |
| --------------- | -------------------------------------------------------------------------------- |
| `src/render/`   | the CPU raycaster, the shader it is mirrored by, the camera, the WebGL2 renderer |
| `src/vox/`      | `.vox` → `Volume`                                                                |
| `src/doc/`      | what a camera is, and the eight-direction generator                              |
| `src/sheet/`    | packing cameras into a colour sheet and a normal sheet                           |
| `src/image/`    | PNG encoding                                                                     |
| `src/viewport/` | orbit/pan/zoom as a pure function, and the React canvas                          |
| `src/app/`      | the whole app as one value and one `reduce`, plus the panels that show it        |
| `src/theme/`    | `theme.ts` and the CSS it generates; never edit the CSS                          |
| `browser/`      | the Playwright suite and the page it drives                                      |

## The renderer

One algorithm, two backends, and this is the decision everything else hangs on:

- **TypeScript, on the CPU.** Renders every sprite the app exports, and runs inside `bun test`. A
  128 × 128 sprite from a 128³ model takes 3.5 ms, so a golden-pixel test needs no browser.
- **GLSL, on the GPU.** Renders the interactive viewport only, because at 512 × 512 the CPU drops to
  18 fps.

They are verified to agree exactly — see `docs/techstack.md` §2. That agreement is **conditional on
two rules that are part of the renderer's contract, not test concessions**:

1. Camera basis components under `1e-6` snap to exactly `0`, and the basis goes through
   `Math.fround`. `cos(π/2)` is `6.1e-17` in float64 and a different tiny number in float32, so an
   "axis-aligned" camera is not axis-aligned and `1/dir` explodes differently on each side.
2. A zero direction component uses a shared finite sentinel (`1e18`), never `Infinity` — in the slab
   test, in `tDelta`, and in the initial `tMax`.

Break either and axis-aligned views lose a fifth of the model without failing loudly. This is the
same defect class that bit the old sprite-stacking renderer at 0/90/180/270°.

## Testing — nothing waits

**A test that contains a duration is a broken test.** No `sleep`, no `waitForTimeout`, no `waitFor`,
no polling, no `@testing-library/user-event`, no animated scrolling, no screenshot diffing.

- React updates flush synchronously inside `act()`. There is nothing to wait for.
- Clicks are `element.click()` on a real happy-dom node — 1.3 ms with astryx components mounted.
- The viewport exposes `renderNow()` and a frame counter, so a test awaits _a frame having landed_,
  never milliseconds. The render loop must be drivable, not owned by `requestAnimationFrame`.
- Golden pixel hashes come from the CPU raycaster. It is the oracle and it needs no GPU.
- Playwright is roughly ten tests for what cannot exist outside a browser, and it does not gate
  `bun run check`. Chromium needs
  `--use-angle=vulkan --enable-features=Vulkan --use-gl=angle --ignore-gpu-blocklist` or it silently
  falls back to SwiftShader and is 51× slower.
- `gl.finish()` does **not** make a frame land — Chrome's command buffer returns from it long before
  the GPU is done, and a benchmark built on it reports 0.006 ms on software rendering. `renderNow`
  reads one pixel back instead, which really blocks, costs ~0.2 ms, and is what makes the frame
  counter mean anything.
- The browser suite drives the running app through `src/app/handle.ts` rather than by polling the
  DOM. It is a deliberate seam and the app only ever writes to it.

`test/preload.ts` registers happy-dom for every test via `bunfig.toml`, so `document` is always
available.

## Commands

```bash
bun run check        # format:check + lint + typecheck + test — the gate, 5.8 s, no browser
bun run test         # bun test — scoped to src/ by bunfig.toml
bun run build        # deployable app bundle to dist/ (not a package — no .d.ts, no lib entry)
bun run test:browser # the Playwright suite — separate, does not gate `check`, 15 s
bun run dev          # the app on :1430
bun run theme        # rebuild src/theme/gofer-pixel-theme.css from src/theme/theme.ts
bun run format       # prettier --write
```

`lint` and `format` are cached (`.eslintcache`, prettier's own). A cold `check` is about 9 s; the
number above is the one that matters, because it is the one the inner loop pays. Two and a half of
those seconds are `App.test.tsx` mounting the whole window seven times — the mount is what costs
under happy-dom, not the assertions, so a new test that needs a fresh window costs ~300 ms.

## Conventions

Toolchain and config are copied from `~/hub/gofer` and should stay in sync with it: ESLint 10 with
type-aware strict rules, Prettier (4 spaces, no semicolons, single quotes, no bracket spacing, print
width 100), TypeScript 6 with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

That combination bans non-null assertions on indexed access. Use a `?? fallback`, a `DataView` read,
or an early-return guard — not `!`.

Imports are extensionless. `legacy/`, `docs/spikes/` and `bunfig.toml` are excluded from lint and
format, as are the two files `bun run theme` generates.

The theme is not decoration and it has a gate: `src/theme/theme.test.ts` measures the built CSS for
collapsed distinctions — text roles under 12 L* apart, a surface ramp step under 3 L*, an accent no
brighter than body text, a control border under 3:1 — and it runs inside `bun test`. Read
`skills/gofer-ui/SKILL.md` before touching any of it.

## Environment

- llama-server on `localhost:8080` — Qwen3.6-27B, vision in, 120k context, 2 slots. It is a separate
  root/container process split across both GPUs. **Do not restart it casually.** It sends permissive
  CORS headers, so the browser calls it directly; no proxy.
- Both GPUs sit at ~95 % VRAM with that model loaded. Nothing else gets meaningful VRAM; CLIP runs
  on CPU by necessity. **The browser suite therefore runs one worker.** Two Chromiums starting at
  once intermittently fail to bring up a hardware Vulkan device and drop to SwiftShader without
  saying so — measured over eight two-worker runs, five failed, at 58–63 ms per frame or with the
  viewport reading back an empty canvas. Serially it is stable and the whole suite is ~14 s.
- A frame costs 0.17 ms on the idle GPU and up to 2.4 ms while llama-server is busy on the same
  card. Any timing assertion has to clear that 14× spread, not the idle number.
- WebGL2 under the Tauri webview here is **hardware**, measured 2026-08-06 with
  `legacy/experiments/webgl_probe.py` — 735× SwiftShader. Do not detect this by reading the renderer
  string: WebKit masks it and reports "Apple GPU" on an NVIDIA box. Time a draw instead.
- Godot 4.7.1 is at `/usr/bin/godot`, and `godot --headless --path <dir> --script <file.gd>` runs a
  script against it.
- `.venv` holds the Python side (CPU torch, open_clip, pillow) used by `legacy/py/`.
