# Can the model read a voxel render? Measured, 2026-08-12

`docs/GEN_RESEARCH.md` records three separate deaths for feeding a render back to the model. None of
them ever asked the prior question: **does the model see the picture at all?** The revision loop was
declared dead on the evidence that the model re-emits identical code — which is a fact about
editing, not about looking.

This is that question, run as a benchmark with right answers. **1708 calls against the live
Qwen3.6-27B**, every one a fresh session, every answer a word from a closed list, every ground truth
computed from the voxel grid rather than declared.

The harness is `docs/spikes/vision/`, the per-call rows are in `out/vision/*.csv`, and the method is
in that directory's README. Nothing in `src/` was changed.

## The headline

**The model reads the renders well — 92 % across five geometric questions, against a 28 % floor.**
And that is not the useful part. The useful part is §8, which says the reading is worth nothing to
this pipeline, and §9, which closes the last open thread: asked to choose between two real
candidates of the same prompt, its answer survives being asked the other way round **7 times in 12.
A coin manages 6.**

## The floor, and why it is the most important number here

The same five questions with the pictures removed:

| question                     | options | blind score |
| ---------------------------- | ------- | ----------- |
| which shape is it            | 12      | 8 %         |
| how many separate pieces     | 5       | 25 %        |
| which measurement is largest | 3       | 33 %        |
| is any part floating         | 2       | 50 %        |
| which side is the red patch  | 4       | 25 %        |
| **overall**                  |         | **28 %**    |

Exactly chance on all five, which is what a balanced corpus is supposed to produce. **The first
corpus was not balanced and scored 89 % on "how many pieces" and 94 % on "is anything floating" with
the model's eyes shut** — 16 of its 18 shapes had one part and none of them floated, so the majority
answer was the right answer. Every question now has its own family, balanced by construction, and
`run.ts corpus` prints the majority share so nobody has to trust it.

Any score below is only meaningful as a distance from this table.

## 1. Pixel resolution barely matters, and more is worse

One three-quarter view of a 32³ model, free-form answers:

| size   | name  | longest | parts | floating | mark | all      |
| ------ | ----- | ------- | ----- | -------- | ---- | -------- |
| 64 px  | 92 %  | 67 %    | 75 %  | 67 %     | 38 % | 70 %     |
| 96 px  | 100 % | 78 %    | 83 %  | 83 %     | 50 % | **81 %** |
| 128 px | 100 % | 67 %    | 83 %  | 83 %     | 38 % | 77 %     |
| 224 px | 100 % | 67 %    | 83 %  | 83 %     | 25 % | 75 %     |
| 320 px | 92 %  | 67 %    | 83 %  | 83 %     | 38 % | 75 %     |
| 448 px | 92 %  | 56 %    | 83 %  | 83 %     | 38 % | 74 %     |

96 px is the peak and 64 px is the only size that is clearly worse. Nothing above 96 buys anything,
and 448 is the worst of the six. **Latency is flat too** — 2.1–2.2 s per call at every size, because
the vision tower resizes before it looks. So there is no trade here to make: `veto.ts`'s 224 px is
paying nothing and getting nothing.

## 2. Voxel resolution saturates at 32³ — the number the project already uses

One three-quarter view at 96 px, the same shapes rasterised into four grids:

| grid | name  | longest | parts | floating | mark | all      |
| ---- | ----- | ------- | ----- | -------- | ---- | -------- |
| 8³   | 75 %  | 67 %    | 67 %  | 83 %     | 38 % | 68 %     |
| 16³  | 83 %  | 67 %    | 75 %  | 92 %     | 50 % | 75 %     |
| 32³  | 100 % | 78 %    | 83 %  | 83 %     | 50 % | **81 %** |
| 64³  | 100 % | 78 %    | 83 %  | 92 %     | 38 % | 81 %     |

32³ and 64³ are indistinguishable; below 32 the shape stops being legible. This is independent
support for the canvas default in `gen/ask.ts`, arrived at from the opposite direction — that
default is 32 because it is where the worked examples were built, and this says 32 is also where a
render becomes readable.

