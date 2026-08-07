# gofer-pixel — Design Progress

Local AI pixel-art generation, sprite stacking as the base representation.

---

# START HERE — state as of 2026-08-06

> **Building, not researching?** `PRODUCTION_PLAN.md` supersedes the "Open / next" section
> below. It carries the milestones, the decisions with their evidence, and a §14 that lists
> what is still unverified. The axis-aligned striping defect that section used to warn about
> was fixed on 2026-08-06 and is pinned by a property test.


## The pipeline that works

```
model emits primitives (JSON ops)  →  we rasterise to voxels  →  render N candidates
  →  CLIP ranks them on CPU  →  export winner: .vox, slice sheet, rotation sheet,
     exact normal map, lit preview
```

```bash
.venv/bin/python voxbatch.py "a red pickup truck" 10 out/truck
```

Verified end to end. Winner scored 0.317, loser 0.203, and the loser was a solid black
32³ brick. Open `results.html` in a browser for the visual record.

## Files

| file | what it is |
|---|---|
| `voxgen.py` | prompt → JSON ops → voxels → `.vox`. Pre-existing, stdlib. |
| `voxslice.py` | `.vox` reader, z-slicing, contact sheet, PNG writer. Pre-existing, stdlib. |
| `voxrender.py` | rotation sheets, exact normal maps, Lambert check. Stdlib. |
| `voxrank.py` | CLIP ViT-B-32 on CPU, mean score over 4 angles. |
| `voxbatch.py` | generate N → rank → export best **and worst**. |
| `experiments/` | every test script from the validation session. |
| `experiments/images/` | the result images the findings below refer to. |
| `results.html` | self-contained visual summary, no server needed. |

Environment: `.venv` has CPU torch 2.13.0, torchvision 0.28.0, open_clip, pillow.
The llama-server is a separate root/container process on `localhost:8080`.

## The five things worth knowing

1. **The model cannot draw pixels.** Not a prompting problem. Grammar-constrained
   emission fixes geometry perfectly and DRY sampling fixes degeneracy, and it still
   produced 0 of 12 sprites that depicted their subject. This is the documented
   read–write asymmetry: models read character grids far better than they write them.
   **Do not revisit this.**

2. **The model cannot judge its own work.** 1–4/10 on counting filled slices at any
   image scale, 2/18 on counting colours. It *can* answer a simple binary presence
   question about a single image — 20/20. Use it for yes/no only; compute anything
   countable in code.

3. **CLIP is the scorer.** Ranks candidates for one prompt correctly and cheaply on CPU.
   **It does not compare across subjects** — a good stone tower scores below a mediocre
   mushroom. Same-prompt ranking only.

4. **Organic and architectural subjects work. Directional machines do not.** Front-back
   reversal is a measured systematic failure; a tank *is* frontedness, a mushroom has no
   front. Prompt fixes moved the geometry metric from 0/4 to 3/4 and produced nothing
   that looks like a tank. Parametric templates do work, at the cost of writing the
   skeleton yourself.

5. **Everything downstream of the voxel volume is exact and free.** Slices are registered
   by construction, normals come off the surface rather than being estimated, and
   rotation is hole-free as long as slice lift ≤ pixel scale.

## Open / next

- **Critique loop: closed 2026-08-06.** The image-only condition ASCIIEval predicts should win
  was run (`experiments/t21_critique.py`, 48 revisions across image / image+stats / stats-only)
  and no modality separates. The obstacle is not the modality: the model returns its own model
  unchanged 22 times in 24, and 14 in 24 even when told its answer must differ. Generate-N and
  rank stays the loop.
- **Constrained decoding is in.** `voxgen.ask` sends a JSON schema and llama-server enforces it
  as a grammar — asked for plain English prose with the schema attached, it can still only emit a
  valid model. `parse_model` is now `json.loads`.
- **Angle count: re-derived 2026-08-07.** The borrowed "16 is enough" does not survive our own
  renders — the error from quantising rotation decays smoothly with no knee, and the per-step
  silhouette change at 16 angles is 7 % for a round shape and 35 % for a truck. It is a property of
  the model, so it is measured per model now (`angleAdvice`). Axis-aligned angles are thinner by
  3–14 % and should still be baked: offsetting the set to dodge them measured worse.
- **Animation is untouched** and is the hard part — deforming the volume over time, not
  tweening sprites.
