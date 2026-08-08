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
4. `docs/TASKS.md` — the list being worked through now: every unpostponed item of `FEATURESET.md`,
   in dependency order, with what is done and what is left.
5. `docs/POC_PROMPT.md` — the brief the current `src/` was built against. All six steps are built.
   **Its do-not-build list has been superseded by `docs/TASKS.md`**: editing, selection, transforms
   and the remaining output maps were on it because they proved nothing about the architecture, and
   they are now the product.
6. `docs/VALIDATE.md` — how to find out whether a gesture actually works, and the paste-able prompt
   for it. Read it before saying a tool does or does not do something: `bun test` cannot see the
   input layer, and three bugs in one session hid there.

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
| `src/doc/`      | cameras, the brush, edits, undo, selection, transforms, symmetry, figures        |
| `src/doc/files` | the `.gpix` save format, the disk behind a port, and the new-project templates   |
| `src/sheet/`    | packing cameras into the six output sheets                                       |
| `src/image/`    | PNG encoding                                                                     |
| `src/viewport/` | orbit/pan/zoom as a pure function, and the React canvas                          |
| `src/app/`      | the whole app as one value and one `reduce`, plus the panels that show it        |
| `src/gen/`      | the local-AI pipeline: prompt → primitives → voxels, and the two scorers         |
| `src/theme/`    | `theme.ts` and the CSS it generates; never edit the CSS                          |
| `py/`           | `clipserve.py`, the CLIP scoring service. Optional, started by hand              |
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

## Local AI

Carried back out of `legacy/` on 2026-08-08, into `src/gen/` and one dialog behind the main menu.
The pipeline is:

```
prompt → llama-server emits a JSON op list under a grammar → rasterise to a Volume
  → the CPU raycaster renders four views → CLIP ranks them → pick one, and it becomes the document
```

Four things are settled and must not be re-litigated. They are measured, and the record is
`legacy/docs/DESIGN_PROGRESS.md`:

1. **The model cannot draw pixels.** Grammar constraints fixed the formatting completely and it
   still produced 0 of 12 sprites that depicted their subject. It emits primitives; code rasterises.
2. **The model cannot judge its own renders.** 1–4/10 on counting. Only simple binary presence
   questions about one image work, at 20/20.
3. **CLIP is the scorer, for candidates of one prompt only.** A good stone tower scores below a
   mediocre mushroom, so it is a sort order inside a batch and never a quality bar.
4. **Organic and architectural subjects work; directional machines do not.** A tank comes back
   front-to-back reversed and no prompt fixes it.

Three more, measured 2026-08-08 against the live server after "a cat" came back twelve times as a
brick. All three are in `src/gen/ops.ts` and `src/gen/llama.ts`, with the numbers:

5. **The op language is y-up, and the rasteriser swaps to the z-up `Volume`.** The prompt said "z =
   up" and the model ignored it every time — legs at the four corners of the x–z plane, head at high
   `y`. It writes the convention its training data is written in, whatever it is asked for.
6. **The grid is fitted to the ops, never to the `size` the reply declared.** Every reply measured
   painted outside its own declared size, and the dropped writes were always the detail: the ears,
   the tail. `size` still travels with the record; it just does not decide what survives.
7. **One worked example, as a prior turn, is worth more than every rule in the system prompt.** A
   schema-constrained reply starts emitting JSON on the first token, so it has nowhere to think, and
   rules in prose do not survive that. One example took "a cat" from 0 recognisable of 12 to 4 of 4.
8. **There are four examples because one is not neutral.** With only the dog in the prompt, "a
   chicken" came back with four legs and "a fish" came back a slab; cats were fine only because a
   cat is a quadruped. `EXAMPLES` holds one per body plan and one cheap unconstrained call picks
   which — `PLAN_SYSTEM`, one word, about two seconds, once per batch rather than per candidate.
   Anything unrecognised falls back to `building`, the example with no limbs and no posture. Plant
   and building are the strongest; bird is the weakest and still sometimes leaves a mirror seam.

Four things were tried against the same problem and **all four failed**. Do not spend a session
re-running them:

- **Feeding the renders back and asking for a revision.** The critique is accurate and specific
  ("the body is taller than it is long", "the legs do not reach the bottom"). The revision is the
  same JSON: 434 → 434 → 434 voxels over three rounds. The model re-emits; it does not edit.
- **Feeding the voxel grid back as ASCII silhouettes** instead of pictures. Identical outcome.
- **Carrying the critique into a fresh conversation** as notes, with no prior JSON in context. It
  looked like a fix at n=3 and was a wash at n=6, for three times the wall clock.
- **The model as a yes/no judge over candidates**, which finding 2 says is its one reliable vision
  skill. It gave 4/4 and 1/4 to pictures that could not be told apart. It does not rank.

What is different from the legacy build: **nothing rasterises a spec twice.** Legacy shipped the op
list to Python and re-rasterised and re-rendered it there with the sprite stacker, so two
rasterisers and two renderers had to agree byte for byte. `py/clipserve.py` now takes the PNGs the
CPU raycaster already made and does nothing but CLIP. The evolutionary refiner is deliberately not
carried over — it optimises reliably against an objective that makes the sprite worse.

Measured 2026-08-08, end to end in Chromium against the live server: **7–20 s per candidate**,
sequentially because llama-server has two slots and shares both GPUs; **83 ms** to render 24 ranking
views on the CPU; **~0.2 s per candidate** to score four views with CLIP, plus 4.6 s to load it
once. The built-in score and CLIP picked the same winner out of six, at a rank agreement of 0.17 —
low because four of the six were solid bricks that tie at the top of any deterministic score.

```bash
bun run clip          # .venv/bin/python py/clipserve.py — optional, port 8765
```

Neither service is required to open the app. With llama-server down the menu item opens a dialog
that says so and disables its one button; with `clipserve.py` down the batch ranks on the built-in
scores.

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
