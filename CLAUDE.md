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

| Path                | Holds                                                                            |
| ------------------- | -------------------------------------------------------------------------------- |
| `src/render/`       | the CPU raycaster, the shader it is mirrored by, the camera, the WebGL2 renderer |
| `src/vox/`          | `.vox` → `Volume`                                                                |
| `src/doc/`          | cameras, the brush, edits, undo, selection, transforms, symmetry, figures        |
| `src/doc/gesture`   | what the pointer does to voxels: aiming, strokes, drags, and the outline         |
| `src/doc/files`     | the `.gpix` save format, the disk behind a port, and the new-project templates   |
| `src/sheet/`        | packing cameras into the six output sheets, and whether the last bake is stale   |
| `src/image/`        | PNG encoding                                                                     |
| `src/viewport/`     | orbit/pan/zoom as a pure function, and the React canvas                          |
| `src/app/`          | the whole app as one value and one `reduce`, plus the panels that show it        |
| `src/app/session`   | New, Open, Save, the palette, the picture drop — every path to the artist's disk |
| `src/app/keys`      | every keyboard shortcut, as one table                                            |
| `src/app/overlay`   | projection, the ground lattice and the ghost's meshes — no SVG in it             |
| `src/gen/`          | the local-AI pipeline: prompt → primitives → voxels, and the two scorers         |
| `src/gen/batch`     | one batch end to end: generate, score, name, rank — the dialog just draws it     |
| `src/gen/reference` | the artist's own model as the example the next batch is taught from              |
| `src/gen/teaching`  | which examples teach a batch, in what order, within what line budget             |
| `src/theme/`        | `theme.ts` and the CSS it generates; never edit the CSS                          |
| `py/`               | `clipserve.py`, the CLIP scoring service. Optional, started by hand              |
| `browser/`          | the Playwright suite and the page it drives                                      |

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
8. **There are several examples because one is not neutral.** With only the dog in the prompt, "a
   chicken" came back with four legs and "a fish" came back a slab; cats were fine only because a
   cat is a quadruped. The bank holds one per body plan and one cheap unconstrained call picks which
   — `pickPrompt`, a few ids, about two seconds, once per batch rather than per candidate. Anything
   unrecognised falls back to the manifest's `fallback`, the example with no limbs and no posture.
   Plant and building are the strongest; bird is the weakest and still sometimes leaves a mirror
   seam.

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

The worked examples are the ceiling, so they live on disk. `src/assets/examples/` is one directory
of models plus `examples.json` describing them; `src/gen/library.ts` decomposes each one losslessly
into `box(...)` code when the generate dialog opens. No build step. An entry with no `file` teaches
with the hand-written reply in `src/gen/builtin.ts`, which is how all five ship today. The picking
call's prompt is generated from the manifest, so adding an entry needs no code. Read
`src/assets/examples/README.md` before adding one.

A `.vox` or `.gpix` dropped on the generate dialog teaches the next batch ahead of the bank, and is
remembered in `localStorage`. **`MAX_PICKS` is 3 and the measurement says it should be 1** — the
picking call pads when unsure, so a knight gets `farmer, chicken, dog` and grows the chicken's comb
on its helmet. See `docs/GEN_RESEARCH.md`, 2026-08-09. It stays in `bank.ts` rather than moving to
`teaching.ts` with the other three rules, because `pickPrompt` writes the cap into the sentence it
sends the model: the number and the prompt that states it have to move together.

