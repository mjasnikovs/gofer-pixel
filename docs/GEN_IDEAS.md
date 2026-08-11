# Generation: where to go next, 2026-08-11

`docs/GEN_RESEARCH.md` is the record of what was measured and what died. This is the other half: ten
directions that are **not** on the dead list, each with what it attacks, why it is not already
refuted, what it costs and how it would be measured. Nothing here has been run. Written after
reading `src/gen/` and four 2026 papers on the same problem — the outside evidence is at the bottom
and it changes the ranking, so read that section before arguing with the order.

## The diagnosis first

The three complaints in the record are **boxy silhouettes, proportions that drift with the seed, and
nothing above ~20 primitives coming back coherent**. All three are one failure, and it is not a
prompting failure:

- The op language makes the model responsible for **absolute integer coordinates in 3D**. Twelve
  numbers per limb, every one of which has to agree with twelve others for the parts to touch.
- The outside literature says this exact thing is the wall. 3DCodeBench's two named failure modes
  are "disconnected parts and incorrect structural alignments", which it calls "a fundamental gap in
  geometric reasoning rather than mere code syntax knowledge". SpatialBabel is blunter: **"precise
  coordinate extraction remains near-zero across all configurations due to discrete token vocabulary
  limitations."**
- So the ceiling is not the prompt, not the sampler and not the ranker. Every remaining move is one
  of two shapes: **take the coordinates away from the model**, or **fix the geometry in code
  afterwards**. Nine of the ten below are one of those two. The tenth replaces the model.

This also explains why the revision loop died three times. The model is not withholding a fix; it
cannot express one in the representation it was handed.

## 1. Repair the volume in code, before anything ranks it

**Attacks:** disconnected parts, floating hats, one-voxel-thin limbs, models that do not reach the
floor. **Cost:** one module, zero model calls, no wall clock. **The cheapest thing on this list.**

`score.ts` already _measures_ every one of these and then only sorts by them. A candidate at 0.59
connectivity is a fish in fragments, and the record contains that number because a batch produced
it. Measuring it and then ranking it low means the artist sees six candidates of which two are
debris; repairing it means they see six models.

A deterministic pass over the `Volume` after `rasterise` and before `finish`:

- drop 6-connected components under some fraction of the largest (the walk is already written)
- close one-voxel gaps between two large components — a single dilate-and-intersect along the axis
  that separates them, which reattaches a head rather than deleting it
- snap the whole model down so the lowest filled layer is `z = 0`, because the prompt has always
  said feet at y = 0 and the model does not always oblige
- thicken any 1×1 column that carries more than a few voxels above it
- mirror in x when the model is _nearly_ symmetric — over some threshold, take the better half

**Why this is not the dead revision loop:** nothing is fed back to anything. It is arithmetic on a
grid, deterministic, and therefore reproducible from the record, which is the property
`rasterise → finish` was built to keep.

**Measure:** run it over the candidates already in `docs/renders/`. Every one is stored, so this is
a before/after by eye with no server involved. Keep each rule only if it fixed a picture without
breaking one.

**Risk:** a repair that fires on a good model is worse than a failure that is honest. Every rule
needs a threshold and a test with a good model on the other side of it.

## 2. Give the model relations instead of coordinates

**Attacks:** the root cause. **Cost:** a new op layer, a rewrite of five worked examples, one live
batch to compare. **Highest leverage on the diagnosis above.**

Today: `box(5,0,5, 7,9,7, pants)`. Twelve numbers, and the leg touches the torso only because the
model got both sets right.

Instead, a language where the model emits **sizes and attachments** and code computes the numbers:

```js
const torso = part('torso', 9, 8, 5, shirt) //  w, h, d
const head = attach('head', torso, '+y', {w: 5, h: 5, d: 5, color: skin})
legs(torso, '-y', {count: 2, length: 10, thick: 3, color: pants}) // planted on the floor
arms(torso, {length: 7, thick: 2, color: shirt, hangs: true})
```

Three of today's failure modes become **unrepresentable**: parts cannot fail to touch, limbs cannot
fail to reach the floor, and a mirrored pair cannot come out uneven. The model keeps the part it is
actually good at — which parts exist, how big each is relative to the last, what colour — and loses
the part it is measurably bad at.

**Why this is not refuted:** 3DCodeBench reports no gain from "retrieval, part libraries or symmetry
exploitation", which reads like a refutation and is not. Those were tested as _additions to_
absolute-coordinate Blender Python. This changes the coordinate system itself, which is the thing
its own failure analysis points at.

**Measure:** the five bank subjects at the three fixed seeds (4200–4202), old language against new,
renders judged by eye — the same protocol the three-examples measurement used. Watch specifically
whether the model stops using the language and reverts to boxes: it will need `box` kept as an
escape hatch, and if every reply is `box` the idea is dead.

**Risk:** the worked examples are the ceiling (finding 7), so a new language starts with five badly
written examples in it. Write the examples first, render them, and only then measure the language.

## 3. Two silhouettes, intersected — the visual hull

