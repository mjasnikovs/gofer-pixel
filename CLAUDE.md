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
   disagree with FEATURESET.md, the mockups win. One region has been overruled since — the
   bottom-left settings box, which is gone; see the end of the app-layer notes below.
4. `docs/TASKS.md` — every unpostponed item of `FEATURESET.md`, in dependency order. All seventeen
   are built; what is left on it is the reworks the validation passes found.
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
replay pattern (`src/viewport/orbit.ts`), and `src/assets/car.vox` itself. Everything else in `src/`
is new.

What is there now, and roughly in dependency order:

| Path                | Holds                                                                               |
| ------------------- | ----------------------------------------------------------------------------------- |
| `src/render/`       | the CPU raycaster, the shader it is mirrored by, the camera, the WebGL2 renderer    |
| `src/render/light`  | the sun and the ambient floor, as the six-face table both backends multiply by      |
| `src/vox/`          | `.vox` → `Volume`                                                                   |
| `src/doc/`          | cameras, the brush, edits, undo, selection, transforms, symmetry, figures, the tape |
| `src/doc/gesture`   | what the pointer does to voxels: aiming, strokes, drags, and the outline            |
| `src/doc/files`     | the `.gpix` save format, the disk behind a port, and the new-project templates      |
| `src/sheet/`        | packing cameras into the eight output sheets, and which of them would be blank      |
| `src/image/`        | PNG encoding                                                                        |
| `src/viewport/`     | orbit/pan/zoom as a pure function, and the React canvas                             |
| `src/app/`          | the whole app as one value and one `reduce`, plus the panels that show it           |
| `src/app/session`   | New, Open, Save, the palette, the picture drop — every path to the artist's disk    |
| `src/app/keys`      | every keyboard shortcut, as one table                                               |
| `src/app/overlay`   | projection, the ground lattice and the ghost's meshes — no SVG in it                |
| `src/gen/`          | the local-AI pipeline: prompt → primitives → voxels, and the two scorers            |
| `src/gen/batch`     | one batch end to end: generate, score, name, rank — the dialog just draws it        |
| `src/gen/reference` | the artist's own model as the example the next batch is taught from                 |
| `src/gen/teaching`  | which examples teach a batch, in what order, within what line budget                |
| `src/theme/`        | `theme.ts` and the CSS it generates; never edit the CSS                             |
| `py/`               | `clipserve.py`, the CLIP scoring service. Optional, started by hand                 |
| `browser/`          | the Playwright suite and the page it drives                                         |

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

## Twenty-one seams worth knowing about

The app layer is deliberately thin, and twenty-one modules under it hold what would otherwise be
spread through React callbacks and reducer cases. Each one was pulled out because its rules could
only be tested by mounting something, or by building a whole `AppState` to ask a question about four
fields.

- **`src/doc/gesture.ts`** — every pointer gesture, over a `Gesture` interface that `AppState`
  extends. Eighteen fields, not fifty. It replaces two hand-written lists of the same field names
  (`AimKey` and `AIMED_AT`) that sat a thousand lines apart; `changedAim` is now the one comparison,
  and `forgetAim()` gives the hover cache an owner. The rule it exists to keep: **the outline cannot
  disagree with the edit** — every branch of `hoverAt` is a branch of `beginStroke` or
  `beginSelect`, and both of those reach `edits.ts`'s `writeBlock`, which is the one statement of
  what a write drops. That predicate was written out twice, line for line, in two files, and it
  agreed only by coincidence of what `openDraft` happened to pass; `writeOwned` asks it before
  writing and the outline asks it without writing. `visible(state)` and `slicedFor(state, shown)`
  are the one derivation of "the grid as the artist sees it": the app used to spell the first half
  itself and draw from that, so in slice mode the picture was the whole model while the click landed
  on the sliced one.

    **`pointerAt(state, event)` is the interface, and the twelve gestures behind it are not
    exported.** The ordering between them — which of them an event belongs to — was forty lines of
    `app/state.ts`, so a module written to be testable without a window had five tests while forty
    of its own claims were made through `reduce`. Two rules are now stated by the shape: a gesture
    in progress owns every event until it ends, and the right and middle buttons and Shift always
    move the camera. `took: false` comes back rather than a camera move being made here, because
    turning the view means saying which stored camera the result is no longer, and a click on the
    model may not reach the camera list. The rubber band's _continue_ step had no owner at all
    before this and carried only `x1`/`y1`, four hundred lines from the `endBand` that reads
    `width`/`height`.