**`veto.ts` costs a second 27B call per candidate whose word did not match** — `couldDescribe` — and
the only thing that call moves is the `matched` count in a status line. That is a product decision
(`FEATURESET.md`'s naming brief: the judge names a sprite and does not get to reject it), so it
stands, but it is the most expensive thing in `src/gen/` per unit of what it changes.

```bash
bun run clip          # .venv/bin/python py/clipserve.py — optional, port 8765
```

Neither service is required to open the app. With llama-server down the menu item opens a dialog
that says so and disables its one button; with `clipserve.py` down the batch ranks on the built-in
scores.

## Nine seams worth knowing about

The app layer is deliberately thin, and nine modules under it hold what would otherwise be spread
through React callbacks and reducer cases. Each one was pulled out because its rules could only be
tested by mounting something.

- **`src/doc/gesture.ts`** — every pointer gesture, over a `Gesture` interface that `AppState`
  extends. Eighteen fields, not fifty. It replaces two hand-written lists of the same field names
  (`AimKey` and `AIMED_AT`) that sat a thousand lines apart; `changedAim` is now the one comparison,
  and `forgetAim()` gives the hover cache an owner. The rule it exists to keep: **the outline cannot
  disagree with the edit** — every branch of `hoverAt` is a branch of `beginStroke` or
  `beginSelect`. `visible(state)` and `slicedFor(state, shown)` are the one derivation of "the grid
  as the artist sees it": the app used to spell the first half itself and draw from that, so in
  slice mode the picture was the whole model while the click landed on the sliced one.
- **`src/gen/batch.ts`** — one generation batch as a value. Stage order, cancellation and the three
  status lines. The measured rules live here: naming sorts nothing, CLIP goes last and the grid
  never waits on it, a dropped model is taught last. `GenerateDialog` holds one `BatchState`.
- **`src/sheet/baked.ts`** — a baked sheet carries the identity of what it came from, so staleness
  is computed. There used to be twenty-four hand-written `sheet: undefined` lines in the reducer and
  no test could cover the twenty-fifth case nobody had written yet.
- **`src/doc/files.ts`** — every file read off the artist's disk: the project picker, the palette
  loader and the generate dialog's reference model. `memoryFiles` holds bytes as well as text, so a
  `.vox` can be driven through it. `open` takes a `ReadFor`, and `remember` is the whole of it: only
  the project picker asks to become the file Save writes back to, which is why all three readers
  share one instance. **A `Files` is stateful and must outlive a render** — it used to be a default
  parameter on `App`, so the re-render caused by saving threw away the handle and every Ctrl-S
  opened the picker again. `store` and `files` are required props, built once in `main.tsx`.
- **`src/app/session.ts`** — the open document's lifecycle over that port: New, Open, Save, Save As,
  the palette loader, the picture drop, the snapshot restore, and the guard in front of the three
  that replace the document. Every command is ports and state in, an `AppAction` or `undefined` out,
  and **`undefined` always means the picker was cancelled** — the rule it exists to keep is that a
  cancelled picker is not a save and a save that did not happen is not a Discard. It replaced seven
  `useCallback`s and three `useState`s, of which `pending`/`asking`/`generating` were never
  independent and are now one `Dialog`.
- **`src/app/keys.ts`** — every shortcut as one table, over a `KeyPress` with the DOM taken off it.
  `swallow` is a field rather than a `preventDefault()` scattered through branches, so a new binding
  has to say what it does about the browser. `pressOf` is the only line in it that knows about a
  `KeyboardEvent`.
- **`src/gen/reference.ts`** — the artist's own dropped model as the example it teaches with. Read,
  decompose, budget-check, remember, forget. The rules: it is decomposed **at the moment of the
  drop** so the failure has somebody to tell; it is remembered as the example and never as the file;
  and **anything that fails leaves the previous teacher standing.**
- **`src/gen/teaching.ts`** — which examples teach a batch, in what order, within what budget. The
  order (closest last) was a `.reverse()` in `library.ts`, the composition (the dropped model goes
  after the bank) was a lambda in `batch.ts`, and `LINE_BUDGET` was enforced in `reference.ts` and
  **nowhere else** — so a 200-line model was refused at the drop and accepted from the bank
  directory. `WorkedExample` is only constructible here, through a call that can fail.
- **`src/app/overlay.ts`** — the arithmetic behind the viewport overlays: projection, the
  two-lattice floor with its falloff and its hole, and the ghost's skin, wireframe and shadow. It
  was 925 lines inside `ViewportOverlay.tsx`, reachable only by rendering SVG and parsing the
  strings back — `expect(run.moves('outline')).toBe(20)` was a claim about geometry expressed as a
  count of `M` characters. The components stringify points; nothing in `overlay.ts` knows what SVG
  is.

Two more things about the app layer that are not modules:

- **A panel takes `state` and `dispatch`, not one prop per control.** `ExportPanel` used to take
  fifteen props, and about three hundred lines of `App.tsx` were the one-line arrows filling them in
  — a hand-maintained restatement of `AppState` and `AppAction` in four places. The two kinds of
  prop that stay are the ones that are not state: memoised derivations (`shown`, `drawn`, `sheet`),
  and anything that goes through a port, because a panel must not get to decide which disk a read
  goes through.
- **`Chrome` in `state.ts`** is what the artist sees and does not ship — eleven fields behind one
  `{type: 'chrome'}` action, including both list drags: the views strip's camera and the objects
  panel's row are one gesture, and one of them used to be a `useState` inside the panel.
  `CHROME_IS_NOT_SAVED` makes "never in the save file, never in the undo history" something the
  compiler checks.
- **`output` in `state.ts`** got the same treatment, for the opposite reason: everything in it
  _does_ travel in the `.gpix`. It **is** `doc/save.ts`'s `SavedOutput`, not a copy — five flattened
  fields, four `{...state, x: action.x}` cases and five entries in `DOCUMENT_FIELDS` are one field,
  one `{type: 'output'}` action and one entry now.
- **`handle.ts` is write-only.** The app imports `publish` and `markDrawn` and cannot reach the
  reader. `App.tsx` used to read `handle.state` in Save — a real correctness requirement met by a
  testing singleton, which two mounted apps would have shared. It is a ref now.

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
  DOM. It is a deliberate seam and the app only ever writes to it — through `publish`, which is the
  only thing it imports from there.

`test/preload.ts` registers happy-dom for every test via `bunfig.toml`, so `document` is always
available.

## Commands

```bash
bun run check        # format:check + lint + typecheck + test — the gate, 14 s, no browser
bun run test         # bun test — scoped to src/ by bunfig.toml
bun run build        # deployable app bundle to dist/ (not a package — no .d.ts, no lib entry)
bun run test:browser # the Playwright suite — separate, does not gate `check`, 1.4 min
bun run dev          # the app on :1430
bun run theme        # rebuild src/theme/gofer-pixel-theme.css from src/theme/theme.ts
bun run format       # prettier --write
```

`lint` and `format` are cached (`.eslintcache`, prettier's own).

**Measured 2026-08-09:** `bun test` is 9.0 s for 559 tests, and `App.test.tsx` is 7.2 s of it. The
cost is 32 whole-window mounts at roughly 220 ms each, and **the mount is what costs under
happy-dom, not the assertions** — mounting one astryx panel is ~50 ms and mounting a bare SVG
component is ~1 ms. It was 13.1 s for 536 tests and 55 mounts before `test/panel.tsx`.

**`test/panel.tsx` is the harness under the panel seam.** `mountPanel(volume, draw)` puts one panel
over a real `useReducer(reduce, …)` and hands the test `state()`, `dispatch`, `click` and `act`. A
panel already took `state` and `dispatch` and nothing else — that _is_ the seam; nothing was using
it. Nineteen tests moved onto it and cost a fifth of what they did. It is not a mock: the reducer is
the real one, so the assertion is the same assertion the window made, minus the fourteen panels that
were not under test. **`App.test.tsx` is for composition** — effects, the keyboard listener, the
file dialogs, the guard in front of them, and the one live viewport.

Before reaching for a mount, check whether the thing under test has a seam already: `state.ts`,
`gesture.ts`, `session.ts`, `keys.ts`, `batch.ts`, `reference.ts`, `teaching.ts`, `overlay.ts`,
`store.ts`, `export.ts` and `baked.ts` all answer their own questions in single-digit milliseconds,
and they exist because the answers used to cost a window. If it is one panel and a real reducer,
that is `test/panel.tsx`.

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
