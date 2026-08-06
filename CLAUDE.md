# gofer-pixel

Local pixel-art generation via sprite stacking. A Python research pipeline and a TypeScript library
share this directory.

## Read these first, in order

1. `PRODUCTION_PLAN.md` — what is being built and why. §14 lists what is _not_ settled.
2. `DESIGN_PROGRESS.md` — the research record. Opens with a START HERE section.
3. `results.html` — visual summary of the Python pipeline's output.

## Before changing the renderer

`src/vox/parity.test.ts` pins the TypeScript renderers to SHA-256 hashes of the Python's output. It
passing means the port is pixel-identical; it failing means output changed.

If a change _should_ alter pixels, regenerate the hashes deliberately from the Python and say so in
the commit — do not adjust them to make a red test green.

```bash
.venv/bin/python -c "
import hashlib, voxslice, voxrender
size, voxels, pal = voxslice.read_vox('car.vox')
ra, rn = voxrender.rotation_sheet(size, voxels, pal, 8, 2)
print(hashlib.sha256(bytes(ra[2])).hexdigest()[:16])
"
```

**Fixed 2026-08-06 — axis-aligned striping.** The centring offset is now floored in both
`voxrender.py` and `src/vox/render.ts`; a fractional offset used to collapse adjacent voxel columns
at 0/90/180/270 and lose ~45 % of the visible model. The parity hashes were regenerated from the
Python afterwards. `src/vox/render.test.ts` pins the property (every occupied column survives at
every axis-aligned angle) so it cannot come back. Sprites exported before this date are wrong at
four angles in every sixteen.

## The document model

`src/doc/` is the editor's foundation and is deliberately independent of `src/vox/`.

- A `Volume` is copy-on-write over 8³ chunks. Cloning shares every chunk and revokes the write
  claim, so the first write after a clone copies and later writes to that chunk do not. There is no
  refcount and nothing to release — dropping a volume is safe.
- A `Document` is immutable by convention. Every operation returns a new document sharing untouched
  layers, cels and chunks; `editCel` is the only path to changed voxels.
- Undo is whole-document snapshots (`History`), which is affordable only because of the above.
  Measured: 100 snapshots of a full 32³ model cost 48 KB against 3.2 MB copied naively.
- A palette operation that reorders or removes a colour **must** reindex the voxels and the ramps in
  the same operation — see `applyPaletteOrder`. Forgetting that is silent corruption.
- The project file is versioned JSON (`serialize.ts`). Bump `PROJECT_VERSION` and add a migration
  when its shape changes; loading an unknown version throws rather than half-reading. It is at
  **version 2** — v2 added `origin`, the prompt/seed/sampler behind a generated document, and a v1
  file migrates by simply not having one.

## The editor

`src/editor/` is split so that almost none of it needs a browser to test.

- `state.ts` is pure. A gesture is replayed from the snapshot it started on every time the cursor
  moves, so the preview and the committed result come from one code path and a drag is exactly one
  undo entry. `canvas.ts` turns a document into pixels and maps clicks back to voxels.
- `useEditor.ts` is the only React-aware part. Undo/redo are event handlers, not reducer actions —
  React re-invokes reducers in development, which would move the history cursor twice per keypress.
  Anything the UI renders comes from state, never from reading the mutable `History` mid-render.
- Voxel y is depth, canvas y is down. `flipY` is the one place that knows.
- `view3d.ts` / `brush3d.ts` / `select3d.ts` are the 3D mode, and they are pure too. A view is a
  mapping from volume axes to screen axes plus a depth order; every question the mode asks is one
  walk along a sorted ray.
- **`editCel` returns a new document whether or not the edit wrote anything**, so identity is not a
  test for "did something change". Use the operation's changed count — the 3D path and the tools
  both do, and an undo stack full of empty entries is what happens when you forget.
- `mutate` then `navigate` in `useEditor` is a trap: `navigate` spreads the snapshot captured when
  the handler was built, so it puts the old document back. Anything that changes the document _and_
  moves the cursor goes through `mutateAndGo`.

The panels are one per mode, switched at the top of `Editor.tsx` (`MODE_LABELS` is the list):
`PalettePanel`, `Viewport3D`, `GeneratePanel`, `ExportPanel`, `RigPanel`, `EffectsPanel`.

## The rest of the source

