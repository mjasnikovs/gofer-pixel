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
fish is a wash. Recommendation: one example. **Done on 2026-08-12** — see the section at the bottom
of this file.

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

## The experiments are switches now (2026-08-11)

`docs/GEN_IDEAS.md` is eleven directions out of the code and four 2026 papers. Every one that is
built is behind a flag in `src/gen/flags.ts`, off by default, in a folded block at the bottom of the
generate dialog. Off is the generator every number above was measured with, and the way an
experiment graduates is that its numbers land in this file and the flag is deleted with the branch
it guarded.

### Auto picks the language, and picks it right (2026-08-11)

Four languages now exist and exactly one fits any given subject, which makes choosing between them a
thing the artist should not have to do. `src/gen/auto.ts`, behind the `auto` flag: one call per
batch, a one-word answer, and the chosen language is switched on while the other three are switched
off. **It picks one or none, never a set** — the example picking call is measured to pad when unsure
(`a knight → farmer, chicken, dog`, above), and here padding is a contradiction rather than a wash,
because `relational` replaces the example set and would send the face help with nothing teaching it.

The three _policy_ switches — `repair`, `gates`, `retryEmpty` — are deliberately out of reach. They
are about what to do with output that came back broken, not about the subject.

Measured live against Qwen3.6-27B, fifteen prompts, temp 0:

| prompt              | chose        |     | prompt              | chose        |
| ------------------- | ------------ | --- | ------------------- | ------------ |
| a Mario brick block | `faces`      |     | a pine tree         | `procedural` |
| a wooden crate      | `faces`      |     | a stone tower       | `procedural` |
| a treasure chest    | `faces`      |     | a mossy boulder     | `procedural` |
| a stone floor tile  | `faces`      |     | a knight            | `relational` |
| a fish              | `silhouette` |     | a dog               | `relational` |
| a mushroom          | `silhouette` |     | a chicken           | `relational` |
| a clay pot          | `silhouette` |     | a farmer with a hoe | `relational` |

**14 of 14, at 0.36 s a call.** That is the highest hit rate anything in this record has produced,
and it is not surprising: it is a one-word classification from a written description, which is the
shape of question findings 2 and 8 both say the model is good at.

**The one caveat, and it is the padding again in a milder form: `none` was never chosen.** "a cheese
sandwich" — put in the set precisely because none of the four is built for it — came back `faces`.
So auto always picks something, and a subject that fits nothing gets an arbitrary language rather
than falling back to the generator every other number here was measured on. Whether that costs
anything is unmeasured; a sandwich is a boxy thing and `faces` may even be the least wrong answer.

The chosen language travels in `GenerationRecord.language`, for the same reason `examples` does: the
choice is its own model call, so prompt and seed alone no longer reproduce a candidate.

### The brick block, and the face language it produced (2026-08-11)

"It cannot even generate a Mario brick block." Measured, and **the model generates it perfectly
well.** What happened is that three separate parts of this pipeline threw the answer away.

Live, seed 4200, one candidate per cell:

| canvas         | solid | what the gate said                                   |
| -------------- | ----- | ---------------------------------------------------- |
| 16             | 0.70  | kept                                                 |
| 32             | 0.83  | **"a brick: 83 % of its own bounding box is solid"** |
| 16, relational | 0.95  | **"a brick: 95 % solid"**                            |

`overallScore` ranks by `1 - bboxFill`, so a correct cube sorts last. `gate.ts` rejects over 0.8
solid. And every cell came back **taught by `tower`**, because the bank has no block in it.

The third failure is the one that could not be fixed by moving a number: **a block is all surface.**
Its silhouette is a square and every bit of its information is the pattern on its faces — and the op
language paints solids, so the reply painted its mortar lines _through the middle of the cube_,
where nothing can see them. Half of what a sprite sheet needs is that subject and nothing in
`src/gen/` could address a face.

`src/gen/face.ts` is the answer, behind the `faces` flag: `face("+z", s => …)` paints one voxel deep
on a side of what has already been painted, in 2D `(u, v)`, with `rect`/`line`/`dot`/`bevel`/
`courses`/`studs`. **A reply that called `face` has declared its content is on its surface**, which
is what turns off the brick rule and switches `overallScore` off silhouette — no artist-facing
switch, the language is the declaration.

