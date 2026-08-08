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
| 17  | Save, open and new project files               | 32, 36         | done  |

All seventeen are built. Item 11 was taken out of order because 12, 13 and 14 all read the maps it
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

## Files, added 2026-08-08

Item 16 gave the document a way to be written down, and put it in `localStorage`. Item 17 puts it on
a disk. Three things were missing and all three are now built: a file, a new document, and a name
the app can change.

**The extension is `.gpix`** and the file is the same JSON `saveDocument` already produced —
uncompressed, greppable, one format between a snapshot and a saved file so the two cannot drift.
`.gpx` was not available: it is GPS Exchange Format and Guitar Pro 6. Measured while deciding:
`car.vox` saves as 4.6 KB, and a busy 64³ model — 113 000 voxels, 40 colours — as 486 KB. Fine on a
disk. Half a `localStorage` budget, which is a separate problem noted below.

**The format is at version 2.** It gained reference art, draw-time symmetry and the export settings.
Version 1 is still read, with those three at defaults, because refusing it would throw away the
crash recovery of anyone upgrading mid-session — the one moment §32 exists for.

**The disk is a port**, `src/doc/files.ts`, shaped exactly like `src/doc/store.ts` and for the same
reason. Chrome and Edge get the File System Access API, so Save writes back over the open file with
no dialog. Firefox has recorded its position on that spec as "harmful" and Safari has never shipped
it, so both get an anchor download — and the menu says `Save a copy` rather than `Save` when that is
what it is going to do. A control that lies while working is worse than one that is greyed out.

**New offers `FEATURESET.md` §36's templates** — Character, Character (large), Isometric tile, Prop,
Diorama — plus a custom X/Y/Z clamped to 256, which is MagicaVoxel's own ceiling. It is a dialog
rather than one default size because the grid cannot be resized afterwards.

Two things were found by building this rather than reasoned about:

1. **Reference images could never have been saved.** `Reference.url` was a `blob:` object URL — a
   handle into the page's memory, dead on the next reload — while the comment above it had said
   `data:` since the day it was written. They are data URLs now.
2. **`open` kept the current document's references and presets.** That was right when a snapshot
   restore inside one session was the only caller, and wrong the moment a second project could be
   opened: it would put one project's reference art over another project's model.

Two more were found by round-tripping a document rather than by reading the reducer, and both only
appear on the _second_ session with a file:

3. **Reopening a document minted a camera id it already had.** `serial` was not saved, so a file
   with `Camera 1` and `Camera 2` on it started counting from zero again and the next capture was a
   second `cam-1`. Ids are how a camera is selected, renamed, reordered and deleted, so the
   duplicate did not fail — it acted on the wrong camera. `lastSerial` reads the counter off the
   ids, which is right for files written before anyone thought about it.
4. **A recovered snapshot opened claiming to be saved.** Autosave writes one per committed edit, so
   a snapshot is by definition work no file holds — and the recovery handed it back clean, with no
   `beforeunload` guard behind it. Closing the tab would have lost exactly what the recovery had
   just returned. `OpenedDocument.unsaved` is the difference between a `.gpix` and a snapshot.

**Dirty is a comparison, not a list of actions.** `DOCUMENT_FIELDS` in `state.ts` names the fields
the format carries, and the document is unsaved when one of them changes. An action list was written
first and thrown away: it has to be right about fifty cases and about which of them are no-ops —
`pointer` fires on every mouse-move and changes the model on perhaps one in a hundred — and a case
that got it wrong would tell an artist their work was safe when it was not.

**What is deliberately not in the file**, having been checked one by one: the current tool, brush,
colour, the recent-colours row, the palette lock, grid/edges/snap/invert, the selection, the
clipboard, the undo history, the plane lock, slice mode, the preview size, which camera is selected
and where the view is pointing. They describe the half-hour you were having. What _is_ in it, also
checked: every palette entry and emissive value, every object with its name, hidden, locked, solo
and active flags, every camera, the reference art, the symmetry planes and the export settings.