- `src/gen/` — generation. `ops.ts` is a port of `voxgen.py:rasterise` and is pinned byte-for-byte
  against the Python (`ops.test.ts`); `llama.ts` talks to `localhost:8080` with the JSON schema in
  `response_format`; `score.ts` is the deterministic candidate scoring; `clip.ts` is the client for
  the optional `voxserve.py` scorer, since CLIP itself cannot run in a page. `evolve.ts` is the
  op-list refinement loop — **deliberately not wired into the app**: it optimises reliably and the
  only objectives available make the sprite worse (PRODUCTION_PLAN.md §9, "then").
- `src/export/` — `atlas.ts` (sheet + normal sheet + sidecar), `godot.ts` (`.tres`, verified by
  loading it in Godot 4.7.1 headless), `strip.ts` (the Aseprite round trip).
- `src/vox/render-worker.ts` + `src/editor/bake.ts` — the atlas bake off the main thread. `runBake`
  is the pure job so it can be tested without a Worker, and `bakeAtlas` falls back to the calling
  thread wherever `Worker` is undefined. A `Document` cannot be posted to a Worker (it holds
  `Volume` instances, and a class loses its methods to structured cloning) — post `VoxModel`s.
- `src/vox/vox-scene.ts` — the `.vox` extension chunks. `writeVox` (single model, byte-identical to
  `voxgen.py`) and `writeVoxScene` (one model per layer, with `LAYR` and the scene graph) are both
  real exports; `readVox` merges every model into one volume, `readVoxScene` keeps them apart.
- `src/anim/rig.ts` — grid-constrained bones. Offsets are interpolated **then rounded**; that
  rounding is the feature, not a detail.
- `src/fx/` — `passes.ts` (outline, dither, palette cycling, Lambert, normal occlusion) and
  `expr.ts` / `voxelScript.ts` (the `voxel(x,y,z)` scripting surface). **`expr.ts` is hand-written
  instead of `new Function` on purpose**: a script may come from the model, and `Function` would
  hand it the whole page. Names resolve with `Object.hasOwn` so a prototype key cannot leak a real
  function; there is a test for exactly that.

## Commands

```bash
bun run check       # format:check + lint + typecheck + test — the gate
bun run test        # bun test
bun run build       # library bundle to dist/ plus .d.ts
bun run dev         # playground on :1430 — the editor (six modes), plus a .vox viewer tab
bun run format      # prettier --write
```

The Python side uses `.venv` (CPU torch, open_clip, pillow):

```bash
.venv/bin/python voxbatch.py "a red pickup truck" 10 out/truck
.venv/bin/python voxserve.py            # optional CLIP scorer on :8765 for the generate panel
```

`voxserve.py` is optional by design: the editor scores candidates deterministically on its own and
only asks the service for CLIP. Start it before generating if you want the candidate grid ranked by
CLIP — measured, the deterministic score saturates at 1.000 for box-shaped subjects and ranks
nothing (PRODUCTION_PLAN.md §14).

## Conventions

Toolchain and config are copied from `~/hub/gofer` and should stay in sync with it: ESLint 10 with
type-aware strict rules, Prettier (4 spaces, no semicolons, single quotes, no bracket spacing, print
width 100), TypeScript 6 with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

That combination bans non-null assertions on indexed access. Use a `?? fallback`, a `DataView` read,
or an early-return guard — not `!`.

Imports are extensionless. Python files, `out/`, `experiments/`, `DESIGN_PROGRESS.md` and
`results.html` are excluded from lint and format.

## Environment

- llama-server on `localhost:8080` — Qwen3.6-27B, vision in, 120k context, 2 slots. It is a separate
  root/container process split across both GPUs. **Do not restart it casually.** It sends permissive
  CORS headers, so the browser calls it directly; no proxy.
- Both GPUs sit at ~95 % VRAM with that model loaded. Nothing else gets meaningful VRAM; CLIP runs
  on CPU by necessity.
- WebGL2 under the Tauri webview here is **hardware**, measured 2026-08-06 with
  `experiments/webgl_probe.py` — 735× SwiftShader. Do not detect this by reading the renderer
  string: WebKit masks it and reports "Apple GPU" on an NVIDIA box. Time a draw instead.
- Godot 4.7.1 is at `/usr/bin/godot`, and `godot --headless --path <dir> --script <file.gd>` is how
  the exported `.tres` was verified.