- **Blocked:** `--image-min-tokens` sweep (needs the llama-server restarted, root/container);
  Gemma-3 27B as an alternative critic (both GPUs ~95% full); vision-backbone LoRA
  (multi-day).
- **Superseded:** the code-metric scorer in `experiments/score.py` and the spec check in
  `experiments/spec.py`. Both failed to discriminate — kept only as a record of what not
  to rebuild. CLIP replaced them.
- **Evolutionary refinement: tried 2026-08-07, and the objective is the problem.** Mutating the op
  list works exactly as hoped — 168 scorings in ~30 s, no LLM calls, CLIP climbs every time. But the
  renders in `out/evolve/` show the mushroom's cap torn apart for +0.03 CLIP, connectivity 1.00 →
  0.72. CLIP under optimisation pressure rewards damage. The harness (`src/gen/evolve.ts`) is kept
  and tested for the day there is a scorer worth maximising; nothing in the app calls it.

---

## Session 1 — 2026-08-06 — Feasibility validation

### Environment (measured, not assumed)

| Thing | Value |
|---|---|
| Model | `Qwen3.6-27B-NVFP4-MTP.gguf`, Q4_K_M, 15.7 GB, 27.3B params |
| Server | llama.cpp `b10250-ee0445c99` on `http://localhost:8080` |
| Modalities | vision ✅ video ✅ audio ❌ — **input only** |
| Context | 240k requested, 120064 usable per slot, 2 slots |
| GPUs | RTX 4070 SUPER 12GB + RTX 5070 Ti 16GB, `--tensor-split 39,26` |
| VRAM in use | 11.8/12.3 GB and 15.1/16.3 GB — **model does not fit on one card** |
| Speed | ~455 tok/s prompt, ~72 tok/s generation |
| Extras | `--mmproj` vision tower, `--image-min-tokens 1024`, MTP + ngram speculative decode |
| Sampler defaults | temp 0.7, top_p 0.8, top_k 20, presence_penalty 1.5 |
| Tool calling | ✅ works (`finish_reason: tool_calls`, clean JSON args) |

Test harness lives in the session scratchpad: `llm.py`, `vox.py`, `agent.py`,
`test_a*.py`, `test_c_vision.py`, `test_d_ablation.py`.

---

### Finding 1 — The model cannot output images. Structural, not a limitation to work around.

Confirmed directly: *"OK. I can only output text."* llama.cpp has no image output path
and `capabilities: ["completion","multimodal"]` means multimodal **in**.
Any pixel data must be text the model types, or the product of code the model drives.

### Finding 2 — Asking it to type pixels directly: **DEAD**. 0/9 usable.

24×24 sprite, palette digits 0–7, one digit per pixel.

- **6 runs** (3 seeds × recommended sampling, 3 seeds × greedy): **5 returned a fully blank
  canvas** — 24 lines of `000...`. It enters a repetition attractor and never exits.
  Greedy was worse: 3/3 blank. The one non-blank run was a concentric colour ramp
  (palette used as a gradient, semantics ignored) and emitted 19 lines, not 24.
- **3 runs** with a `<plan>` chain-of-thought step first: silhouettes became genuinely
  plausible blobs with an eye — **but row widths drifted 22 / 24 / 25 / 26 within a single
  sprite.** The model cannot reliably count to 24. Nothing is grid-aligned.
- RLE JSON variant: collapsed to `[[24,0]]×24` — blank again.
- Free-form draw-op JSON: started sensibly (ellipse, ellipse, highlight) then degenerated
  into hundreds of single-pixel ops with `y` running past the canvas edge.

**Mitigation not yet tried:** GBNF grammar-constrained decoding to make malformed rows
impossible, and a mechanical repair pass (pad/truncate rows to width).

### Finding 3 — Tool-driven voxel construction: **WORKS**. This is the viable path.

Gave the model `box`, `ellipsoid`, `cylinder_z`, `mirror_x`, `render`, `done` over a
16×16×16 grid, z-up, 9-colour palette.

- *"a red mushroom house with a door"* → recognisable: domed red cap, brown stem, dark
  doorway, gold doorknob. (`mush_side.png`, `mush_stack.png`)
- *"a wooden treasure chest with a gold lock"* → reads as a chest.
- *"a small battle tank"* → failed, unreadable brown mass. Vehicles are harder than
  organic/architectural shapes.

Roughly 14 tool calls per asset, ~1–2 min wall clock.

### Finding 4 — Everything else falls out of the voxel model for free, and is exact.

