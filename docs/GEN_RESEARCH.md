# Generation research, 2026-08-08

The session record for the generation pipeline, in the spirit of
`legacy/docs/DESIGN_PROGRESS.md`: what was measured, what died, and what is wired in now. Scripts
lived in the session scratchpad; the numbers and renders were all against the live Qwen3.6-27B and
this repo's CPU raycaster. Sample sizes were small (1–4 per cell) — every effect kept was
one-sided, not marginal.

## Status: the wired solution is still below the bar

What is in `src/gen/` today produces *recognisable* subjects — a cat that reads as a cat, a knight
with sword and shield — with baked shading that reads as fur or cloth at sprite size. It is the
best this project has had, and it is still not *good*: silhouettes are boxy, proportions drift
with the seed, and nothing above ~20 primitives comes back coherent. Treat generation as a
scaffold for the artist, not as a finished asset.

## Wired in (this commit)

- **The reply is a program, not schema-constrained JSON.** `src/gen/code.ts` runs it against
  `box/ball/erase/mirrorX` with a 4096-op budget; a crash keeps the ops already painted. Why: a
  grammar-locked reply emits ops from its first token and has nowhere to think. The code format
  opens with a proportions comment and uses loops for limbs. Measured: the model named its own
  cat renders as animals 4/4 in code form against 2/4 for JSON.
- **A fifth worked example, `humanoid`.** With the building example a knight was a grey blob or
  emitted nothing; with the farmer example, 3/3 seeds gave armored figures. The example bank is
  the highest-leverage thing in the prompt, in both directions — a deliberately worse example
  dragged every output down to its own flaws. The examples are the ceiling.
- **A deterministic shading pass**, `src/gen/finish.ts`: lit tops, darkened crevices, hash jitter.
  Applied to the candidate volume in `generateMany`; the spec in the record stays flat, so
  rasterise-then-finish reproduces the asset.

## Tried and dead — do not re-run

- **A prose plan before the constrained call.** Worse on 3/3 subjects, catastrophically — the plan
  drags the reply away from the worked example.
- **A revision loop, in any format.** Render fed back with the model's own accurate critique: it
  re-emits byte-identical code while claiming fixes (946 → 946 → 946 voxels). Same result as the
  legacy JSON finding. The model does not edit.
- **Yes/no vision checks that name the subject.** "Is this recognisable as X?" gets yes for
  garbage; the framing decides the answer. Neutral yes/no over a four-view strip says no to
  everything, including good models.
- **VoxelModel-v1** (bench-labs, HF, MIT): a 40M text-to-voxel diffusion model, runs on CPU at
  ~6–9 s per 32³ shape. Organic silhouettes far beyond the op pipeline (a real sitting cat, a
  real chair), but hollow, noisy, colourless shells; after despeckle + solidify + smoothing +
  symmetrize it still reads as melted. Judged worse than the primitive look and not wired.
  Would be the base if anyone retrains it: recipe, data (`dylanebert/objaverse-lowpoly-obj` +
  `tiange/Cap3D`, both ODC-By) and its known fixes (solid fill, mirror augmentation, curated
  subset) are documented in the model card. Needs a free GPU; both are owned by llama-server.

## Leads worth wiring next

- **The open-naming veto.** "What does it depict? One or two words" on one 224px render at temp 0
  discriminated every good/bad pair this session (blob → "robot", slab-ship → "lever", good cat →
  "cat"/"dog"). Needs a text-side semantic match against the prompt. Not wired yet.
- **Real assets as worked examples.** The examples cap the quality and mine are programmer art. A
  greedy box decomposition of artist-made `.vox` files would turn good assets into better
  teachers.
- **Multi-colour parts for shape-model output**, if VoxelModel is ever revisited: k-means part
  clusters, model labels colours per cluster in a text-only call. Untested.