- **`src/render/light.ts`** — the viewport's sun and ambient floor, `FEATURESET.md` §21, which used
  to be a disabled button in the header. **Nothing it does is exported, and that is the feature, not
  a limitation.** Lighting is the game engine's job — that is what §21 said and what the normal,
  depth and AO maps are for — so a lit colour map reaching an engine would be lit twice by two
  lights that know nothing about each other. It therefore sits in exactly the same category as the
  voxel lattice: one thing the interactive view draws that the CPU exporter is never asked for.
  Every thumbnail, the render panel and the whole export dialog stay flat, because each of those
  stands for a file. It is `Chrome`, so it is not in the `.gpix` and not in the undo history.

    It is one module and no second renderer because **a voxel face is flat, so a directional light
    can only ever say one thing per face**: a sun's entire effect _is_ the six-integer table
    `faces.ts` used to hand-write. The table is whole numbers over 256 and that is the parity
    contract, not a habit — `floor(channel * light / 256)` is exact in float32, so a `float` sun
    computed in the shader would land the two backends on different bytes. It moved from a compile-
    time constant in `raycast.glsl.ts` to a uniform, and the lit parity test in `browser/` is what
    holds the shader to the CPU oracle across that change. `lightFor` returns `FACE_LIGHT` _itself_
    when the sun is off, because the identity is the viewport's render dependency.

    Four things are deliberate and are in its tests. **Off is the default**, because nobody should
    get a light they did not ask for — and because the hand-tuned table is not a sun, so "on" could
    not be made to mean what the app has always drawn. **The term is half-Lambert, not Lambert**:
    clamped, every face turned away ties at the ambient floor and the shaded side of a model becomes
    one flat silhouette. **The default azimuth is 30° and not 45°**, because at 45° the `+x` and
    `+y` faces take the same dot product and the two visible sides of a box come out one tone. The
    normal comes from `FACE_STEP`, not `FACE_NORMAL_RGB`, which is asymmetric about zero — decoding
    it gives a vector of length 1.0079 on the negative side, enough to land a face one byte off its
    own opposite when the sun turns through 180°. **A point light is the line this stops at**: it
    varies across a face, so it is per-pixel, and it needs shadows, which is a second ray march.

    `LightPanel.tsx` is sliders in the right-hand rail rather than steppers in the brush column, and
    it updates on `onChange` rather than `onChangeEnd`. A sun is aimed, not set — the artist sweeps
    it until the shape reads — and that is affordable precisely because it stops at the viewport: a
    step costs one GPU frame and touches no thumbnail, no sprite-cache entry and no sheet. Its reset
    button spreads `{...DEFAULT_LIGHTING, on: true}` and **the `on: true` is load-bearing**: the
    default is off, so the plain spread turned the sun off and unmounted the panel the click landed
    in, with the switch to bring it back four hundred pixels away in the header.

    The header's lit glyph is a span of ours _inside_ astryx's icon slot, not a class on the button.
    Astryx styles its buttons with StyleX and a plain class on the same element loses — measured in
    the running app, the button computed `rgb(197, 189, 243)` while `--color-text-accent` in that
    same header read `#a08cf6`. The button keeps its ghost face rather than taking
    `variant='primary'`, because Export is the one filled button in the window.

