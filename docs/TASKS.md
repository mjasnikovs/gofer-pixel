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
