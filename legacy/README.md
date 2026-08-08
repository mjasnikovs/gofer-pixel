# legacy — dead code, kept for reference only

Everything under this directory was the gofer-pixel built between 2026-08-06 and 2026-08-07. It is
**superseded**, not deprecated: none of it is imported, built, linted, typechecked or tested, and
none of it should be edited. It is here so a future session can read how something was done rather
than rediscover it.

The current project is described by `docs/techstack.md` and `docs/FEATURESET.md`. Start there.

## Why it was replaced

The old build rendered by **sprite stacking** — drawing each z-slice of a voxel model offset by a
couple of pixels. That produces a specific flat look, is CPU-bound to roughly 48³, and cannot
produce shadows, ambient occlusion, or the lit scenes in `docs/editor.png` and
`docs/featureset.png`. It had also grown three subsystems that appear nowhere in the feature spec:
an LLM generation pipeline, a voxel scripting/effects surface, and a bone rig.

The replacement renders by **raycasting**, written twice — TypeScript on the CPU for export and
tests, GLSL on the GPU for the viewport. See `docs/techstack.md` §2 for the measurements.

## What is worth reading, and what to be careful of

- `src/doc/` — the document model. A copy-on-write `Volume` over 8³ chunks, an immutable
  `Document`, snapshot-based undo. The measurements behind it are real: 100 snapshots of a full 32³
  model cost 48 KB against 3.2 MB copied naively, and 8³ chunks beat 16³ by 3.3×. **The design is
  sound; it was shaped around a renderer that no longer exists.** Re-derive, do not copy.
- `src/editor/state.ts` — a gesture is replayed from the snapshot it started on every time the
  cursor moves, so preview and commit share one code path and a drag is exactly one undo entry.
  This pattern is the single best idea in the old codebase and should be carried forward.
- `src/vox/vox-file.ts`, `src/vox/vox-scene.ts` — `.vox` read and write, byte-identical to
  `py/voxgen.py`. Format code, still correct.
- `src/image/png.ts` — a working PNG encoder with no dependencies.
- `src/gen/` — the LLM pipeline. **Carried over 2026-08-08 into `src/gen/`**, minus `evolve.ts`,
  which optimises reliably against an objective that makes the sprite worse and was never wired in.
  `py/voxserve.py` was replaced by `py/clipserve.py`, which takes rendered PNGs instead of op lists —
  so `ops.ts`'s byte-for-byte parity with `py/voxgen.py:rasterise` is no longer required and the
  Python rasteriser has no caller. See `docs/TASKS.md`.
- `src/vox/render.ts`, `src/vox/slice.ts`, `src/vox/render-worker.ts`, `py/voxrender.py` — the
  sprite-stacking renderer. **Superseded.** Read it only for the centring-offset story below.
- `src/fx/expr.ts` — a hand-written expression evaluator used instead of `new Function`, because a
  script could arrive from the model. If scripting ever returns, the reasoning holds.

## Two traps this codebase paid for, which still apply

1. **Axis-aligned angles are where voxel renderers break.** A fractional centring offset used to
   collapse adjacent voxel columns at 0/90/180/270° and lose ~45 % of the visible model; flooring
   the offset fixed it. The raycaster hit the same class of bug from a different direction —
   `cos(π/2)` is not zero in floating point — and needed the camera basis snapped. Assume every new
   renderer has this bug until a test proves otherwise.
2. **Python `round` is half-to-even and JS `Math.round` is not**, and voxel neighbour lookups need a
   size-independent key or out-of-bounds neighbours alias onto real voxels.

## What was settled by experiment and is not worth retesting

From `docs/DESIGN_PROGRESS.md`, which is the full research record:

- The model cannot draw pixels as text. Grammar constraints and DRY sampling fixed the formatting
  completely and it still produced 0/12 recognisable sprites.
- The model cannot judge its own renders — counting tasks 1–4/10, though simple binary presence
  questions about one image were 20/20.
- CLIP ViT-B-32 on CPU works as a scorer, but only for ranking candidates of the *same* prompt.
- Directional machines (tanks, vehicles) fail; organic and architectural subjects work.

## Layout

| Path           | Was                                                       |
| -------------- | --------------------------------------------------------- |
| `src/`         | the whole TypeScript library and editor                    |
| `py/`          | the Python research pipeline and the CLIP scoring service  |
| `docs/`        | `PRODUCTION_PLAN.md`, `DESIGN_PROGRESS.md`, `results.html` |
| `assets/`      | `.vox` test models and their rendered sheets               |
| `experiments/` | one-off probes, including the WebGL hardware check         |
| `out/`         | generated batches from `py/voxbatch.py`                    |
