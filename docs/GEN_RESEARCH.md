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

## The example bank moved to disk (2026-08-09)

The examples used to be string literals in `src/gen/llama.ts`, one per body plan, picked by a
hardcoded five-word list. **No asset has been swapped in yet** — there are none on this machine — so
every entry still teaches with its built-in reply, and the live before/after numbers are still owed.

- `src/gen/decompose.ts` — a `Volume` into the ops that rebuild it. Greedy largest-box extraction,
  six axis-growth orders per box, best of the six. **Lossless**, and that is the test:
  `rasterise(decompose(v))` is `v` again, cell for cell and colour for colour. `opsToCode` renders
  ops as the code the reply format is written in, colours hoisted into `c1 … cN`.
- `src/assets/examples/` — one directory of models and one `examples.json` describing them: `id`,
  `subject`, `use`, `notes`, and an optional `file`. An entry with no `file` teaches with the
  hand-written reply in `src/gen/builtin.ts`, which is how all five ship today.
- `src/gen/library.ts` — loads the bank at run time, not at build time. `import.meta.glob` in the
  app; the same directory read off disk in `bun test`. No build step and no generated source. **The
  Vite guard must be a `try`, not a feature check.** Vite _replaces the call expression_, so
  `typeof import.meta.glob === 'function'` is false in the browser too — written that way the bank
  silently loaded nothing and every entry fell back to its built-in reply, with `bun test` green
  because `bun test` reaches that same fallback by design. Caught by the live smoke on 2026-08-09
  and now guarded in `browser/generate.spec.ts`, which is the only place it can be.
- The picking call's prompt **is the manifest** now (`pickPrompt`). Adding an entry needs no code.

### Three examples per prompt: measured, and it is worse (2026-08-09)

Live against Qwen3.6-27B, three fixed seeds (4200–4202) per cell, renders judged by eye. Strips are
in `docs/renders/`.

The picking call is honest about easy subjects and **pads when it is unsure**: `a cat → dog`,
`a chicken → chicken`, `a stone tower → tower`, but `a knight → farmer, chicken, dog` and
`a fish → dog, chicken, farmer`. So the subjects that get three examples are exactly the ones that
were already hard, which is the worst place to run an untested change.

| Prompt     | One example                                          | Three examples                                                                           |
| ---------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `a knight` | 3/3 read as armoured figures, one with a plumed helm | 0/3. Two grew the chicken's **red comb** on the helmet; one was a dark blob with a stick |
| `a fish`   | 2/3 read as fish                                     | 1/3 (the single best fish of the six), 1 brick, 1 in fragments at 0.59 connectivity      |

**The examples average into a shape that is none of them**, which was the open risk, and the comb on
the knight's head is it happening in a way you can point at. The knight result is one-sided; the
fish is a wash. Recommendation: `MAX_PICKS = 1` in `src/gen/bank.ts`. It is left at 3 pending a call
— the constant is the whole change, and the multi-example plumbing costs nothing when only one is
picked.

Order is still untested: the closest pick is sent last, nearest the prompt, on recency reasoning
alone. At one example it does not matter.

Timings: pick 0.4–1.5 s once per batch; ~10 s per candidate.

**A model dropped on the generate dialog teaches the next batch**, ahead of everything the bank
picked, and is remembered in `localStorage` as the decomposed example rather than as bytes.
Decomposed at the moment of the drop, so a file that will not read or will not fit fails where
somebody is looking, not thirty seconds into a batch.

Measured on `car.vox` (478 voxels, 14 × 6 × 10): **6 boxes, 8 lines, 3 colours** — wheels, body,
cabin, which is what the model actually is. Budgets enforced: 32 on any axis, 80 lines, and the same
one-connected-piece-not-a-brick-taller-than-8 test every hand-written example already had to pass.
Dropped in as an example, the car failed that test at 6 tall, which is the guard doing its job.

`GenerationRecord.plan` became `examples`, a list. A version-3 file's single word reads back as a
one-element list, so an old provenance line survives the change instead of becoming a gap.

## Leads worth wiring next

- **Assets for the bank.** The decomposer is waiting on models. One good CC0 `.vox` per entry — dog,
  chicken, farmer, mushroom, tower — each inside 32³ and simple enough to land under 80 lines. Then
  generate cat, knight, chicken, mushroom and tower at fixed seeds before and after each swap, plus
  a second subject per entry to catch the known failure mode: an example that makes cats better and
  drags foxes into cat shapes.
- **Drop `MAX_PICKS` to 1**, on the knight measurement above. One line.