## 3. One view cannot see depth, and this is the tank finding with a number on it

Across the whole pixel sweep, `longest` broken down by which axis actually won:

| true answer | correct  | what it said when wrong |
| ----------- | -------- | ----------------------- |
| height      | 18/18    | —                       |
| width       | 14/18    | —                       |
| **depth**   | **4/18** | **width, all 14 times** |

**22 % on depth is below the 33 % chance line**, and the errors are not scattered — every single one
calls a deep shape wide. From one three-quarter view, front-to-back and left-to-right are the same
foreshortened diagonal, and the model resolves the ambiguity the same wrong way every time.

`CLAUDE.md`'s finding 4 says "a tank comes back front-to-back reversed and no prompt fixes it". This
is the same axis, measured from the other end: the model cannot _read_ that axis either.

**Only a view from directly above fixes it.** Four elevations do not (0/3). Four three-quarter views
do not (0/3). Six views including the top does (3/3), and so does the five-view hybrid (100 %).
Width against depth is a plain 2D comparison from above and a foreshortening problem from everywhere
else.

## 4. Separate images beat a composite strip, and the strip is what died before

The record's "neutral yes/no over a four-view strip says no to everything" is reproduced and
explained. At 96 px, 32³:

| view set               | name  | longest | parts | floating | mark  | all      | s/call |
| ---------------------- | ----- | ------- | ----- | -------- | ----- | -------- | ------ |
| one three-quarter      | 100 % | 78 %    | 83 %  | 83 %     | 50 %  | 81 %     | 2.2    |
| two elevations         | 83 %  | 78 %    | 83 %  | 75 %     | 63 %  | 77 %     | 3.5    |
| four elevations        | 83 %  | 67 %    | 75 %  | 67 %     | 100 % | 77 %     | 6.1    |
| four three-quarter     | 100 % | 67 %    | 83 %  | 83 %     | 88 %  | **85 %** | 6.2    |
| six (with top, bottom) | 100 % | 100 %   | 75 %  | 58 %     | 100 % | 85 %     | 8.9    |
| four **as one strip**  | 75 %  | 67 %    | 33 %  | 58 %     | 63 %  | **58 %** | 2.3    |
| six **as one strip**   | 100 % | 67 %    | 42 %  | 83 %     | 75 %  | 74 %     | 2.5    |

The same four views cost **27 points** by being composited into one image instead of sent as four.
Counting pieces collapses from 83 % to 33 %. A strip is one image to the vision tower and the tiles
inside it are not separable; four images are four images. Every prior four-view result in this
project's record was a strip.

Multi-view is also not free in the direction 3DCodeBench warned about: `floating` is 83 % at one and
four three-quarter views and 58 % at six, and `parts` never improves past one view. **More views
help the questions that need a hidden side and hurt the questions that need a whole.**

## 5. Which side a feature faces is a geometry problem before it is a model problem

`mark` scores 50 % at one view and 100 % at four. Before crediting the model, the harness counted
the red pixels in each render: **a mark on the back or the left face contributes zero pixels to the
one- and two-view sets.** The one-view score is capped near 50 % by what is in frame, not by what
the model can do, and every one-view miss is a back or left mark.

This is worth stating as a rule: _a question about a face the render does not contain is a bad
question._ `visible.ts` exists so the next such question gets checked before it gets asked.

## 6. Labelled example pictures help, which is finding 7 holding in the image channel

One three-quarter view at 96 px, with N labelled renders of _other_ shapes placed before the
question — leave-one-out, so an example never contains the answer:

| examples | name  | longest | parts | floating | mark | all      | s/call |
| -------- | ----- | ------- | ----- | -------- | ---- | -------- | ------ |
| 0        | 92 %  | 78 %    | 83 %  | 67 %     | 50 % | 75 %     | 2.4    |
| 3        | 100 % | 89 %    | 92 %  | 83 %     | 50 % | **85 %** | 6.6    |
| 6        | 100 % | 100 %   | 83 %  | 83 %     | 38 % | 83 %     | 10.5   |