**Attacks:** boxiness, which is the one complaint neither of the above fixes. **Cost:** one prompt
and one rasteriser, ~60 lines. **The only idea here that could change how the output _looks_ rather
than how often it holds together.**

A sprite artist thinks in silhouettes, not in solids. The classical shape-from-silhouette result is
that two orthographic silhouettes, extruded and intersected, bound a solid — and for the subjects
this project cares about (a fish, a mushroom, a cat) that bound _is_ the model.

So ask for two 2D outlines and intersect them:

```js
front([[6, 10], [5, 12], [3, 14], ...])   // half-width per row, mirrored
side([[2, 9], [4, 14], [7, 12], ...])     // depth per row
```

A curved outline gives a curved body, from about twenty numbers instead of twenty boxes. Detail —
eyes, a comb, a sword — stays in `box`, painted after.

**Why this is not finding 1.** "The model cannot draw pixels" was measured on it drawing the
**finished sprite**: colour, shading, 128 px wide, 0 of 12 depicting the subject. A monochrome
outline 16 rows tall is a different task and an unmeasured one.

**Risk, and it is real:** VGBench finds open-weight models are the weakest at exactly this kind of
low-level 2D output, and the ASCII-art benchmarks are about _recognising_ art, not drawing it. Ask
for numeric row spans, never for an ASCII grid — spans are arithmetic and a grid is alignment, and
alignment is what fails.

**Measure:** cheapest test on this page. One prompt, four subjects, one candidate each, look at the
outline as a picture before rasterising anything. If the outlines are not shapes, stop there — an
afternoon, not a session.

## 4. Hard gates and resampling, instead of ranking failures

**Attacks:** the artist spending their attention on candidates nobody would keep. **Cost:** wall
clock, which is already 7–20 s a candidate.

`overallScore` sorts. Nothing rejects. Add thresholds — connectivity, bbox fill above which it is a
brick — and a candidate that fails is discarded and the seed advanced, so a batch of six is six
_plausible_ models. The three solid bricks in the "stone tower" batch are the case: they are not a
sort-order problem, they are three empty slots.

**Why this is not the dead revision loop:** nothing is fed back, the prompt does not change, and the
model is never told it failed. It is rejection sampling.

**Measure:** the numbers are already in the record. Pick thresholds that would have dropped the
three bricks and kept everything the record calls good, then check the cost in candidates-per-usable
against the record's own hit rates (3/8 for a cat, 0/8 for a knight — a knight would loop forever,
so the cap on resamples is part of the design, not an afterthought).

## 5. Give CLIP a negative anchor — built, measured, and CLIP is now gone

**Outcome, 2026-08-11: the anchors moved three of four orderings not at all, and the scorer was
removed entirely.** See `GEN_RESEARCH.md`. A sort order cannot be looped against and the model
cannot edit, so a second opinion bought nothing a fix could be built on. The rest of this section is
why it was worth trying.

**Attacks:** "a good stone tower scores below a mediocre mushroom", and bricks tying at the top.
**Cost:** a few text embeddings, once. No extra calls per candidate.

CLIP is used as `sim(render, prompt)`. Use `sim(render, prompt) − max sim(render, negatives)` with a
fixed handful of negatives: _a solid rectangular block, a pile of scattered cubes, an empty grey
grid_. This is standard contrastive practice and it attacks precisely the measured defect: a brick
is _strongly_ similar to "a solid rectangular block", so the term that ties at the top of every
deterministic score gets pushed to the bottom of this one.

**Measure:** offline, against the renders in `docs/renders/`, no server. Rank agreement against the
built-in score and against a by-eye ranking. It stays a sort order inside one prompt either way —
finding 3 is untouched.

## 6. Route to procedural generators where the subject actually has one

**Attacks:** the 20-primitive ceiling. **Cost:** one generator at a time.

Finding 4 says organic and architectural subjects work and directional machines do not. Plants and
buildings are also exactly the two things procedural generation has solved for forty years. So let
the model do what the picking call already does — choose — and let code do the geometry:

`tree({trunk: 3, height: 26, branches: 5, leaf: '#3a7a2a'})` is an L-system with four hundred voxels
of branch in it, from four numbers the model is good at. A tower is a grammar: courses, battlements,
windows per face. A rock is noise with a threshold.

This is not general and should not pretend to be. Two or three generators, chosen by the same call
that picks the example, and everything else falls through to the op language.

**Measure:** it is not a measurement, it is a build. Judge it the way the bank is judged: render it,
and ask whether an artist would keep it.

## 7. Ask for something smaller than a whole model

**Attacks:** difficulty, from the other side. **Cost:** UI, mostly.

Two versions, both of which use seams the app already has:

- **A batch of parts.** Six heads at 8³, or six hats, or six swords. A hat is a subject the model
  can actually finish, and selection and transforms are already built for placing one on a figure.
- **Variations of the artist's own model.** `gen/reference.ts` already decomposes a dropped `.gpix`
  into ops losslessly. Perturbing those ops — a longer tail, a wider stance, one colour rotated —
  needs **no model call at all**, and it is the request an artist actually has once they have one
  good dog.