- **`src/doc/measure.ts`** — the tape between two voxels, and the only decision Measure has in it.
  The tool was a greyed button in the rail for as long as it was not built, with a tooltip saying
  the left button still turned the view; it is `beginSpan`/`continueSpan`/`endSpan` in `gesture.ts`,
  a `gauge` hover kind, `spanMesh` in `overlay.ts` and a `Span` hint in the bar. **It is the one
  tool on the rail with no draft behind it**, so nothing downstream holds it honest — no
  `writeBlock`, no history, no golden hash — which is why the arithmetic is a module with its own
  tests instead of two lines in a component.

    Three things are deliberate. **The size counts both ends and the diagonal does not**: grabbing
    the bottom voxel of a four-tall leg and dragging to the top one reads 4, because 4 is what an
    artist counts, while the centre-to-centre distance is a length and a `+ 1` on it would be
    arithmetic about nothing. The two are counted differently on purpose and the hint bar's tooltip
    is where that is said out loud. **The tape outlives the button**, because reading it is the
    whole gesture — a settled one is `live: false`, which is also what stops it eating every pointer
    move that crosses the model afterwards. And **only Measure draws it**: it stays on the state
    across a tool change, so coming back finds the measurement where it was, but a ruler lying over
    the model through every stroke of a session is clutter. That last rule is a `const` in
    `Stage.tsx`, because the overlay and the bar both need the same answer.

    A press on air puts the tape away, which is the same reading `endBand` gives a click on nothing
    and the only way to be rid of one — a press over the model is always a new measurement, never a
    clearing. There is no Escape binding: `keyAction` takes one boolean of document state on
    purpose, and Escape already means "drop the selection", which is a different thing to be
    holding.

- **`src/render/perfect.ts`** — whether a voxel lands on whole pixels, and at which zooms it would.
  `FEATURESET.md` §14 words the rule as "integer zoom" and **that is the wrong invariant**: zoom is
  voxels-tall of the frame, and what lands on the grid is `cell / zoom`, pixels-tall of a voxel. The
  camera every new 16³ document opens on is zoom 31 — an integer — and 64/31 is 2.06, so a row of
  voxels exports `3 2 2 2 2 2 2 2 3`. Everything here is derived from `basisFor`, never from a
  second copy of the projection, so the snap and the `Math.fround` are part of the answer. Three
  measured facts live in its tests: **true isometric has no pixel-perfect zoom at any zoom**, its
  screen slope being `1/√3`; **2:1 dimetric has an exact horizontal slope and still no perfect
  zoom**, its height being `√1.5` of its half-step, which is why hand-drawn 2:1 art squashes the
  vertical and an orthographic camera cannot; and **`asin(1/3)`, 19.47°, is the one three-quarter
  angle that closes** — 3 across, 1 down, 4 tall, every component whole. `perfectZooms` returning an
  empty list is the honest answer for an angle with no lattice, and nothing downstream invents a
  fallback for it.

    **`asin(1/3)` was a fourth ring pitch for one session and was removed, deliberately.** Measured
    on a solid cube: the top face is 33% of the sprite at true isometric, 29% at 2:1 and 20% at
    19.47°, so it costs a third of the roofs and shoulders that carry a voxel silhouette — and every
    tileset in existence is 2:1, so a sheet built at it lines up with nothing. Even stairs are not
    worth a sprite that matches nothing and shows less. The arithmetic stays in `perfect.test.ts` so
    nobody re-derives it and puts the button back. **The default ring pitch is `dimetric`**, 2:1,
    not true isometric — true isometric is the angle voxel art is modelled at, not the angle it is
    drawn at.

- **`src/gen/batch.ts`** — one generation batch as a value. Stage order, cancellation and the three
  status lines. The measured rules live here: naming sorts nothing, CLIP goes last and the grid
  never waits on it, a dropped model is taught last. `GenerateDialog` holds one `BatchState`.
