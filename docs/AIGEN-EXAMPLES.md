# AIGEN: real assets as worked examples

A self-contained brief. Execute it in a fresh session. Read `docs/GEN_RESEARCH.md` and `CLAUDE.md`
first; do not re-run anything the research doc marks dead.

## Goal

Replace the hand-written worked examples in `src/gen/llama.ts` with decompositions of real
artist-made `.vox` assets. Measured twice on 2026-08-08: the model imitates the example almost
exactly, in both directions — the example is the floor and the ceiling. Better teachers are the
single highest-leverage change left.

## Precondition — stop if it is missing

A few good CC0 `.vox` assets, one per body plan that needs upgrading (quadruped, humanoid, bird,
plant, building), each fitting in 32³ or scalable into it. **Ask the user for them before writing
code.** The sandbox has no reliable internet; do not scrape. `assets/car.vox` exists but a car is
a body plan the generator does not even offer.

## Build

1. A decomposer, `src/gen/decompose.ts`: `Volume` in, ops out — greedy largest-box extraction
   (grow the biggest same-colour box, emit it, repeat), single voxels as 1×1×1 boxes at the end.
   It must be **lossless**: rasterising the emitted ops reproduces the input volume byte for byte.
   That is the test, and `src/vox/` already reads `.vox` into a `Volume` for you.
2. Remember the axis swap: op space is y-up, `Volume` is z-up (`src/gen/ops.ts`, finding 5). The
   decomposer emits op-space coordinates.
3. A rendering of ops as the code format: emit `box(x0,y0,z0, x1,y1,z1, '#hex')` lines, colours
   as named `const`s, grouped by colour. Target under ~80 lines per example — an example that
   costs 3000 tokens per candidate is paying rent on every call. If an asset decomposes into
   hundreds of boxes, simplify the asset, not the decomposer.
4. Swap `EXAMPLES` entries one plan at a time. Keep each new example passing `llama.test.ts`
   (one connected piece, not a brick, taller than 8) — those checks exist because a broken
   example teaches breakage.

## Verify live, then record

For each swapped plan, generate 4 of the old benchmark subjects (cat, knight, chicken, mushroom,
tower) at fixed seeds before and after the swap. Render strips, look at them, and let the naming
question ("what does it depict, one or two words") count for you. An example that makes cats
better but drags foxes into cat shapes is the known failure mode — test a second subject per
plan. Append results and date to `docs/GEN_RESEARCH.md`.

## Done means

`bun run check` green, including the lossless round-trip test; the new examples render as what
they claim (your eyes, not just the scores); live before/after numbers in
`docs/GEN_RESEARCH.md`; the old examples kept in git history, not in the file.
