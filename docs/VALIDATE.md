# Validating a gesture

A prompt to paste when a tool "does not work", or before claiming one does.

## Why this exists

`bun test` has 198 tests and it could not see that double-click had never worked. `pressSelection`
reads `event.clicks`; the viewport filled that in from `PointerEvent.detail`, which is **0 on
`pointerdown` by specification**. The reducer was right and the input layer was lying to it. Every
reducer test builds a `ViewportPointer` by hand and hands the count in, so none of them could fail.

Three bugs in one session came from the same shape of mistake — reasoning about the state machine
instead of driving the app:

| Bug                                          | Why `bun test` missed it                                  |
| -------------------------------------------- | --------------------------------------------------------- |
| Double-click never fired                     | the count is synthesised in the test                      |
| Rotate's drag slid voxels sideways like Move | nothing asserted the tool did its own thing               |
| Rotate flickered between two pictures        | four quarters is the identity, which reads fine in a diff |

## The prompt

```
Validate <TOOL / GESTURE> in a real browser. Do not reason about it from the reducer.

1. State the claim. Read the code and write down exactly what this gesture is supposed to do,
   with the file and line it comes from. If the code and the tooltip disagree, say so.

2. Drive it. Add a throwaway spec under browser/ that uses browser/driver.ts and page.mouse.
   Nothing may be synthesised: no dispatch of pointer actions, no hand-built ViewportPointer.
   dispatch is allowed only to arm a tool. Read the result back through src/app/handle.ts,
   never by scraping the DOM.

3. Sweep, do not sample. Log the outcome across a range — drag distances, both directions,
   several click counts — and print the table. One data point hides a boundary; a boundary is
   where these bugs live.

4. Report the measurement before the opinion. If it works, say so with the numbers. If it does
   not, say which line is wrong.

5. Fix it, then move the throwaway spec's assertion into browser/gestures.spec.ts so the bug
   cannot come back. Delete the throwaway.

6. Run `bun run check` and `bun run test:browser`. Both must pass.
```

## What the harness gives you

`browser/driver.ts`:

- `ready(page)` — loads the app and clears the autosave, so it is a real reset. `main.tsx` reopens
  the latest snapshot from `localStorage`, and without the clear a second `ready()` in one test
  hands back the document the first half of that test just edited.
- `arm(page, tool)` — arms a tool. The one dispatch that is allowed.
- `viewport(page)` — the viewport's box. The centre is over the model, the corner is over air.
- `read(page)` — voxel count, a hash of the grid, selection size, undo depth, the live drag kind,
  the loaded colour, the camera's yaw.

## Traps that have already caught someone

- **`ready()` was not a reset.** See above.
- **The model fills the viewport.** There is then nowhere to start a rubber band, because a band
  only begins on air.
- **A press outside the selection replaces it** with the one voxel under the cursor. To drag a
  group, press inside it. To build one up, Control-click.
- **A single voxel is its own rotation.** Rotate can never look like it works on one voxel.
- **A move or a clone overwrites what it lands on**, so a voxel count that did not change is not
  proof that nothing happened — and a clone onto an identical neighbour writes nothing at all, so it
  does not even leave an undo step.
- **A drag stays in the plane of the face it grabbed.** A vertical drag on a top face moves the
  selection horizontally through the model.
- **Symmetry hides direction.** A solid box turns to the same cells whichever way it goes round, so
  a test on one cannot tell left from right. Knock a corner out.
- **`car.vox` is symmetric, and a mirror onto itself writes nothing.** The reducer then keeps the
  old state, because there is no edit to record — which is indistinguishable from a dead button.
  Draw one voxel first.
- **A big selection cannot turn.** The grid is 16 × 10 × 7 and a rotation is refused whole rather
  than half-done, so six of the eleven selection-bar buttons legitimately did nothing on a 126-voxel
  selection. One click and two presses of `]` is ten voxels, and that fits every way.
- **Four quarter turns is not the identity** on a dense model. The first turn overwrites the
  neighbours it lands on and the fourth cannot bring them back. Assert the bijection instead: the
  selection never changes size.
- **A pixel offset from the viewport centre is not a place on the model.** The viewport grows and
  shrinks with the panels beside it, so `centre + 40, centre + 24` moves to a different voxel when a
  panel loses a row — and a press that lands back inside the current selection keeps it instead of
  replacing it, which reads as a broken click counter. Offset by a fraction of the box, and sweep
  for the plateau rather than taking the first number that passes.
- **`[` before `]` empties the selection.** Shrink erodes anything touching air, and a blob on the
  surface is all surface.
