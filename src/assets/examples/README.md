# The worked-example bank

One directory. One manifest. No build step.

The examples are the ceiling on everything the generator produces — measured twice on 2026-08-08, in
both directions — so a better teacher here is the highest-leverage change available.

## Adding a model

1. Drop the `.vox` or `.gpix` in this directory.
2. Add or edit its entry in `examples.json`.
3. Reload the app.

The model is decomposed into `box(...)` code when the generate dialog opens, and the model picks
which examples a prompt gets from the `use` lines below.

## `examples.json`

```json
{
    "id": "dog",
    "subject": "a dog",
    "use": "stands on four legs: cat, horse, bear, cow",
    "notes": "body 3 wide, 5 tall, 12 long; head at the front-top; legs at the corners",
    "file": "dog.vox"
}
```

- **`id`** — lowercase, no spaces. What the picking call answers with.
- **`subject`** — becomes the example's user turn.
- **`use`** — one line, and the only thing the picking call reads. Say when to reach for this
  example, with a few subjects.
- **`notes`** — the example's opening comment, in your words. Write the proportions. It matters:
  every example opens on proportions and the model imitates planning before it draws, and a
  decomposer cannot read proportions out of voxels. Leave it empty and the comment is only the
  measurements.
- **`file`** — optional. Without it the entry teaches with the hand-written reply in
  `src/gen/builtin.ts`, which is how the shipped five work today.

`fallback` at the top names the entry used when the picking call answers with nothing recognisable.

## `car.vox` is a fixture, not an example

It is in this directory and deliberately not in `examples.json`. `browser/generate.spec.ts` uses it
to prove the directory is really bundled — that check exists because the loader once switched itself
off in the browser and every entry silently fell back to its built-in reply, which `bun test` cannot
see. A car is also 6 tall and would fail the height check below, so it is not a teacher.

## Limits

- **32 on any axis.** The op language does not go past it.
- **80 lines once decomposed.** Every candidate in every batch pays for every example it is shown,
  in full, and a prompt carries up to three. `bank.test.ts` fails the build over it. Simplify the
  model, not the budget.
- **Anything you add must still be a model**: one connected piece, not a solid brick, taller than 8.
  Same test.

## One-off references

You do not have to touch this directory to use your own model once. The generate dialog has a drop
target — drop a `.vox` or `.gpix` on it and that model teaches the next batch, ahead of everything
picked from here. It is remembered until you clear it.

## After a swap

Generate cat, knight, chicken, mushroom and tower at fixed seeds before and after, look at the
renders, and append the numbers to `docs/GEN_RESEARCH.md`. Test a second subject per entry: an
example that makes cats better and drags foxes into cat shapes is the known failure mode.