Measured after wiring, canvas 16, same seed:

| run                 | solid | shell colours | gate                       |
| ------------------- | ----- | ------------- | -------------------------- |
| brick, `faces` off  | 1.00  | 6             | **rejected — 100 % solid** |
| brick, `faces` on   | 1.00  | 10            | **kept**                   |
| wooden crate        | 0.94  | 10            | kept                       |
| question mark block | 1.00  | 10            | kept                       |

The model used `face` in every prop run and wrote real surface code: bevels, running-bond courses,
an "M" emblem, a "?" symbol.

**Two defects the same run found, both in the new code:**

1. **The prop score is saturated and therefore sorts nothing.** Every prop came back at `rank 1.00`.
   `variety` maxes at six shell colours and `finish` invents two shade tones per colour, so the
   shell is always 10+ and the term is always 1. This is the same defect the record already names
   about `bboxFill` pinning at 1.000 for every candidate — rebuilt, in a new place. It has to be
   measured on the volume **before** `finish`, or on the spec's own colours, and until it is, the
   prop branch of `overallScore` is a constant.
2. **A cat declared itself a prop.** `FACE_HELP` says "do not use it for a creature or a figure" and
   the model called `face` on a cat regardless. A rule in prose did not survive contact with the
   examples, which is finding 7 stated from the other direction. The declaration is therefore not
   trustworthy on its own; what would make it trustworthy is unmeasured.

### The three language experiments do change what comes back (2026-08-11)

The first thing to check about a new op language is whether the model uses it or ignores it and
writes `box` anyway — `GEN_IDEAS.md` §2 names that as the way the idea dies. It does not happen.
Live against Qwen3.6-27B, one candidate per cell, seed 4200, temp 0.9, canvas 32, through the real
`browserLlama` path with the raw reply kept:

| subject       | flag         | what the reply actually called | voxels | solid |
| ------------- | ------------ | ------------------------------ | ------ | ----- |
| `a fish`      | off          | `box`                          | 6046   | 0.48  |
| `a fish`      | `silhouette` | **`front` `side`** + `box`     | 499    | 0.39  |
| `a fish`      | `procedural` | `box`                          | 2526   | 0.70  |
| `a fish`      | `relational` | **`part` `attach`**            | 1281   | 0.54  |
| `a pine tree` | off          | `box`                          | 2835   | 0.28  |
| `a pine tree` | `silhouette` | **`front` `side`**             | 4059   | 0.37  |
| `a pine tree` | `procedural` | **`tree({shape: 'pine', …})`** | 4446   | 0.29  |
| `a pine tree` | `relational` | **`part` `attach`**            | 716    | 0.16  |

Connectivity is 1.00 in every cell. Three things worth keeping:

- **The new words get used the moment they are offered**, and `procedural` is used _selectively_ —
  the pine tree called `tree()` and the fish did not, which is the right answer, since there is no
  generator for a fish and the prompt says so.
- **`silhouette` shrinks the model.** The fish came back at 499 voxels against 6046 with the same
  seed: the reply wrote an eight-row outline inside a 32 box. Curvier and far smaller, and the "fill
  most of that box" line in the system prompt does not survive the ribs. Whether that is worth it is
  a question for the pictures, not the numbers.
- **`relational` is the sparsest of the four**, at 0.16 solid on the tree. Parts that must touch is
  a stricter language than boxes that may overlap.

Not measured yet: whether any of them is _better_ by eye, which is the only question that matters
and needs a strip per cell rather than one candidate.

### CLIP is gone (2026-08-11)

The scorer was removed, along with `py/clipserve.py`, `src/gen/clip.ts`, `src/gen/views.ts`, the
rank-by control and the `bun run clip` script. The negative-anchor measurement below is what
prompted the question, and the answer did not depend on it:

