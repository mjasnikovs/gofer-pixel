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

## The rebuild

The project was restarted on 2026-08-07. Everything built before that is in `legacy/`, which is
excluded from lint, format, typecheck, test and build. Read `legacy/README.md` before opening
anything in there — it says what is worth reading and what is superseded.

`src/` is nearly empty on purpose. Code from `legacy/` is carried over deliberately, file by file,
with its tests — never by import.

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

`test/preload.ts` registers happy-dom for every test via `bunfig.toml`, so `document` is always
available.

## Commands

```bash
bun run check       # format:check + lint + typecheck + test — the gate, ~4 s, no browser
bun run test        # bun test — scoped to src/ by bunfig.toml
bun run build       # deployable app bundle to dist/ (not a package — no .d.ts, no lib entry)
bun run test:browser # the Playwright suite — separate, does not gate `check`
bun run dev         # playground on :1430
bun run format      # prettier --write
```

## Conventions

Toolchain and config are copied from `~/hub/gofer` and should stay in sync with it: ESLint 10 with
type-aware strict rules, Prettier (4 spaces, no semicolons, single quotes, no bracket spacing, print
width 100), TypeScript 6 with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

That combination bans non-null assertions on indexed access. Use a `?? fallback`, a `DataView` read,
or an early-return guard — not `!`.

Imports are extensionless. `legacy/` and `bunfig.toml` are excluded from lint and format.

## Environment

- llama-server on `localhost:8080` — Qwen3.6-27B, vision in, 120k context, 2 slots. It is a separate
  root/container process split across both GPUs. **Do not restart it casually.** It sends permissive
  CORS headers, so the browser calls it directly; no proxy.
- Both GPUs sit at ~95 % VRAM with that model loaded. Nothing else gets meaningful VRAM; CLIP runs
  on CPU by necessity.
- WebGL2 under the Tauri webview here is **hardware**, measured 2026-08-06 with
  `legacy/experiments/webgl_probe.py` — 735× SwiftShader. Do not detect this by reading the renderer
  string: WebKit masks it and reports "Apple GPU" on an NVIDIA box. Time a draw instead.
- Godot 4.7.1 is at `/usr/bin/godot`, and `godot --headless --path <dir> --script <file.gd>` runs a
  script against it.
- `.venv` holds the Python side (CPU torch, open_clip, pillow) used by `legacy/py/`.