Written and verified in `vox.py`: z-layer slices (sprite stack), orthographic side view,
sprite-stacked render at arbitrary rotation, and a **normal map read directly off the
voxel surface** — no estimation, no AI. Cross-slice registration is automatic because
every slice is a cut through one volume.

### Finding 5 — ⚠️ Image feedback did NOT help. My earlier claim was wrong.

I predicted the render→critique loop would be the strong part of the design. Measured, it
is not. The model's eyes are weak on this specific material:

- Called a sprite-stacked tank **"a pixel-art potion bottle"**.
- Counted **6** non-empty slices on a contact sheet where there were **9**.
- Said the red shape was on slice 5 (actually 7) and the gold on slice 4 (actually 6).
- Read a 16×16 tank side view as "a robot with a crown".
- **But** located a single isolated coloured pixel on an 8×8 grid perfectly (`3,2`), and
  got colour counts right. So the eyes work; pixel-art *content parsing* doesn't.

Ablation, same subjects and seed, with vs without the `render` tool: **no reliable
improvement.** n=2 subjects — suggestive, not settled.

**What did steer it:** the plain-text stats returned alongside the image (voxel count,
bounding box, layers used, colours used). Numbers it handles; pictures it doesn't.

---

### Open design questions

1. **Aesthetic target.** Sliced voxels give the *Delver* / sprite-stacking look, not
   hand-crafted pixel art. These are different goals and the brief currently mixes both.
2. **Rotation.** Pre-bake N angles from the volume (stable, bigger on disk) vs rotate
   slices at runtime (shimmers, breaks grid alignment).
3. **Palette authority.** Fixed project-wide palette (model emits indices, validation is
   trivial) vs per-asset palette.
4. **Automatic scoring.** Without a machine judge for silhouette readability, palette
   compliance, and connectivity, the loop cannot close and every asset needs eyeballing.
   Vision-model self-critique is now known to be a poor candidate for this judge.
5. **Determinism.** Seed + sampler must be pinned and stored per asset for regeneration.
6. **Animation.** Untouched, and the hard part — walk cycles mean deforming the volume
   over time, not tweening sprites.

---

## Session 1b — Literature review

### What the research says about our findings

**Finding 2 is a known, named, measured phenomenon.** ASCII-art benchmarks report a
**"read–write asymmetry"**: models interpret character-grid images far better than they
produce them. Root cause is tokenization — a 2D grid flattened to 1D loses the spatial
relationships that carry the meaning, producing "spatial blindness". Reported accuracy is
8% for models vs 94% for humans on ASCII reasoning; GPT-4 scored 25.19% on VITC-S and
3.26% on VITC-L. Chain-of-thought and Python tool access barely moved it. Our 0/9 is
squarely in line.

**Finding 5 may be confounded — the literature contradicts my setup.** ASCIIEval reports
a strict ordering: **Image-only >> Text-Image >> Text-only** (GPT-5: 87.81% on images,
55.90% on raw text). I fed the critique step *image + numeric stats together*, which is
the middle, weaker condition. Image-only critique was never tested here.

Two more warnings from the same work: a **"seesaw effect between OCR and ASCII art
recognition"** — models tuned hard for OCR lose holistic visual perception, and newer
open-source multimodal models have *regressed* on this task. And **Gemma-3 27B beats
models of 70B+ and several hundred B** at ASCII recognition, so our builder model is not
automatically our best critic.

**Vision patch size makes our 1× test unfair.** Vision encoders patch images at roughly
28px; a 16×16 sprite at 1× is smeared inside a single patch. Higher resolution is
reported to reduce hallucination and improve fine detail. The server already runs
`--image-min-tokens 1024`, which we have not swept.

**Symbolic/program generation beats coordinate emission.** VoxelCodeBench finds
"producing executable code is far easier than producing spatially correct outputs".
LLMs generate valid OpenSCAD more reliably than CadQuery because the language is simpler.
MineBench has models emit raw JSON block coordinates and ranks them by human Elo.
This is exactly the axis our tool API sits on, and we tested only one point on it.

**EvoCAD** samples many candidates and refines them with an evolutionary loop plus
vision + reasoning models, beating single-shot methods (3D-Premise, CADCodeVerify),
especially on topological correctness — scored with new metrics based on the **Euler
characteristic**. Directly transplantable: we have a deterministic renderer and can score
topology in code.