**Three labelled examples is worth ten points**, and six is not better than three — the same shape
the bank's `MAX_PICKS` argument has. `CLAUDE.md`'s finding 7 ("one worked example is worth more than
every rule in the system prompt") was measured about code replies; it holds for pictures too.

The gain is on `longest` and `parts` — the questions about geometry — and never on `mark`. Examples
teach the model what these renders _are_; they cannot show it a face that is not in the picture.

But see finding 8: at five views the examples are worth nothing, because the views have already
bought what the examples were buying.

## 7. The best configuration, and what a grammar costs

Five views — the four three-quarter angles plus one from directly above — at 96 px, 32³:

| configuration           | name  | longest | parts | floating | mark | all      | unparsed |
| ----------------------- | ----- | ------- | ----- | -------- | ---- | -------- | -------- |
| five views, free-form   | 100 % | 100 %   | 92 %  | 67 %     | 75 % | 87 %     | 3        |
| five views + 3 examples | 100 % | 100 %   | 92 %  | 67 %     | 75 % | 87 %     | 3        |
| five views, **grammar** | 100 % | 100 %   | 92 %  | 83 %     | 88 % | **92 %** | **0**    |

92 % against a 28 % floor, at 7.3 s a call.

The `unparsed` column is why the grammar arm exists. Asked whether anything floats, the model at
five views writes a paragraph that says both "yes" and "no" before committing, and a reply naming
two options has not answered. A GBNF `root ::= "yes" | "no"` removes the question. **It is not free
everywhere**: at four three-quarter views the same grammar took `mark` from 100 % to 75 %, which is
`CLAUDE.md` finding 7's "a constrained reply has nowhere to think" showing up on the hardest spatial
question. Use it where the answer is a label; do not assume it is neutral.

An earlier version of the views table showed 42 % for six-view `floating`. That was an 8-token cap
truncating "Based on the provided views…" — a harness bug that read as a finding about the model,
which is the worst kind. The cap is 96 tokens now and the honest number is 58 %.

## 8. And now the part that matters: none of this helps the generator

The five questions the model answers at 92 % are: what shape is this, how many pieces, is anything
floating, which axis is longest, which side is the mark on.

**`src/gen/score.ts` and `src/gen/repair.ts` already compute the first four exactly, from the voxel
grid, for free, in microseconds.** `connectivity` counts the components. `repair` finds the floating
debris and reattaches or drops it. `filledBounds` gives the axes. There is no version of this where
spending 7.3 s and five renders to get a 92 %-accurate estimate of a number the code already knows
exactly is an improvement.

And the one thing code cannot answer — _does this sprite depict its subject_ — does not improve with
any of it. The five bank models, named under `veto.ts`'s current single 224 px view and under the
best measured five-view configuration:

| model      | asked for      | one view @224 | five views @96 |
| ---------- | -------------- | ------------- | -------------- |
| `dog`      | a dog          | Cow           | Cow            |
| `chicken`  | a chicken      | Chicken       | chicken        |
| `farmer`   | a farmer       | Villager      | Villager       |
| `mushroom` | a red mushroom | Mushroom      | Red mushroom   |
| `tower`    | a stone tower  | Tower         | Tower          |

**Identical.** Five times the pictures and three times the wall clock move the naming call not at
all — the dog is a cow in both, the farmer a villager in both. Naming is already saturated at one
view, which the corpus said too: 100 % on the closed-list naming question from a single 96 px
render.

So the conclusion is not "the model cannot see". It is:

> **The model can see. Sight was never the bottleneck.** What it reads off a render is exactly the
> class of thing the deterministic code already knows, and what the pipeline actually needs — is
> this a good dog — is not a perception question.

## What this does and does not change

**Do not** wire a back-feed loop. Nothing here revives it: the revision findings are about the model
being unable to _edit_, and they are untouched. A model that reads its own render at 92 % and still
re-emits identical code is a model that cannot express a fix, which is precisely what
`docs/GEN_IDEAS.md` diagnosed.

**Do not** change `veto.ts`. Its single three-quarter view is measured here as sufficient for the
only job it has. The 224 px could be 96 px for no gain and no loss; that is not worth a commit.

**Three things are worth carrying forward**, and all three are cheap:

1. **If a vision call is ever added, send separate images, never a strip.** 27 points, measured.
2. **If anything ever asks the model about depth, put a camera directly above it.** Otherwise the
   answer is "width" and it is wrong 78 % of the time.
3. **The harness itself.** `docs/spikes/vision/` is a benchmark with a floor, balanced classes and
   computed truth. The next "can the model do X with a picture" question should be run through it
   instead of being argued about — three of this session's five near-misses were harness bugs (an
   unbalanced corpus, a truncating token cap, a red-detector that ignored face lighting), and each
   one would have shipped as a finding.