- **`src/doc/views.ts`** — the camera list as one value: `cameras`, `selected`, `previewed` and
  `serial`, extended by `AppState` the way `Gesture` is. It was eight reducer cases maintaining four
  fields by hand — `capture` and `duplicate` the same five lines twice, `delete` and `directions`
  each re-deriving the fallbacks. The invariant it exists to keep is `pointing`: **neither pointer
  may name a camera that is not on the list.** A dead `selected` becomes nothing, because the
  strip's highlight is a claim about the view; a dead `previewed` falls to the first camera, because
  the render panel has to point at something.
- **`src/doc/reference.ts`** — the pictures the artist builds against, not just their type. One
  `applyReference(references, op)` over `readonly Reference[]`, with one `refuses` predicate; place,
  fade, lock and drop are behind it and not reachable from outside. The lock used to be spelled
  three different ways across four reducer cases and left out of the fourth, so **dropping a new
  picture onto a locked plane silently replaced it.** Those four cases were also four bodies that
  each read `{...state, references: f(...)}` — one `{type: 'reference'; op}` now, the same fold
  `TransformOp` and `ObjectOp` got, for the same reason.
- **`src/sheet/presets.ts`** — export presets and their four rules: a built-in name cannot be taken,
  saving over your own replaces it, dropping the selected one falls back to the default, an empty
  name is refused. `applyPreset` returns `undefined` for "refused", so the reducer case cannot
  invent a different fallback. `presetNamed` is the one place a version-1 file's empty string
  becomes a name.
- **`src/gen/connect.ts`** — how far the generate dialog has got in reaching the local model, as one
  `Connection` union. It was four `useState`s set in sequence inside one effect: sixteen
  combinations, three reachable, and the offline path could only be seen by mounting the dialog. The
  order is the rule that lives here — the picking call's prompt _is_ the manifest, so the bank has
  to load before a client can be built.
- **`src/sheet/choice.ts`** — which maps this export is going to write while the artist is still
  deciding: seeded from the selected preset, reseeded when the selector moves, thrown away when the
  dialog closes. The preset is the memory; these are the ticks. Three rules live here because all
  three get spelled twice and then differently — **colour is never optional** (`renderSheet` adds it
  back regardless, so an unticked box would write the file anyway), **an empty map is never written
  even when the preset names it**, and **choosing a preset replaces the ticks**. `shipped` is the
  one derivation the zip, the loose PNGs and the count all read.
- **`src/sheet/empty.ts`** — which of the eight maps would be written blank. Emission is black
  unless a palette entry the model actually uses glows; object id is one flat value until the model
  is split. The question is asked of **the baked sheet, not the volume**, and that is the whole
  design: "no voxel glows" and "this sheet's emission map is black" are different questions once an
  object can be hidden, sliced away, or simply behind the model from every camera on the list.
- **`src/image/zip.ts`** — a store-only zip, so an export is one file instead of nine. No
  compression: everything in the pack is either a PNG `encodePng` already deflated or a few
  kilobytes of JSON. Verified against `unzip -t` and Python's `zipfile`; its own test reads the
  archive back **through the central directory**, which is the direction an unarchiver reads and the
  only one that can catch an offset pointing at the wrong place.

`sheet/baked.ts` used to be here, and its deletion is worth knowing about. A bake outlived the click
that made it, so "is that still the sheet for this document?" needed a key of seven identities and a
comparison, and twenty-four reducer cases had to remember not to break it. The sheet is a `useMemo`
inside `ExportDialog` now, over the four things it is made of — `volume`, `cameras`, `cell`,
`padding`: a memo cannot hand back a sheet for a document that has moved, and its dependency list
_is_ the key with the compiler checking it.

- **`src/doc/files.ts`** — every file read off the artist's disk: the project picker, the palette
  loader and the generate dialog's reference model. `memoryFiles` holds bytes as well as text, so a
  `.vox` can be driven through it. `open` takes a `ReadFor`, and `remember` is the whole of it: only
  the project picker asks to become the file Save writes back to, which is why all three readers
  share one instance. **A `Files` is stateful and must outlive a render** — it used to be a default
  parameter on `App`, so the re-render caused by saving threw away the handle and every Ctrl-S
  opened the picker again. `store` and `files` are required props, built once in `main.tsx`.
  **`write` is the other half of it**: no picker, no handle, no cancel, bytes or text. Every export
  used to build its own `document.createElement('a')` in `app/download.ts`, three lines from the
  identical anchor in here — two disk seams, and the one with no adapter under it was the whole of
  what the artist ships. Its tests replaced three globals per file and still could not read a byte,
  because happy-dom's `blob:` handle is opaque.