**Fine-tuning the vision backbone is the big lever**: 34.83% → 75.48% on ASCII
recognition. Rationale-assisted fine-tuning of the text model gave a smaller 28.28% →
35.66%.

**Sprite-stacking practice**: layers are offset −1 in y and rotated as a group; under
camera rotation the offset needs trig, not a flat y-shift. Known pitfall — **too few
layer repetitions leaves visible holes between layers when rotating**, and tall models
cost memory and fill rate.

**Normal maps for pixel art** are conventionally built by authoring a height map and
running a Sobel operator, which avoids baking artist shading into the normals
(DynaPix, SpriteIlluminator, Sprite DLight). Our voxel-surface normals should be
compared against that baseline, not assumed better.

---

## Test list

Ordered by expected information per hour of work. Each is a concrete experiment on the
existing rig.

**Rescuing direct pixel output**

1. **GBNF grammar-constrained emission.** llama.cpp enforces grammars during sampling, so
   a grid of exactly H rows × W digits becomes structurally impossible to violate.
   Question: does removing the counting failure yield art, or just well-formed noise?
   This is the single cleanest test of whether Finding 2 is a formatting problem or a
   conception problem.
2. **Mechanical row repair.** Pad/truncate rows to W as a post-pass, no grammar. Apply to
   the stored A4 seed-2 and seed-3 outputs, which were already plausible blobs. Nearly
   free; isolates counting from conception.
3. **Blank-canvas collapse.** 5/6 runs returned all zeros. Test whether presence penalty,
   min-p, DRY, or forbidding the `0` token early kills the repetition attractor.

**Fixing the critic (Finding 5 is not settled)**

4. **Image-only vs image+text vs text-only critique.** Replicate ASCIIEval's ordering on
   our own renders. If image-only wins, Finding 5 was a confound and the feedback loop is
   back on the table.
5. **Scale sweep for the critique image.** 1×, 4×, 8×, 16×, 32× against known ground
   truth. Find the resolution where slice counting becomes reliable.
6. **`--image-min-tokens` sweep.** Server-side resolution budget vs accuracy on the same
   fixed question set. Costs a server restart per point.
7. **One slice per image vs contact sheet.** The 6-vs-9 miscount may be sheet layout, not
   perception. Test single-slice queries with the z index stated in text.
8. **A different critic model.** Gemma-3 27B is reported to beat far larger models at
   exactly this task, and newer models have regressed. Keep Qwen3.6 as builder, swap the
   judge. Needs a second model loaded — VRAM is already full, so this is sequential.

**Improving the builder**

9. **Tool API ablation.** Three points on the same axis: raw JSON voxel coordinates
   (MineBench style) vs our named primitives vs a one-shot OpenSCAD-like program the
   model writes and we execute. Literature predicts the program form wins.
10. **Best-of-N with a code scorer.** N=8 candidates, ranked mechanically: silhouette
    compactness, connectivity, left-right symmetry, palette spread, bounding-box fill,
    and Euler characteristic for topology. No VLM in the loop. EvoCAD says this beats
    single-shot.
11. **Evolutionary refinement.** Mutate the winning tool program, re-score, iterate.
    Measures whether quality climbs or plateaus.
12. **Forced symmetry.** Make `mirror_x` mandatory. Cheap constraint that deletes a whole
    error class; measure the readability delta.
13. **Subject-class boundary.** 20 subjects across organic / architectural / vehicle /
    character. Mushroom and chest passed, tank failed — find where the wall actually is
    before designing around it.

**Pipeline quality**

14. **Rotation holes.** Sweep angle × layer-repetition on the existing renderer and find
    the repetition count where gaps disappear. Known documented pitfall.
15. **Normals vs the Sobel baseline.** Our exact voxel-surface normals against
    height-map + Sobel, compared in an actual lit scene. Confirms or kills the
    "free and exact, therefore better" claim.
16. **Vision-backbone fine-tune (long shot, highest ceiling).** Reported 34.83% → 75.48%.
    Assess feasibility of a LoRA on the mmproj tower given 28 GB of split VRAM.

---

## Session 1c — Test list executed

12 of 16 run. 1 superseded, 3 blocked (reasons below).

### T1 — GBNF grammar-constrained emission ✅ RUN

Grammar `root ::= row{24}` / `row ::= [0-7]{24} "\n"`. The llama.cpp server accepts a
`grammar` field on `/v1/chat/completions`.