Note that `hidden` and `solo` travel with the document, so a project saved while an object was
soloed reopens showing only that object — and the sheet bakes what is shown. That is intended; it is
how one piece of a model gets rendered on its own.

**Not in this, and worth writing down.** Resizing an existing document; writing `.vox`, which would
mean re-deriving MagicaVoxel's RIFF chunks to export a model this app is not the source of truth
for; the §36 project browser, still postponed. And **snapshots are not compressed**: 486 KB of JSON
for a busy 64³ model, five of them, against a five-megabyte `localStorage`. Gzip through
`CompressionStream` takes that to 15 KB, measured. It is a real problem and it is not this one.
Reference art makes it worse now that it is base64 in the document: three 45 KB PNGs take a snapshot
from 5.7 KB to 186 KB, so five of them are 0.9 MB, measured. `browserStore.set` swallows a quota
failure by design, so the way this fails is that autosave quietly stops.

Two more left alone on purpose. The snapshot ring is **one ring for every document**, so a reload
recovers the newest snapshot whichever project it came from; and `savedAt` is not in the format, so
a recovered document does not know when its file was last written. Both are only visible across
sessions and neither loses anything.

**Coverage.** `save.ts`, `templates.ts` and `reference.ts` are at 100 % of lines and functions.
`files.ts` is at 95 % of functions and 86 % of lines; the ten uncovered are `inputOpen`, the
`<input type=file>` fallback, which needs a real picker to hand it a real file. Everything else in
`browserFiles` — which handle is held, whether a cancel is silent, whether a `.vox` can ever become
the file Save writes back to — is driven in `bun test` against a stubbed `showSaveFilePicker` on
`globalThis`. That was worth doing: the first pass tested only `memoryFiles` and left the whole
browser half at 19 % of lines, including `projectName`, which is the one function standing between
Save and somebody's `.vox`.

`browser/files.spec.ts` is three tests, and they are the three things only a browser shows: the menu
is a portal, so nothing about it is provable from a reducer; a Save the artist backs out of must not
report success, which headless Chromium gives for free because a native picker has no automation
surface; and the guard in front of New. What the picker writes when it is not cancelled is
`src/doc/files.test.ts`'s job, against `memoryFiles`.

One thing outside `src/` had to change with it. `vite.config.ts` now lists every astryx entrypoint
in `optimizeDeps.include`. Vite discovers a subpath it has not pre-bundled _while the page loads_,
optimizes it, and full-reloads — which lands between `page.goto` returning and the browser suite
reading `window.goferPixel`. It failed only on a cold `node_modules/.vite`, which is exactly when
nobody is looking. Listing them is the fix; making the suite wait for the handle would hide a real
boot failure behind a timeout.

## Local AI, carried back 2026-08-08

Not one of the seventeen, and not in `FEATURESET.md` or either mockup. It is the one subsystem the
rebuild dropped that was worth having back: `legacy/src/gen/` and `legacy/py/`, re-derived against
the raycaster.

**The pipeline is unchanged and its findings still stand** — the model emits primitives, code
rasterises them, CLIP ranks candidates of one prompt. What changed is that **the second rasteriser
is gone.** Legacy posted the op list to Python, rasterised it again there with `voxgen.rasterise`
and rendered it again with the sprite stacker; the score was therefore of a picture the artist never
saw, and two rasterisers had to stay byte-identical. `py/clipserve.py` takes base64 PNGs and does
nothing but CLIP. Confirmed byte-faithful: scoring six candidates through the service returned the
same six numbers to four decimals as scoring the files on disk directly.

**Measured while building it**, all 2026-08-08 on this machine:

