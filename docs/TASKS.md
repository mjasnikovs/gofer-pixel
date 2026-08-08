# The list

Every item of `docs/FEATURESET.md` that is not marked **POSTPONE**, in dependency order. Written
2026-08-07, after the proof of concept.

This supersedes the do-not-build list in `docs/POC_PROMPT.md`, which existed because none of those
things proved anything about the architecture. They are the product. What stays postponed is what
`FEATURESET.md` itself postpones: lighting and materials (20 except emissive, 21, 22), animation
(24–27), scene graph and instances (11, 23, and the hierarchy halves of 8 and 28), the command
palette (29), the radial menu (30), the stamp library (35) and the project browser (36).

Each item ends with `bun run check` green. Nothing waits — see `CLAUDE.md`.

| #   | Task                                           | FEATURESET     | State |
| --- | ---------------------------------------------- | -------------- | ----- |
| 1   | Voxel edits + undo history                     | 3, 32          | done  |
| 2   | Screen → voxel picking                         | 4              | done  |
| 3   | Draw / erase / paint / fill / pick, wired      | 3, 4           | done  |
| 4   | Selection model                                | 31, 3          | done  |
| 5   | Voxel-safe transforms and symmetry             | 9, 10          | done  |
| 6   | Move, extrude and mirror tools                 | 3, 4           | done  |
| 7   | 2D drawing inside 3D                           | 5              | done  |
| 8   | Objects instead of one volume, focus/isolate   | 8, 28, 1       | done  |
| 9   | Slice mode                                     | 6              | done  |
| 10  | Palette-first workflow                         | 7              | done  |
| 11  | The remaining output maps, emissive            | 18, 20         | done  |
| 12  | Normal-map diagnostic preview                  | 19             | done  |
| 13  | Camera generators, pixel-perfect, live preview | 13, 14, 15     | done  |
| 14  | Sheet workspace and export                     | 16, 17, 37, 38 | done  |
| 15  | Reference images and PNG import                | 33, 34         | done  |
| 16  | Autosave, crash recovery, snapshots            | 32             | done  |

All sixteen are built. Item 11 was taken out of order because 12, 13 and 14 all read the maps it
adds and it is the one that touches the two-backend parity contract, so it was better closed early
than late.

Item 8 was the one expected to reshape the renderer, and it did not. An object turned out to be a
_named set of cells of the one world grid_, tracked in `Volume.owner`, rather than a grid of its own
at an offset — so every tool, transform, selection and symmetry plane already written kept working
in world coordinates, and the renderer never learned what an object is. What that gives up is two
objects sharing a cell, which a voxel grid could not hold anyway.

## The objects panel, reworked 2026-08-08

Item 8 shipped a panel that was reasoned about rather than driven, and five things were wrong. Four
were found by putting a real mouse on it, per `docs/VALIDATE.md`; the fifth was found by looking at
the mockup again.

1. **Undo did not undo a delete.** The `remove` case recorded only the voxel diff, so Ctrl-Z put the
   cells back owned by an id that was no longer on the list — invisible to hide, lock and solo, and
   silently adopted by the next object added, because ids are reused. `Edit` now carries the object
   list either side of it and `undo`/`redo` hand it back. Deleting an _empty_ object was not
   recorded at all; `NO_CELLS` is the edit that says the list changed and the grid did not.
2. **Delete asked nothing and said nothing.** It is an `AlertDialog` naming the object and its voxel
   count — the same debt the drag hint pays with `lossCount`.
3. **Duplicate did not exist**, though `FEATURESET.md` §8 asks for it. A copy cannot sit on its
   original, because one cell has one owner, so it stands beside it — see `duplicateOffset`. When
   nothing fits, and the opening `car.vox` is one such object, the button says so on hover.
4. **Reorder did not exist either**, though `moveObject` and the `reorder` op had been written and
   tested. Nothing dispatched them. Rows drag now.
5. **The panel had been built against the wrong page.** `docs/editor.png` draws no object list, and
   the panel's comment concluded the mockups were silent. Panel 4 of `docs/featureset.png` draws
   one: eye, name, `…`. The always-open search box and the separate rename field are gone, and
   rename happens on the row.

The `…` is the one place this departs from the mockup, and it was built first and then taken out. A
menu costs a click and a read before anything happens, and it hides state — whether an object is
soloed or locked is a fact about the row, and a fact behind a menu is a fact nobody has. Every
switch is a lit button on the row instead: eye, solo, lock, duplicate, delete. Rename stays a
double-click on the name, because there is nothing to show and a sixth button would be noise.

Search survives behind `SEARCH_FROM`, because a filter over the one object a fresh `.vox` file has
is the empty room `FEATURESET.md` §29 rejects for the command palette. The voxel count is the other
addition the mockup does not draw.

`browser/objects.spec.ts` is the record. Every failure above is a test in it.

Items 2, 39 and 40 are not tasks. They are the rules the other sixteen are judged by: everything on
integer coordinates, nearest everywhere, the preview is the export, and the beginner sees six
controls.

## The two decisions this list forced

**Slice mode (9)** was recorded as open in `docs/techstack.md` §4.3 — `FEATURESET.md` §6 wants it
and neither mockup has a trace of it. Answered by having built the plane lock first, as intended:
slice mode is not a second editing mode, it is the plane lock plus a layer and a clip. §6 asks for
the surrounding layers _ghosted_; they are **hidden** instead, because ghosting means alpha in the
raycaster — a change to the algorithm two backends agree on byte for byte — in exchange for scenery
the artist still cannot click through. The reasoning is written at the top of `src/doc/slice.ts`.

**Palette-aware quantisation** (`techstack.md` §4.1) is not on this list at all. It belongs to
`FEATURESET.md` §22, which is postponed, and the renderer's output stage should not be reshaped for
a feature that is not being built.