**Geometry solved outright** — 24 lines × 24 digits, every run, no exceptions. But content
was 1/3: one plausible blob, one vertical extrusion of a single repeated row, one blank
canvas. **Therefore the failure is conception, not counting** — which also answers T2.

### T2 — Mechanical row repair ⏭ SUPERSEDED by T1

T1 proved formatting was never the bottleneck. Repairing rows would fix nothing.

### T3 — Killing the repetition attractor ✅ RUN

Grammar on, 8 sampler configs × 4 seeds, scored on non-blank rows and max row repeat.

| config | good |
|---|---|
| `dry_strong` (dry_multiplier 1.5, allowed_length 12) | **4/4** |
| `hot_dry` (temp 1.0, dry 0.8) | **4/4** |
| dry 0.8 | 2/4 |
| hot | 2/4 |
| min_p | 1/4 |
| baseline / no_presence | 0–1/4 |
| repeat_penalty 1.05 | 0/4 |

**DRY sampling eliminates blank canvases and row-repeats completely.** Standard
`repeat_penalty` is useless here; it made things worse.

### T3b — …but the sprites still don't depict anything ❌ 0/12

Grammar + DRY, 4 subjects × 3 seeds, rendered to PNG (`t03b_grid.png`).
**Not one of the 12 depicts its subject.** No chest, no helmet, no potion bottle — just
clean-edged abstract blobs and rectangles.

**The earlier "good slime" was a false positive.** A slime is a shapeless blob, so any
random blob scores as a success. Subjects with actual structure expose it immediately.

> **Verdict: direct pixel emission is dead.** Grammar fixes geometry, DRY fixes
> degeneracy, and the model still cannot draw. Matches the literature's read–write
> asymmetry exactly.

### T4 — Critique modality ✅ RUN — *and the literature's ordering does NOT hold here*

10 random voxel scenes, exact ground truth, question: "how many of the 16 slices contain
a shape?"

| condition | exact | mean abs error |
|---|---|---|
| image only | 1–3 / 10 | 2.0–3.5 |
| image + neutral layout description | 4 / 10 | 1.2 |
| text only (raw digit grids) | 5 / 10 | 0.7 |
| image + stats JSON *(leaky — contains the answer)* | 6–9 / 10 | 0.1–0.7 |

ASCIIEval predicts **image-only >> text-only**. On our material it is **the reverse**.
The first `image_text` run at 9/10 was a confound I introduced — the stats JSON I passed
literally contains `layers_used`. Corrected, image-only is the *worst* condition.

**Finding 5 from Session 1 stands and is now stronger, not overturned.**

### T5 — Critique image scale sweep ✅ RUN

2× → 0/10, 4× → 0/10, 8× → 3/10, 16× → 1/10. **No resolution rescues counting.**
8× is the sweet spot but still unusable. Bigger is not monotonically better.

### T6 — `--image-min-tokens` sweep 🚫 BLOCKED

Requires restarting the llama-server, which runs as root in a container and is the user's
live service. Not touching it unattended.

### T7 — One question, one image ✅ RUN — **the one thing vision does well**

- "Does this single 16×16 slice contain any non-transparent pixels?" → **20/20 correct.**
- "How many distinct colours in this single slice?" → **2/18 correct.**

**Design rule: the model answers simple binary presence questions about one image
reliably, and anything requiring counting unreliably.** Compute counts in code, ask the
model only yes/no.

### T8 — Alternative critic (Gemma-3 27B) 🚫 BLOCKED

Needs a second model downloaded and loaded; both GPUs are at ~95% VRAM with Qwen3.6
resident. Sequential swap only, and that means taking the user's server down.

### T9 — Builder API ablation ✅ RUN

Same subject, three ways to ask, 4 seeds each, executed by the same renderer.

- **Raw JSON box list** — most reliable. No parse failures, mean score 5.8–6.9.
- **One-shot DSL program** — higher ceiling on some subjects but brittle: three runs
  scored 0.00 from unparseable or empty programs. Best-of-4 recovers it.
- **Interactive tool loop** — works, ~14 calls and 1–2 min per asset, much slower.

Contrary to the CAD literature's prediction, the program form did **not** beat coordinate
emission here — probably because our DSL is 4 commands, so there is no real "code"
advantage to exploit.

### T10 — Best-of-N with a code scorer ❌ THE SCORER DOESN'T WORK