**A sort order is all CLIP could ever be, and a sort order is not worth a service.** It ranks
candidates of one prompt only, so the number means nothing across subjects; it cannot be a gate; and
it cannot be looped against — the legacy refiner optimised against it reliably and tore a mushroom's
cap apart for +0.03. The other half of a loop is missing too: the model does not edit, measured
three times here and confirmed by 3DCodeBench across every model size. So the one thing a second
opinion could have bought — a fix — was never available.

What is left is `overallScore`, which is exact, free, and honest about being a sort order. The loop
that works is code: measure in `score.ts`, repair in `repair.ts`, reject in `gate.ts`.

The measurement that preceded the decision is kept below, because it is the reason.

### CLIP negative anchors: built, measured, and it moved almost nothing (2026-08-11)

`py/clipserve.py`, behind `clipNegatives`. The score becomes `sim(prompt) − max sim(anchor)` over
three anchors — _a solid rectangular block_, _a pile of scattered cubes_, _an empty grey grid_ —
each phrased through the same `pixel art sprite of …` template as the positive, so the margin
measures the subject and not the wording. Anchors are encoded once per request.

Measured against the four stored strips in `docs/renders/`, three candidates × four views each:

| strip            | order, plain | order, margin |
| ---------------- | ------------ | ------------- |
| `a-fish-one`     | 1, 0, 2      | unchanged     |
| `a-fish-three`   | 0, 2, 1      | unchanged     |
| `a-knight-one`   | 2, 0, 1      | unchanged     |
| `a-knight-three` | 0, 2, 1      | 2, 1, 0       |

**Three of four orderings do not move**, and the one that does is a strip the record already calls 0
of 3, with a total spread of 0.008 — noise, and driven by the _empty grey grid_ anchor rather than
by the brick. The diagnosis is in the per-anchor numbers: _a solid rectangular block_ is the winning
anchor for 9 of 12 candidates and sits in a 0.314–0.350 band across all of them, the real fish
scoring 0.3408 against it and the brick 0.3369. It is a near-constant offset whose residual is the
same size as the differences in the positive term.

The reason is worth writing down because it kills the premise, not the implementation: **CLIP had no
brick to fix.** In `a-fish-three` the brick was already last under plain scoring. The tie-at-the-top
defect the idea was aimed at belongs to the _deterministic_ scores in `score.ts`, where three
candidates came back at exactly 1.000 on every term. Pooled across all six fish candidates the
margin does promote one real fish from third to first, Spearman 0.83 — one candidate, two places,
and the only positive signal found. The flag stays for a live batch to argue with; the anchors were
not tuned until they did something.

The default path is byte-identical to the old one, verified float for float, so the switch is a real
before/after and not a new baseline.

### The model can read a render, and it does not help (2026-08-12)

Full write-up in **`docs/GEN_VISION.md`**; harness in `docs/spikes/vision/`; 1484 calls, every one a
fresh session, ground truth computed from the grid, and a no-image control as the floor.

The record had three deaths for feeding a render back and had never asked whether the model sees the
picture. It does: **92 % across five closed geometric questions against a 28 % blind floor**, at
five views, 96 px, 32³, with a GBNF grammar on the answer.

What that bought, and did not:

- **Nothing for the generator.** The four geometric questions it answers well are the ones
  `score.ts` and `repair.ts` already compute exactly, from the grid, for free. Spending 7.3 s and
  five renders on a 92 %-accurate estimate of a number the code knows exactly is not an improvement.
- **Nothing for the naming call.** The five bank models named under `veto.ts`'s current single 224
  px view and under the best five-view configuration come back **identical** — the dog is "Cow" both
  times, the farmer "Villager" both times. `veto.ts` needs no change.
- **The revision loop stays dead.** These findings are about reading, and the revision findings are
  about editing. A model that reads its own render at 92 % and still re-emits identical code is a
  model that cannot express a fix.

Three results are worth keeping anyway, because they are cheap and they are load-bearing if a vision
call is ever added:

- **Separate images, never a composite strip: 27 points.** The same four views scored 85 % sent as
  four images and 58 % as one strip; counting pieces collapsed from 83 % to 33 %. Every four-view
  result in this project's earlier record was a strip.