## 9. Can it rank? It is a damage detector, not a judge

The last open thread, and it is now closed. Finding 2 in `CLAUDE.md` says the model gave 4/4 and 1/4
to pictures that could not be told apart — but that was one view, free-form, and asking for a
_score_. Asked as a forced choice over five views with a grammar, it is a different question.

Ranking needs a right answer, and a right answer about quality is an opinion. So it was bought with
**damage** instead: each of the five bank models against itself with a known, deterministic
corruption applied — one voxel in twelve thrown into the air, a shaft erased through the middle, the
top half lifted five cells clear, every other layer dropped. The undamaged one is better and nobody
had to judge that. `seen.ts` measures how much of the silhouette each damage actually changes and
**skips the pairs that do not change the picture** — the shaft through the tower is behind the
tower's own wall, and `dog`/`hole` came in at 2 % and was not asked. Same rule as the mark.

| condition                  | picked the undamaged one | n   |
| -------------------------- | ------------------------ | --- |
| one view, all damage       | 84 %                     | 38  |
| **five views, all damage** | **92 %**                 | 38  |
| — debris                   | 100 %                    | 10  |
| — top half floating        | 100 %                    | 10  |
| — squashed to half height  | 90 %                     | 10  |
| — shaft through the middle | 75 %                     | 8   |

92 % against a 50 % coin. **It sees damage.** And then:

### The same test on real candidates, where nothing is obviously broken

Ten candidates generated live at temperature 0.9, seeds 4200–4204, for "a cat" and "a stone tower",
one built-in example each so that only the seed varies. Every pair asked twice with the two models
exchanged. There is no ground truth here and none is needed: **a judge that names a different model
when the pictures change places is noise, whatever its taste is like.**

| prompt        | pairs whose answer survived the swap |
| ------------- | ------------------------------------ |
| a cat         | 4 of 6 (67 %)                        |
| a stone tower | 3 of 6 (**50 %**)                    |
| **pooled**    | **7 of 12 (58 %)**                   |

**A coin manages 50 %.** And the failure has a shape: **every single flip is "B then B"** — five
flips out of five, the model naming whichever candidate was shown second. The same lean shows in the
damage test, where the undamaged model scored 100 % when shown as B and 84 % when shown as A, and
every miss was "said B".

The control makes it stranger and no better: shown the _same model twice_, it answers A five times
out of five, in both view sets. So this is not a flat position prior. It is a prior that appears
exactly when the two pictures genuinely differ and the difference is too fine to call — which is
precisely the case a ranker exists for.

Agreement with `overallScore` over the consistent pairs was 0 of 4 on cats and 3 of 3 on towers. n =
7 across two prompts, which is worth writing down and not worth concluding from.

**So: a damage detector, not a judge.** It reliably spots a model in two floating halves — which is
exactly what `gen/repair.ts` already finds in code, deterministically, for free, and then fixes
rather than merely reporting. It cannot separate two seeds, which is the only ranking this pipeline
would want. Finding 3 stands and now has a second, independent measurement under it.

## Cost

1708 calls, about two hours of server time, two slots in flight. Renders are 6–45 ms each on the CPU
raycaster and never the bottleneck.