Built `score.py`: connectivity, Euler characteristic, symmetry, density, side-view fill,
palette spread, groundedness. Then looked at the renders (`t09_all_side.png`).

**`json_vehicle` scored 6.80 and is unreadable. `json_organic` scored 6.93 and is the best
asset in the set.** Everything clustered 6.0–7.0. The metric does not correlate with
readability at the top end.

It *does* reliably catch total failures (0.00 = empty or unparsed). **Use it as a filter,
not a ranker.** A real fitness function is now the main open problem.

### T11 — Evolutionary refinement 🚫 BLOCKED on T10

Pointless without a fitness function that discriminates.

### T12 — Forced symmetry ✅ RUN

Small consistent gain, no downside — symmetry 0.74 → 0.88 on organic, 0.54 → 0.74 on
character, and `json_character_mir` is visibly the better character. **Keep it on.**

### T13 — Subject-class boundary ✅ RUN

- **Organic** (mushroom house) — reliable, best results overall.
- **Architecture** (stone tower) — reliable, reads clearly.
- **Character** (knight) — good via the JSON path: torso, red arms, legs, helmet.
- **Vehicle** (tank) — **unreliable**, failed in both sessions. Directional, asymmetric
  machines with a protruding barrel are the wall.

### T14 — Sprite-stack rotation holes ✅ RUN — pitfall reproduced and fixed

Naive rendering (each layer drawn once, spaced `dy` apart):

| | dy1 | dy2 | dy3 | dy4 |
|---|---|---|---|---|
| solid @45° | 0 | 3 | 53 | 28 |
| thin-walled @30° | 0 | 19 | **102** | 30 |

Holes appear **only at diagonal angles** — never at 0° or 90° — and are far worse on
thin-walled geometry. Drawing each layer `dy` times at 1px spacing gives **0 holes at
every angle and every spacing tested**. `vox.py` already does this.

### T15 — Voxel normals vs height-map + Sobel ✅ RUN

74 of 83 surface pixels differ by more than 40/255 between the two methods. Rendered
under three light directions (`t15_normals.png`): **exact voxel normals shade cleanly and
respond coherently to light direction; the Sobel baseline is blotchy and speckled.**
Claim confirmed — deriving normals from the volume is genuinely better, not just cheaper.

### T16 — Vision-backbone LoRA ⏸ NOT ATTEMPTED

Multi-day project, not a session task. Still the highest-ceiling option on the list.

---

## Where this leaves the design

The pipeline that survives every test:

**model authors a voxel volume via JSON boxes (symmetry forced, best-of-N filtered for
total failures) → deterministic renderer produces slices, stacked views at any angle,
side view, and exact normals.**

Vision stays in the loop **only** for binary presence questions about a single image.
Counting, indexing, and quality ranking must be code.

**The blocking problem is now the fitness function**, not the generator. Without a scorer
that separates a readable mushroom from an unreadable tank, best-of-N and evolutionary
refinement cannot work, and every asset needs a human eye.

---

## Session 1d — Spec-first generation, batch of 50

Model declares a spec (pieces, grounded, symmetric, proportion, protrusion, colours),
then builds to it, then code checks the build against the declaration.
`spec.py`, `batch.py`, output `batch_sheet.png`.

**1/50 passed. The number is meaningless — the check is broken, not the assets.**

All five trees are visibly good (green canopy, brown trunk, reads instantly) and all five
failed, mostly on `symmetric`. The model declared `symmetric: false`, then built a
symmetric tree. The check punished the asset for the *spec* being wrong.

So the spec check is a **self-consistency test — did the model's prediction match its own
output** — not a quality test. Two things it does do:

- **Catches hard failures.** 7/50 produced unparseable or empty JSON; all correctly flagged.
- **Handles the confetti case correctly.** Declared many/ungrounded, built scattered,
  passed. The scattered-vs-solid distinction is real and machine-checkable.

**What actually worked was the contact sheet.** 50 assets on one screen, and the verdict
takes seconds: trees, confetti, mushrooms and crystals are good; tanks, barrels and
campfires are not. Human eye, batched. No scorer involved.

### Standing conclusion

Automatic quality ranking is not solved and may not be worth solving. Keep the code checks
as a **garbage filter** (empty, unparsed, wrong topology class) and let the contact sheet
carry the judgement. Generation cost is low enough that overproducing and culling by eye
is the cheap path.

---

## Session 1e — Why machines fail, and the fix