The second is the one to build. It is deterministic, instant, and it turns the decomposer that
already exists into a feature rather than a prompt ingredient.

## 8. Put real assets in the bank, and drop `MAX_PICKS` to 1

Not new — it is the standing lead in `GEN_RESEARCH.md` — and it is still the highest-leverage
_known_ thing, because the examples are measured to be the ceiling in both directions. One line for
the second half. The first half is five CC0 `.vox` files that fit inside 32³ and decompose under 80
lines, and a before/after at fixed seeds for each swap.

It is listed eighth rather than first only because everything above it attacks the geometry and this
attacks the taste. Do it anyway; it is the least speculative item on the page.

## 9. Spend the veto's call on a candidate instead

`veto.ts` costs a second 27B call per candidate to move one number in a status line, and the naming
call before it is honest but unusable as a key. That budget buys a fraction of another candidate per
batch. Not an idea so much as a trade to make once one of the ideas above needs wall clock: the word
under the thumbnail is worth keeping, `couldDescribe` is not obviously worth keeping.

## 10. A real 3D generator as a second backend

**Attacks:** everything, and it costs the GPU.

`VoxelModel-v1` is on the dead list — a 40M CPU diffusion model whose silhouettes beat the op
pipeline and whose surfaces were hollow, noisy melt. That verdict is about a 40M model, not about
the approach. **TRELLIS-class generators are the interesting shape here**, because their first stage
_is_ a sparse voxel occupancy grid at 64³ — the thing this project wants — and the expensive second
stage that produces appearance is the part that could be skipped entirely, since the palette is the
project's own.

The blocker is stated in `CLAUDE.md`: both GPUs are at ~95 % VRAM with llama-server loaded, and it
is not to be restarted casually. So this is a **spike, not a feature**: unload once, deliberately,
run four prompts, voxelise, look at the silhouettes, write down the verdict, reload. If the
silhouettes are what the op pipeline cannot reach, the architecture question ("two backends, one of
which owns the GPU") is worth having. If they melt like VoxelModel-v1 did, the dead list gets one
more entry and nobody spends a session on it again.

## 11. One retry when the reply painted nothing

3DCodeBench's one strong positive result: feeding the **execution error** back and retrying took
executability from 70.2 % to 97.4 %, across every model size. That is a different thing from feeding
a _render_ back, which the same paper found does not improve geometry — and which is what died here
three times.

`specFromCode` swallows the crash and keeps whatever painted, so this project's version of that
failure is `the reply held no usable ops`: ten seconds spent and a blank slot. **Count how often
that happens before building anything.** If it is rare the idea is worthless; if it is one candidate
in six, one retry carrying the thrown message is cheap and the outside number says it works.

## What the outside evidence actually says

Four papers, read 2026-08-11. Two of them confirm this project's dead list, which is worth more than
a new idea:

- **3DCodeBench** (arXiv 2606.01057): visual self-critique loops "remain indistinguishable from a
  single prompt" on shape quality — **the revision loop is dead in the literature too**, and this
  project need not have found that out three times. Error-feedback retry is the one large win (70.2
  → 97.4 % executable). Its named failure modes are disconnected parts and structural misalignment.
  Multi-view input helps only the largest model tested; smaller models "saturate or degrade beyond
  1–2 views", which is a caution against ever handing a 27B model a four-view strip — and this
  project measured that same failure independently.
- **3D Primitives are a Spatial Language for VLMs** (arXiv 2605.12586): precise coordinate output is
  near-zero across every configuration, and reconstruction quality varies **up to 5.7×** with the
  choice of scene-code language for the same model and image. The language is not a detail; it is
  most of the result. That is the argument for §2 and §3.
- **LLM-Primitives** (SIGGRAPH Asia 2025): caps its models at 50 primitives of three types. This
  project's ~20-primitive coherence ceiling is in the same order as a paper's design limit, not a
  bug to be prompted away.
- **VGBench** (arXiv 2407.10972): LLMs are worst at low-level vector formats, with open-weight
  models behind — the risk on §3, stated in a number.

## The order I would take them in

1. **§1 repair** and **§5 negative anchors** — both offline, both against renders already on disk,
   no server, an afternoon each.
2. **§3 silhouettes**, as a one-prompt probe. Kill it fast if the outlines are not shapes.
3. **§8 assets and `MAX_PICKS = 1`**, because it is known-good and unglamorous.
4. **§2 the relational language**, which is a session, and the one that changes the architecture.
5. **§10 the spike**, once, when there is an appetite for restarting llama-server.

Sources: [3DCodeBench](https://arxiv.org/html/2606.01057v1),
[3D Primitives as a Spatial Language for VLMs](https://arxiv.org/html/2605.12586v1),
[LLM-Primitives](https://llm-primitives.github.io/LLM-Primitives/),
[VGBench](https://arxiv.org/pdf/2407.10972), [TRELLIS.2](https://github.com/microsoft/TRELLIS.2),
[Shape from Silhouettes](https://www.sci.utah.edu/~gerig/CS6320-S2015/Materials/CS6320-S2015-Shape-from-Silhouttes-I.pdf).