| Thing                                                | Number                                    |
| ---------------------------------------------------- | ----------------------------------------- |
| One candidate, grammar-constrained, 27B on both GPUs | 7–20 s, 424 completion tokens for 12 ops  |
| Four ranking views per candidate, CPU raycaster      | 14 ms                                     |
| CLIP over four 64 px views                           | ~0.2 s, plus 4.6 s to load the model once |
| Whole flow in Chromium, two candidates               | 13.2 s                                    |

**Three things were changed rather than copied.**

1. **`overallScore` had the wrong sign on fill.** Of six candidates for "a stone tower", three came
   back as `bboxFill = 1.0` — a solid block filling its grid — and every other deterministic score
   on them was also exactly 1.000. The legacy weighting rewarded fill, so it sorted the three
   shapeless bricks to the top. The term is `1 - bboxFill` now: a model that fills its own bounding
   box has no silhouette, and connectivity is what stops that rewarding a cloud of debris. With the
   sign fixed it picks the same winner CLIP does.
2. **`paletteCompliance` is dropped.** It scored a model against an allowed palette, and there is
   nothing in this build that can supply one: a generated model brings its own palette and replaces
   the document. A scorer nobody can call is dead weight.
3. **One seed per candidate.** `generateMany` uses `seed + i`. Legacy passed one options object to N
   calls, so a caller that pinned a seed got one candidate rendered N times.

**The record travels in the file.** `origin` — prompt, temperature, seed, model, timestamp — is
format **version 3**. A generated asset whose seed was not written down cannot be reproduced or
nudged, only regenerated and hoped over. Versions 1 and 2 still open, with no origin, which is not a
gap: it means nobody recorded one.

**Where it lives.** A dialog behind the main menu, not a panel. `docs/editor.png` budgets every
pixel of the window and generation is not something an artist does _while_ they draw. Picking a
candidate replaces the open document, so it is behind the same unsaved-work guard as New and Open —
asked before the minute is spent rather than after it.

**Coverage.** `ops.ts`, `score.ts` and `views.ts` are at 100 % of lines and functions; `llama.ts`,
`clip.ts` and `GenerateDialog.tsx` are at 98.8–99.6 % of lines. Two functions are uncovered by
`bun test` and both on purpose: the 1500 ms abort behind `clip.ts`'s health probe, which cannot be
reached without containing a duration, and the dialog's Escape handler, which is covered in the
browser suite instead. Everything else is driven against stubbed ports — a server that answers 503,
a reply the grammar did not constrain, a candidate that rasterises to nothing, a cancel mid-batch
that keeps what had already landed, and a scorer that throws.

`browser/generate.spec.ts` is four tests, and they are what only a browser shows: the menu is a
portal and the dialog is a `<dialog>`; the candidate thumbnails are real canvases, which under
happy-dom render as empty elements that pass anyway; the endpoints are `fetch` calls the page makes
on its own; and Escape has to close a modal.

**Two async leaks were found by writing these, and one of them was already there.**

1. **A batch outlives the click that started it.** Encoding a candidate's ranking views goes through
   a `CompressionStream`, which settles on the macrotask queue, so a test that only clicked Generate
   left work running into an unmounted tree — and broke the _next_ test file about one run in two.
   `GenerateDialog` hands its in-flight batch out through `onRunning`, the same seam `Viewport`
   opens with `renderNow()`: the loop has to be drivable, not owned by the click.
2. **Export's own PNGs could land after the test that made them.** `App.test.tsx`'s download test
   cleared its capture array and then counted every `.png` in it, and the sheet's two files —
   written from an effect, through the same `CompressionStream` — sometimes arrived after the clear
   and made 8 sprites read as 10. It predates this work and only fired once there were more test
   files queued behind it. The count names the sprite files now rather than counting whatever PNG
   turns up.

**Deliberately not carried over:** `evolve.ts`, which optimises reliably against an objective that
makes the sprite worse — CLIP under optimisation pressure tore the mushroom's cap apart for +0.03,
connectivity 1.00 → 0.72. And the code-metric scorer and spec check in `legacy/experiments/`, which
failed to discriminate at all.

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