**Cause, from the literature:** front-back reversal is a systematic measured failure
(14.7%), models show canonical-view bias, and heading is not represented as a manipulable
internal variable. A tank *is* frontedness. Mushrooms and trees have no front — that is
exactly why they succeed and vehicles do not.

### T17 — Prompt-level fixes: metric moves, result doesn't

Tank, 4 seeds each. Check = a thin part reaches the front AND wider than tall.

| condition | pass |
|---|---|
| baseline | 0/4 |
| explicit reference frame ("y=0 is the FRONT") | 2/4 |
| few-shot worked 3D example | 3/4 |
| 2.5-D layer decomposition | 1/4 |
| few-shot + layered | 3/4 |

**None of them look like tanks** (`t17_tank.png`). The measurable geometry improved and
readability did not. Prompt engineering cannot install a heading variable the model
doesn't have.

### T18 — Parametric templates: this works ✅

Code defines the tank's topology — tracks, hull, turret, forward barrel, mirrored. The
model only chooses 13 numbers and 4 palette entries.

All 4 variants produced correct tank structure (`t18_template.png`, row 2 = side view):
hull with tracks below and turret above, proportions and colours varying sensibly per
prompt ("heavy green" vs "small fast scout" vs "rusty brown desert").

**The trade is explicit: the structure is ours, the variation is the model's.** For any
asset class with a known skeleton — vehicles, weapons, buildings, furniture — write the
template once and let the model produce endless variants. Free-form sculpting stays for
organic and architectural subjects, where it already works.

---

## Session 1f — The better base: stop generating voxels with a language model

Templates are a dead end at scale — one template per asset class is just building the
game's art by hand. Two things I had been ignoring:

### A. A native voxel generator, locally

**TRELLIS.2** (microsoft/TRELLIS.2, **MIT licence, commercial use allowed**) generates 3D
directly in a sparse voxel representation — "O-Voxel", geometry plus appearance — at
512³/1024³/1536³. Original TRELLIS uses 64³ structured latents. Shape-only generation is
reported at **~6 GB VRAM minimum**; shape+texture 12–16 GB. Primary input is a reference
image; TRELLIS v1 also takes text.

This removes the language model from the part it is worst at. It has no heading variable
and no spatial grounding — a diffusion model trained on 3D geometry has both. Downsampling
a 512³ volume to 16³ or 32³ and quantising to our palette should give *cleaner* low-res
voxels than sculpting them directly, because detail is averaged rather than guessed.

**Proposed pipeline:**
`prompt → reference image → TRELLIS → dense voxels → downsample + palette quantise →
existing renderer → slices, rotation sheets, exact normals`

Our renderer, slicer, normal-map generator and hole-free rotation are already built and
validated — they don't care where the volume came from.

### B. CLIP as the fitness function I said didn't exist

CLIP score — cosine similarity between the embedding of a rendered view and the embedding
of the prompt text — is long established for steering generation and ranking candidates.
That is exactly the "does this read as a tank" measurement that `score.py` could not make
and that the spec check got wrong. It is small, local, and unblocks best-of-N and the
evolutionary loop (T10, T11).

Caveat: reported as better validated for CLIP than SigLIP as a standalone evaluator, and
untested by us on *pixel-art* renders specifically — the seesaw findings suggest low-res
stylised images may behave differently. **Test before trusting.**

### Honest cost

- `torch` is not installed; TRELLIS needs CUDA extensions and a real build.
- Both GPUs sit at ~95% VRAM with Qwen3.6 resident. TRELLIS and Qwen cannot both be live;
  either run sequentially or free a card.
- TRELLIS.2 is image-first, so a pixel-art or concept image step is likely needed in front.

### Revised role for the language model

Not a sculptor. Prompt and variant author, palette chooser, metadata and naming — the
text work it is actually good at.

---

## Session 1g — CLIP is the scorer ✅

CLIP ViT-B-32 (laion2b), **CPU only**, no GPU contention with the llama-server.
`torch 2.13.0+cpu`, `torchvision 0.28.0+cpu`, `open_clip_torch`.

### T19 — Can CLIP read our renders? Partly.

Retrieval over 4 subject classes: **11/17 side views, 12/16 stacked views** correct
against a chance rate of 4/16. So it genuinely sees them.

But **it does not separate good from bad across different subjects**:
mean GOOD 0.294 vs BAD 0.237 (side), 0.315 vs 0.293 (stacked) — right direction, ranges
overlap. The best asset (`json_organic`, 0.379) and the worst (`json_vehicle`, 0.213) sit
at the extremes correctly, but a good stone tower scored 0.188.

