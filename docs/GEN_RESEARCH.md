# Generation research, 2026-08-08

The session record for the generation pipeline, in the spirit of `legacy/docs/DESIGN_PROGRESS.md`:
what was measured, what died, and what is wired in now. Scripts lived in the session scratchpad; the
numbers and renders were all against the live Qwen3.6-27B and this repo's CPU raycaster. Sample
sizes were small (1–4 per cell) — every effect kept was one-sided, not marginal.

## Status: the wired solution is still below the bar

What is in `src/gen/` today produces _recognisable_ subjects — a cat that reads as a cat, a knight
with sword and shield — with baked shading that reads as fur or cloth at sprite size. It is the best
this project has had, and it is still not _good_: silhouettes are boxy, proportions drift with the
seed, and nothing above ~20 primitives comes back coherent. Treat generation as a scaffold for the
artist, not as a finished asset.

## Wired in (this commit)

- **The reply is a program, not schema-constrained JSON.** `src/gen/code.ts` runs it against
  `box/ball/erase/mirrorX` with a 4096-op budget; a crash keeps the ops already painted. Why: a
  grammar-locked reply emits ops from its first token and has nowhere to think. The code format
  opens with a proportions comment and uses loops for limbs. Measured: the model named its own cat
  renders as animals 4/4 in code form against 2/4 for JSON.
- **A fifth worked example, `humanoid`.** With the building example a knight was a grey blob or
  emitted nothing; with the farmer example, 3/3 seeds gave armored figures. The example bank is the
  highest-leverage thing in the prompt, in both directions — a deliberately worse example dragged
  every output down to its own flaws. The examples are the ceiling.
- **A deterministic shading pass**, `src/gen/finish.ts`: lit tops, darkened crevices, hash jitter.
  Applied to the candidate volume in `generateMany`; the spec in the record stays flat, so
  rasterise-then-finish reproduces the asset.

## The naming veto: built, measured, and demoted to a label (2026-08-08)

`src/gen/veto.ts`. One 224 px render at the 45° yaw, temp 0, and the one question that was measured
to work: _"This is a voxel model. What does it depict? Answer with one or two words."_ A word that
is not in the prompt goes to a second, text-only call — _Could "&lt;word&gt;" describe
&lt;prompt&gt;?_ — and only an explicit "no" fails. Every other path passes.

Measured live against Qwen3.6-27B, 8 candidates each at temp 0.9 from seed 4200, renders judged by
eye:

| Prompt     | Passed | Right to pass | Wrong to pass  | Vetoed | Wrong to veto      |
| ---------- | ------ | ------------- | -------------- | ------ | ------------------ |
| `a cat`    | 3 / 8  | 2             | 1 (a fragment) | 5      | 2 (both real cats) |
| `a knight` | 0 / 8  | —             | —              | 8      | 2 (the best two)   |

**The naming is accurate; the match is impossible.** The word describes the picture honestly every
time. It just is not a key:

- `dog` came back for a real cat with ears and an upright tail **and** for a real dog in the same
  batch of eight. No phrasing of a word-level match can separate those two, because the word is
  identical and the pictures are not.
- A knight is a **costume**, and the model names the costume's nearest civilian equivalent: `santa`
  (grey helm, red surcoat — the best candidate of the eight), `police officer`, `miner`,
  `graduation`. All eight knights were vetoed, including the two an artist would have kept.
- The text-only second call is strict, not sycophantic: 13 asks, 13 refusals, 0 agreements. It is
  not the sycophancy failure the image questions had — it is simply right that a santa is not a
  knight, which is exactly the wrong question to be right about.

So the veto is **not wired as a veto**. `judge` still returns `{word, pass, why}` and the dialog
still counts it — "Naming: 3 of 8 read as the subject" — but nothing sorts, marks, dims or drops a
candidate by it. What ships is the **word**, under each thumbnail: a knight that reads as "santa"
tells the artist which part of the sprite is wrong, and that is worth one call a candidate on its
own. Do not promote it back to a gate without a signal that is not the word.

## Tried and dead — do not re-run

- **A prose plan before the constrained call.** Worse on 3/3 subjects, catastrophically — the plan
  drags the reply away from the worked example.
- **A revision loop, in any format.** Render fed back with the model's own accurate critique: it
  re-emits byte-identical code while claiming fixes (946 → 946 → 946 voxels). Same result as the
  legacy JSON finding. The model does not edit.
- **Yes/no vision checks that name the subject.** "Is this recognisable as X?" gets yes for garbage;
  the framing decides the answer. Neutral yes/no over a four-view strip says no to everything,
  including good models.
- **Rejecting candidates by what the vision model calls them.** Built and measured — see the section
  above. The naming is honest and the match is impossible, and it vetoed cats.
- **VoxelModel-v1** (bench-labs, HF, MIT): a 40M text-to-voxel diffusion model, runs on CPU at ~6–9
  s per 32³ shape. Organic silhouettes far beyond the op pipeline (a real sitting cat, a real
  chair), but hollow, noisy, colourless shells; after despeckle + solidify + smoothing + symmetrize
  it still reads as melted. Judged worse than the primitive look and not wired. Retraining it was
  considered and **dropped** (2026-08-08): the ceiling is the Objaverse-lowpoly data, not the
  training run, and both GPUs are owned by llama-server anyway.

## Leads worth wiring next

- **Real assets as worked examples.** The examples cap the quality and mine are programmer art. A
  greedy box decomposition of artist-made `.vox` files would turn good assets into better teachers.
