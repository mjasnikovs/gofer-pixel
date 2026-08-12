# vision — can the model *read* a voxel render?

`docs/GEN_RESEARCH.md` records that feeding a render back and asking for a fix is dead, three times
over. It does **not** record whether the model can see the picture at all. That is the gap this
spike measures, and it measures it as a benchmark with right answers rather than as an impression.

Nothing here is product code. Like the rest of `docs/spikes/` it is excluded from lint, format,
typecheck and test, and nothing in `src/` imports it.

```bash
bun docs/spikes/vision/run.ts corpus [grid]        # build the shapes, write contact sheets, print truth + balance
bun docs/spikes/vision/visible.ts                  # is the marked face even in frame? no server needed
bun docs/spikes/vision/run.ts control              # no pictures — the floor every score is read against
bun docs/spikes/vision/run.ts size [sizes]         # 64 … 448 px, one three-quarter view
bun docs/spikes/vision/run.ts grid <px>            # 8³ … 64³ at one pixel size
bun docs/spikes/vision/run.ts views <px>           # one / two / four / four-iso / six, separate and as a strip
bun docs/spikes/vision/run.ts examples <px> <set>  # 0, 3 and 6 labelled example pictures
bun docs/spikes/vision/bank.ts                     # the five bank models named, current config vs best
bun docs/spikes/vision/seen.ts                     # how much of each damage is in the picture; no server
bun docs/spikes/vision/pairs.ts                    # forced choice: a bank model against a damaged copy
bun docs/spikes/vision/real.ts "a cat" 5           # forced choice between real candidates of one prompt
```

Results land in `out/vision/<stage>.csv`, one row per call, with the model's raw words kept.

## The four rules that make it a measurement

1. **Ground truth is computed from the grid, never declared.** `truthOf` walks the volume:
   6-connected components, filled bounds, which component touches the floor, where the marked colour
   sits relative to the model's own centre. A shape whose label disagrees with its geometry is a bug
   in the shape, and the truth table is printed so it can be read.

2. **Every answer is one option from a closed list, matched as a whole word.** No judging, no
   partial credit. A reply matching none of the options — or two of them — is `unparsed`, counted as
   wrong and reported separately.

3. **The no-image control is the floor.** The same questions with the pictures removed. It is not
   optional: the first corpus scored **89 % on "how many pieces" and 94 % on "is anything floating"
   with the model's eyes shut**, because 16 of 18 shapes had one part and none of them floated. Each
   question now has its own family, balanced by construction, and `run.ts corpus` prints the
   majority share so the balance is checked rather than believed. Measured floor: 8 / 25 / 33 / 25 /
   50 % — exactly chance on all five.

4. **Colour never carries the answer.** One neutral grey-blue for everything. The first smoke run
   called a red ball "Tomato".

5. **A question about something the render does not contain is a bad question.** `visible.ts` counts
   the marked pixels per view set and `seen.ts` counts how much of the silhouette a damage changes;
   both run before the calls, and a pair under the threshold is skipped rather than scored. Two
   results were nearly published as findings about the model before these existed: a mark on the back
   face, which no one- or two-view set contains, and a shaft erased through a tower, which is behind
   the tower's own wall.

## Ranking needs a right answer, so it is bought with damage

`pairs.ts` and `real.ts` ask a forced choice — *which of these two is the better dog* — grammar-
constrained to `A` or `B`. Quality has no ground truth, so two things stand in for one:

- **Damage**, in `damage.ts`: a bank model against itself with a deterministic corruption applied.
  The undamaged one is better and nobody judged that.
- **Order**, on real candidates: every pair asked twice with the models exchanged. A judge that names
  a different model when the pictures change places is noise regardless of its taste, and that needs
  no ground truth at all. A coin survives the swap half the time; that is the number to beat.

A pair of *identical* models is the third control: there is no right answer, so whatever it says is
what it says when it cannot tell.

## The seams it reuses

The renders come from `src/render/raycast.ts` — the same CPU raycaster that exports every sprite —
through the same grey composite `src/gen/veto.ts` sends its naming call. So a number here is a
number about the pictures the app actually makes.

Two things are deliberately *not* `veto.ts`'s: the frame is the filled bounds' diagonal rather than
`defaultZoom`, and the camera pans onto the model's own centre. `defaultZoom` frames the whole grid,
so a shape on the floor of a 64³ cube spends most of its pixels on air — which is the exact variable
a resolution sweep exists to measure.

## Every call is a fresh session

Verified live, 2026-08-12: a request asking "what was in the image I just showed you", sent straight
after an image request, answered *"I cannot see any image."* `/v1/chat/completions` is conditioned on
the body and nothing else, so no clearing, no slot juggling and no cache-busting is needed. One call
is one session.