**This was the wrong test for the actual job.** Comparing across subjects is not what
best-of-N does.

### T20 — The right test: rank N candidates for ONE prompt ✅ **IT WORKS**

16 mushroom houses, same prompt, seeds 1–16. Each scored as the mean CLIP similarity over
5 renders (stacked at 0°/45°/90°/135° plus the side view), so one bad angle can't sink an
asset. Range 0.222 to 0.337.

`t20_bestof.png` — **CLIP's top 4 all have a red cap sitting on a brown stem. CLIP's
bottom 4 are a red slab, a thin red stick, a stemless blob, and a plain red rectangle.**
The ranking matches what a person would pick, with no human in the loop.

### Consequence

The blocking problem from Session 1c/1d is solved. Best-of-N (T10) and evolutionary
refinement (T11) are unblocked. The keep/kill contact sheet becomes a spot-check rather
than the mechanism.

**Working pipeline, all local, nothing new on the GPU:**
`Qwen writes the generator / picks parameters → deterministic renderer → CLIP ranks N
candidates on CPU → top-k kept → slices, rotation sheets, exact normals`

---

## Session 1h — In the repo, running end to end

Built on the existing `voxgen.py` / `voxslice.py` rather than forking them — the `.vox`
round-trip and hex palette there are better than what the scratchpad prototype had.

**Added:**

- `voxrender.py` — rotation sheets at N angles, exact voxel-surface normal maps rotated
  per frame, and a Lambert lighting pass to sanity-check the normals. Stdlib only.
- `voxrank.py` — CLIP ViT-B-32 on CPU, scoring a model as the mean similarity over four
  viewing angles. No GPU contention with the llama-server.
- `voxbatch.py` — generate N, rank, export the winner. Also exports the *worst*
  candidate, so the ranking stays auditable instead of being taken on faith.
- `.venv/` — CPU torch 2.13.0, torchvision 0.28.0, open_clip, pillow.

```
.venv/bin/python voxbatch.py "a red pickup truck" 10 out/truck
```

**End-to-end run:** 10 candidates, 1 dropped on a parse error, 9 ranked.
Winner 0.3171, loser 0.2031 — and the loser was a solid black 32³ brick, exactly the kind
of garbage the ranking is there to remove. Independently, ranking the hand-made models
put `truck.vox` at 0.3008 and `car.vox` at 0.1987, matching how they actually look.

**Bug found and fixed:** the first version applied the per-slice lift in voxel units
before scaling, stretching every model 4× vertically — the reason the first truck rendered
as a slab. Lift is now in pixels and defaults to `scale`, which is also exactly the
condition that keeps the stack hole-free (T14): consecutive slices are `scale` pixels
tall, so they touch and no gap can open at any rotation.

`results.html` regenerated with the live outputs.

### Sources

- [ASCIIEval: Benchmarking Models' Visual Perception in Text Strings via ASCII Art](https://arxiv.org/html/2410.01733v2)
- [ASCIIBench](https://arxiv.org/abs/2512.04125) · [Learning to Draw ASCII Improves Spatial Reasoning](https://arxiv.org/html/2604.14641v1)
- [Text Speaks Louder than Vision: ASCII Art Reveals Textual Biases in VLMs](https://arxiv.org/pdf/2504.01589)
- [EvoCAD: Evolutionary CAD Code Generation with Vision Language Models](https://arxiv.org/abs/2510.11631)
- [P3D-Bench](https://arxiv.org/html/2606.11152v1) · [MineBench](https://minebench.ai/) · [SpatialLLM](https://3d-spatial-reasoning.github.io/spatial-llm/)
- [llama.cpp grammar and structured output](https://deepwiki.com/ggml-org/llama.cpp/7.3-grammar-and-structured-output)
- [Analysis and Compilation of Normal Map Generation Techniques for Pixel Art](https://arxiv.org/pdf/2212.09692) · [DynaPix](http://yaksoy.github.io/papers/SIG22b-DynaPix.pdf)
- [Advanced Guide to Sprite Stacking](https://medium.com/@dev_dwarf/advanced-guide-to-sprite-stacking-using-gamemaker-studio-2-5b133ae5ca64)
- [Large Language Models for Computer-Aided Design: A Survey](https://arxiv.org/pdf/2505.08137)
