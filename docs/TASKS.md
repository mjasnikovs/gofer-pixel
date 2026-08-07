# The list

Every item of `docs/FEATURESET.md` that is not marked **POSTPONE**, in dependency order. Written
2026-08-07, after the proof of concept.

This supersedes the do-not-build list in `docs/POC_PROMPT.md`, which existed because none of those
things proved anything about the architecture. They are the product. What stays postponed is what
`FEATURESET.md` itself postpones: lighting and materials (20 except emissive, 21, 22), animation
(24–27), scene graph and instances (11, 23, and the hierarchy halves of 8 and 28), the command
palette (29), the radial menu (30), the stamp library (35) and the project browser (36).

Each item ends with `bun run check` green. Nothing waits — see `CLAUDE.md`.

| #   | Task                                           | FEATURESET     |
| --- | ---------------------------------------------- | -------------- |
| 1   | Voxel edits + undo history                     | 3, 32          |
| 2   | Screen → voxel picking                         | 4              |
| 3   | Draw / erase / paint / fill / pick, wired      | 3, 4           |
| 4   | Selection model                                | 31, 3          |
| 5   | Voxel-safe transforms and symmetry             | 9, 10          |
| 6   | Move, extrude and mirror tools                 | 3, 4           |
| 7   | 2D drawing inside 3D                           | 5              |
| 8   | Objects instead of one volume, focus/isolate   | 8, 28, 1       |
| 9   | Slice mode                                     | 6              |
| 10  | Palette-first workflow                         | 7              |
| 11  | The remaining output maps, emissive            | 18, 20         |
| 12  | Normal-map diagnostic preview                  | 19             |
| 13  | Camera generators, pixel-perfect, live preview | 13, 14, 15     |
| 14  | Sheet workspace and export                     | 16, 17, 37, 38 |
| 15  | Reference images and PNG import                | 33, 34         |
| 16  | Autosave, crash recovery, snapshots            | 32             |

Items 2, 39 and 40 are not tasks. They are the rules the other sixteen are judged by: everything on
integer coordinates, nearest everywhere, the preview is the export, and the beginner sees six
controls.

## The two decisions this list forces

**Slice mode (9)** is recorded as open in `docs/techstack.md` §4.3 — `FEATURESET.md` §6 wants it and
neither mockup has a trace of it. It stays last of the editing tasks so that the answer comes from
having used the plane lock in task 7, not from arguing about it now.

**Palette-aware quantisation** (`techstack.md` §4.1) is not on this list at all. It belongs to
`FEATURESET.md` §22, which is postponed, and the renderer's output stage should not be reshaped for
a feature that is not being built.