- **`src/app/session.ts`** — the open document's lifecycle over that port: New, Open, Save, Save As,
  the palette loader, the picture drop, the snapshot restore, and the guard in front of the three
  that replace the document. Every command is ports and state in, an `AppAction` or `undefined` out,
  and **`undefined` always means the picker was cancelled** — the rule it exists to keep is that a
  cancelled picker is not a save and a save that did not happen is not a Discard. It replaced seven
  `useCallback`s and three `useState`s, of which `pending`/`asking`/`generating` were never
  independent and are now one `Dialog`. The transitions are here too, not in JSX: `discarded` and
  `savingFirst`, whose `then(saved)` is where the rule actually lives. It used to be a
  `take → doSave → then → take` dance inside `UnsavedDialog`'s `onSave` prop.
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

- **`src/doc/history.ts`** — `commit(state, draft, also?)`: how a draft becomes an entry in the
  history, which is the inverse of `undo`/`redo` and therefore lives with them rather than in
  `edits.ts`, which cannot import `record` without a cycle. It was written out eight times — five
  reducer cases and three gestures — with **three different answers to "the draft changed nothing"**
  and only the two that had to remembering to stamp the object list onto the edit. That omission is
  commit `eaa7b23`. `undefined` back means nothing happened and the caller hands back what it was
  given, which matters beyond the history: `draft.volume` is a fresh object, so a caller that
  returned it anyway would mark the document dirty over an edit that moved no cell.
- **`src/app/Stage.tsx`** — the viewport and the eight things drawn over it, behind the same three
  props a panel takes. `App.tsx` used to thread `volume` and `camera` into nine children by hand and
  compute two derivations nothing else read: the box round the selection, and the name of the locked
  object the hint bar reports. The second had no test at all. The picture drop stays a callback,
  because it goes through `Files` and comes back as an action somebody has to dispatch.
- **`src/gen/ask.ts`** — what the artist is asking the model for: prompt, count, naming, and the
  rank order they clicked. Four `useState`s and four rules written inline in JSX, **two of them
  written twice** — the count's bound as both a field `max` and a clamp, and the start guard as
  `!busy && connection.kind === 'ready'` on Enter and `!busy && connection.kind !== 'ready'` on the
  button. `startable` is the one call both now make.

More things about the app layer that are not modules:

- **A panel takes `state` and `dispatch`, not one prop per control.** The export panel used to take
  fifteen props, and about three hundred lines of `App.tsx` were the one-line arrows filling them in
  — a hand-maintained restatement of `AppState` and `AppAction` in four places. The two kinds of
  prop that stay are the ones that are not state: memoised derivations (`shown`, `drawn`), and
  anything that goes through a port, because a panel must not get to decide which disk a read goes
  through.
- **Export is a dialog, and the preview is the export.** It was the third section of the right-hand
  rail, on screen for every stroke of every session, and the header's Export button baked and
  downloaded on the click with no way to see it first. It is `ExportDialog.tsx` now, behind that
  same button: eight maps, one tab each, and **every cell on screen is `cutCell` out of the sheet
  the buttons write**. Nothing in it re-renders anything for display — `app/sprite-cache.ts` exists
  for the viewport, covers five of the eight maps, and its depth is a _view_ mode its own comment
  says is not what gets exported. A preview built on it would have disagreed with the download for
  three maps out of eight, silently, in the one panel whose job is to show what lands on disk.

    The dialog calls `app/download.ts` directly. There was an `app/export.ts` between them for a
    while, four functions over `AppState` and the sheet, and one of them — `writeLoose` — was
    `writeSheet` with the same three parameters in the same order and no transformation. The dialog
    imported from both files, so the split it was meant to make did not exist at the call site, and
    its tests asserted on bytes `download.ts` produced. The one thing in it with a decision in it
    was `exportMetadata`, which is a function in the dialog now, called from the two menu items that
    need it rather than memoised: `shownVolume` walks the whole grid and no render reads the answer.