- **One view cannot read depth: 4/18, below chance, and all 14 misses say "width".** Only a camera
  directly above fixes it — four elevations do not, four three-quarter views do not. This is finding
  4's front-to-back tank reversal, measured from the reading end.
- **Three labelled example pictures are worth ten points** at one view (75 → 85 %), and six are not
  better than three. Finding 7 holds in the image channel — and at five views the examples are worth
  nothing, because the views already bought it.

**And it cannot rank, measured a second way.** Asked as a forced choice over five views with a
grammar — the configuration above, not the one-view free-form score finding 2 killed:

- Against **known damage** it is right 92 % of the time (five views; 84 % at one view), over the
  five bank models each paired with itself debris-scattered, holed, split into two floating halves
  or squashed to half height. Pairs whose damage does not change the picture are skipped — measured,
  not assumed: the shaft through the tower is inside its own walls.
- Against **real candidates of the same prompt**, ten generated live at temperature 0.9, **7 of 12
  pairs survive being asked with the two models swapped. A coin manages 6 of 12.**
- **Every flip is "B then B"** — five of five — the model naming whichever candidate came second.
  Shown the same model twice it says A, five times out of five, so this is not a flat position
  prior; it is what appears when the difference is real and too fine to call.

A damage detector, not a judge. What it detects is what `repair.ts` already finds in code and fixes.

Three of the five near-misses this session were **harness bugs that would have shipped as
findings**: an unbalanced corpus that scored 89 % blind, an 8-token cap truncating the answer, and a
red-pixel detector that ignored `FACE_LIGHT` and reported the app's own camera ring as unable to
show a left face. That is the argument for the harness existing.

## Leads worth wiring next

- **Assets for the bank.** The decomposer is waiting on models. One good CC0 `.vox` per entry — dog,
  chicken, farmer, mushroom, tower — each inside 32³ and simple enough to land under 80 lines. Then
  generate cat, knight, chicken, mushroom and tower at fixed seeds before and after each swap, plus
  a second subject per entry to catch the known failure mode: an example that makes cats better and
  drags foxes into cat shapes.
- ~~Drop `MAX_PICKS` to 1~~ — done 2026-08-12, see below.

### One worked example, and the switch is gone (2026-08-12)

The first experiment to graduate. `onePick` is deleted, along with `MAX_PICKS`, `picksFor`, the
`picks` parameter on `pickPrompt` and `readPicks`, the cap on `Llama.pick`, and the `asked` hook
`memoryLlama` carried so a test could watch the cap reach the wire. A batch is taught by one example
and there is no number left between the sentence and the code for the two to disagree over.

The measurement is the 2026-08-09 one above and it is unchanged: `a knight` read as an armoured
figure **3 of 3 taught by one example and 0 of 3 taught by three**, two of the three growing the
chicken example's red comb on the helmet; `a fish` was a wash at 2/3 against 1/3. The knight is
one-sided, the fish is not, and n is three seeds on two subjects — thin, and all of it pointing the
same way.

What actually changed, beyond the count:

- **`readPicks` returns the first id it recognises**, rather than filling a list up to a cap. A
  reply that ignores "one id only" and answers with three is held to one here, so the prompt and the
  behaviour cannot drift apart.
- **The list survives, the cap does not.** `GenerationRecord.examples` is still `readonly string[]`
  because files written before today hold three ids, and a record is history rather than a setting.
- **`memoryLlama` hands back one**, sliced. A canned port that could return three would let a test
  assert on a batch the real server can no longer produce.

Verified live against Qwen3.6-27B after the change, five prompts through the real `browserLlama`:

| prompt            | picks    |
| ----------------- | -------- |
| a knight          | `farmer` |
| a cat             | `dog`    |
| a fish            | `dog`    |
| a stone tower     | `tower`  |
| a cheese sandwich | `tower`  |

One id every time, and `a knight` is the measured case: it came back `farmer, chicken, dog` before
and comes back `farmer` now. The sandwich is the `auto` caveat again in a second place — nothing in
the bank is a sandwich and the call still answers rather than declining, which is what `fallback` is
for and is not what happened.