- **`Chrome` in `state.ts`** is what the artist sees and does not ship — twelve fields behind one
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
- **The mockup's bottom-left settings box is gone, and the layout is four columns.**
  `96px 216px minmax(0, 1fr) 384px`, with the rail and the camera rail spanning both rows and the
  views strip alone in row two. The box was drawn holding two switches and a number and ended up
  holding four switches, symmetry, the drawing plane, the reference rows and the number — 259 px of
  content in a 260 px box, so the first dropped reference picture clipped the voxel size off the
  bottom of an `overflow: hidden` panel. The switches are in the rail, which runs the whole height;
  the rest is `ScenePanel.tsx` under the palette, in a column that scrolls and therefore cannot
  clip. This is the one place the mockups have been overruled rather than followed, and the reason
  is that the content outgrew the region three times over.
- **The four view switches are icons with no box, and that is the second attempt.** The first gave
  them the tool button's face — icon over label, accent fill when on — which is one visual language
  for one column and was wrong for a reason no argument about pixels finds: three of the four are on
  by default, so three accent-filled boxes sat under one armed tool and **the loudest thing in the
  rail was its resting state**. Off is the same grey as an unarmed tool, never a dimming, because
  faded means "not built yet" in this column and Measure is sitting four rows up saying so. The
  track that came before both went with the box: it needs about 160 px and the rail is 96.

## Testing — nothing waits

**A test that contains a duration is a broken test.** No `sleep`, no `waitForTimeout`, no `waitFor`,
no polling, no `@testing-library/user-event`, no animated scrolling, no screenshot diffing.

- React updates flush synchronously inside `act()`. There is nothing to wait for.
- Clicks are `element.click()` on a real happy-dom node — 1.3 ms with astryx components mounted.
- The viewport exposes `renderNow()` and a frame counter, so a test awaits _a frame having landed_,
  never milliseconds. The render loop must be drivable, not owned by `requestAnimationFrame`.
- Golden pixel hashes come from the CPU raycaster. It is the oracle and it needs no GPU.
- Playwright is 60 tests for what cannot exist outside a browser, and it does not gate
  `bun run check`. Chromium needs
  `--use-angle=vulkan --enable-features=Vulkan --use-gl=angle --ignore-gpu-blocklist` or it silently
  falls back to SwiftShader and is 51× slower.
- `gl.finish()` does **not** make a frame land — Chrome's command buffer returns from it long before
  the GPU is done, and a benchmark built on it reports 0.006 ms on software rendering. `renderNow`
  reads one pixel back instead, which really blocks, costs ~0.2 ms, and is what makes the frame
  counter mean anything.
- The browser suite drives the running app through `src/app/handle.ts` rather than by polling the
  DOM. It is a deliberate seam and the app only ever writes to it — through `publish` and
  `markDrawn`, the only two things it imports from there. `main.tsx` imports the handle itself, and
  only to hang it on `globalThis`.

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

**Measured 2026-08-11:** `bun test` is 6.5 s for 713 tests across 69 files, and `App.test.tsx` is
most of it. The cost is the whole-window mounts, and **the mount is what costs under happy-dom, not
the assertions** — mounting one astryx panel is ~50 ms and mounting a bare SVG component is ~1 ms.
It was 13.1 s for 536 tests and 55 mounts before `test/panel.tsx`. For scale at the other end:
`state.test.ts` is 95 tests in 271 ms, because `reduce` mounts nothing — a reducer test is not a
window test, and moving one to a `doc/` module buys correctness of interface, never time.

**`test/panel.tsx` is the harness under the panel seam.** `mountPanel(volume, draw)` puts one panel
over a real `useReducer(reduce, …)` and hands the test `state()`, `dispatch`, `click` and `act`. A
panel already took `state` and `dispatch` and nothing else — that _is_ the seam; nothing was using
it. Nineteen tests moved onto it and cost a fifth of what they did. It is not a mock: the reducer is
the real one, so the assertion is the same assertion the window made, minus the fourteen panels that
were not under test. **`App.test.tsx` is for composition** — effects, the keyboard listener, the
file dialogs, the guard in front of them, and the one live viewport.

Before reaching for a mount, check whether the thing under test has a seam already: `state.ts`,
`gesture.ts`, `session.ts`, `keys.ts`, `batch.ts`, `connect.ts`, `doc/reference.ts`,
`gen/reference.ts`, `teaching.ts`, `overlay.ts`, `views.ts`, `presets.ts`, `store.ts`, `export.ts`,
`history.ts`, `ask.ts`, `choice.ts`, `empty.ts`, `doc/measure.ts` and `render/light.ts` all answer
their own questions in single-digit milliseconds, and they exist because the answers used to cost a
window. If it is one panel and a real reducer, that is `test/panel.tsx` — and the stage is a panel
by that definition, so `Stage.test.tsx` mounts it there rather than mounting a window.

## Conventions

Toolchain and config are copied from `~/hub/gofer` and should stay in sync with it: ESLint 10 with
type-aware strict rules, Prettier (4 spaces, no semicolons, single quotes, no bracket spacing, print
width 100), TypeScript 6 with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

That combination bans non-null assertions on indexed access. Use a `?? fallback`, a `DataView` read,
or an early-return guard — not `!`.

Imports are extensionless. `legacy/`, `docs/spikes/` and `bunfig.toml` are excluded from lint and
format, as are `src/theme/gofer-pixel.js` and `.d.ts`. `bun run theme` writes those two plus
`gofer-pixel-theme.css`; the CSS is formatted, so regenerating means running `bun run format` after.

The theme is not decoration and it has a gate: `src/theme/theme.test.ts` measures the built CSS for
collapsed distinctions — text roles under 12 L* apart, a surface ramp step under 3 L*, an accent
within 12 L* of body text, a control border under 3:1 — and it runs inside `bun test`. The rules
themselves are in `src/theme/design-rules.ts`. Read `skills/gofer-ui/SKILL.md` before touching any
of it.

## Environment

- llama-server on `localhost:8080` — Qwen3.6-27B, vision in, 120k context, 2 slots. It is a separate
  root/container process split across both GPUs. **Do not restart it casually.** It sends permissive
  CORS headers, so the browser calls it directly; no proxy.
- Both GPUs sit at ~95 % VRAM with that model loaded. Nothing else gets meaningful VRAM; CLIP runs
  on CPU by necessity. **The browser suite therefore runs one worker.** Two Chromiums starting at
  once intermittently fail to bring up a hardware Vulkan device and drop to SwiftShader without
  saying so — measured over eight two-worker runs, five failed, at 58–63 ms per frame or with the
  viewport reading back an empty canvas. Serially it is stable, and the whole suite is ~1.3 min.
- A frame costs 0.17 ms on the idle GPU and up to 2.4 ms while llama-server is busy on the same
  card. Any timing assertion has to clear that 14× spread, not the idle number.
- WebGL2 under the Tauri webview here is **hardware**, measured 2026-08-06 with
  `legacy/experiments/webgl_probe.py` — 735× SwiftShader. Do not detect this by reading the renderer
  string: WebKit masks it and reports "Apple GPU" on an NVIDIA box. Time a draw instead.
- Godot 4.7.1 is at `/usr/bin/godot`, and `godot --headless --path <dir> --script <file.gd>` runs a
  script against it.
- `.venv` holds the Python side (CPU torch, open_clip, pillow) used by `legacy/py/`.
