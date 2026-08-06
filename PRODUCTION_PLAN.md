# gofer-pixel — Production Plan

Target: a local-only sprite-stacking studio. Voxel authoring, palette work, AI-assisted generation,
animation, and engine-ready export, with no network dependency beyond the llama-server already
running on `localhost:8080`.

This plan is written against measured facts. Where a claim comes from research it is linked; where
it comes from this repo it names the file; where it is unverified it says so.

---

## 1. What already exists

`DESIGN_PROGRESS.md` is the record of the feasibility work. The parts that matter here:

- The model emits voxel primitives as JSON, code rasterises them, CLIP ranks N candidates, the
  winner is exported. Runs end to end via `voxbatch.py`.
- The model cannot draw pixels as text and cannot judge its own renders. Both are settled.
- Everything downstream of the voxel volume is exact: slices are registered by construction, normals
  are read off the surface, rotation is hole-free while slice lift ≤ pixel scale.
- The deterministic half is now TypeScript (`src/vox/`, `src/image/`) and pixel-identical to the
  Python, pinned by hash in `src/vox/parity.test.ts`.

So the renderer is done and trustworthy.

**Status, 2026-08-06: M0 through M6 are done.** The editor exists (slice mode, 3D mode, palette,
frames and tags), generation runs in-app against the live server, export produces sheets, sidecars,
strips and a Godot package the engine has actually opened, animation has both tiers, and the effects
and scripting surfaces are in. Each milestone below carries what was built and what was deliberately
left out; §14 is still the honest list of what is not settled.

---

## 2. Hard constraints, measured

| Constraint | Value                                     | Consequence                              |
| ---------- | ----------------------------------------- | ---------------------------------------- |
| GPU 0      | RTX 4070 SUPER, 11.8 / 12.3 GB used       | No headroom                              |
| GPU 1      | RTX 5070 Ti, 15.0 / 16.3 GB used          | No headroom                              |
| LLM        | Qwen3.6-27B, vision in, 120k ctx, 2 slots | Split across both cards; cannot be moved |
| CPU / RAM  | 16 cores, 31 GB                           | This is the budget for everything else   |

Both cards are ~95 % full with the LLM. **Nothing else gets meaningful VRAM.** CLIP stays on CPU. A
diffusion model is not an option while the LLM is loaded. This single fact removes several
otherwise-attractive designs, and it is why the plan leans on exact code rather than on more models.

---

## 3. The one architectural decision that shapes everything

**The CPU renderer is the source of truth. The GPU is an optional accelerator, never a dependency.**

The reason is specific, not stylistic. Tauri renders through WebKitGTK on Linux, and Tauri's own
documentation says WebGL contexts there may silently fall back to software with no error to catch,
with NVIDIA the worst case — the recommended fix list ends at disabling hardware compositing
entirely, and the docs tell you to provide non-WebGL fallbacks
([Tauri Linux graphics](https://v2.tauri.app/develop/debug/linux-graphics/)). gofer is a Tauri app
on an NVIDIA box, so a GPU-dependent editor would be betting the product on the one path the vendor
warns about.

**Measured 2026-08-06, and the warning did not fire here:** WebGL2 in the `tao`/`wry` webview Tauri
builds its Linux window from runs on the NVIDIA GPU on this box, 735× faster than the same page on
SwiftShader — details and the two surprises in §14. That lowers the risk; it does not change the
decision, because the renderer still has to run in a Worker, in Bun and in CI, and because one
machine is not the fleet. It does mean a GPU viewport path is worth building when volumes outgrow
the CPU, rather than being written off.

The CPU path is already written, already exact, and already hash-tested. A 32³ model at 16 angles is
small work. Rendering stays correct everywhere, is testable by checksum, and runs identically in a
Worker, in Node, in Bun, and in CI — **the Worker half of that is now run rather than asserted**
(`src/vox/render-worker.ts`, §14). GPU acceleration can be added later for large-volume 3D viewport
work and will be a pure speedup with a fallback that is known good.

Everything below assumes this.

### Open decision — where the UI lives

**The technical risk in this decision is gone, measured 2026-08-07.** The editor itself was loaded
into the `tao`/`wry` WebKitGTK window — the real one, not a lookalike — and it works: every platform
API it leans on passed (`structuredClone` of a `Map`, `Object.hasOwn`,
`CompressionStream`/`DecompressionStream`, `crypto.subtle`, module `Worker`s, canvas
`getImageData`), all six modes mounted, 36 canvases rendered, **zero errors**. Then the real
pipeline ran in that window: an atlas baked **in the Worker** in 15 ms, and its albedo sheet hashed
to `d1380538fd943879` — _the same hash Chromium produced for the same document_. PNG encode/decode,
palette import/export and the layered `.vox` round trip all passed there too.

Caveats worth keeping: that was the vite dev server rather than a production bundle, and it is one
machine running WebKitGTK 2.52.5 (`Version/60.5 Safari/605.1.15`). What it removes is the fear that
option 1 needs a compatibility programme before it can start.

**Left open deliberately, 2026-08-07.** With the technical risk removed there is no longer a reason
to decide early, and the core library is identical in all three cases, so nothing blocks. A future
milestone picks this up when there is a reason to prefer one — file access, or the gofer
integration, or neither.

1. **Standalone Tauri app**, mirroring gofer's stack exactly. Best fit for file access and for
   sitting next to gofer.
2. **Panel inside gofer**, since gofer already drives Godot 4.7 and this produces Godot assets.
   Highest end-to-end value, tightest coupling.
3. **Browser app**. WebGPU is Baseline as of January 2026 with ~85 % support
   ([WebGPU 2026](https://webo360solutions.com/blog/webgpu-browser-support/)), so this is the only
   option where GPU work is reliable — but it loses easy filesystem access and the gofer
   integration.

Recommendation: build the core as a headless library with a React UI layer that runs in all three,
ship (1) first, fold into (2) once it is proven.

---

## 4. Document model

This is the foundation. Get it wrong and undo, layers, and animation all become painful.

### Volume storage — copy-on-write chunks

Adopt Goxel's structure, which is proven in a shipping editor with unlimited undo: 16³ voxel blocks,
reference-counted, copy-on-write, so duplicating a volume is nearly free and a block's data is only
cloned when it is written
([Goxel internals](https://github.com/guillaumechereau/goxel/blob/master/INTERNALS.md)).

In TypeScript:

```
Chunk      = { data: Uint8Array(16³), refs: number }
Volume     = { chunks: Map<packedChunkCoord, Chunk>, bounds }
Layer      = { volume: Volume, name, visible, locked, opacity, offset }
Frame      = index into per-layer cels
Cel        = { layer, frame, volume }        // Aseprite's model
Document   = { layers[], frames, tags[], palette, size, meta }
```

The layer/frame/cel split is Aseprite's and is worth copying wholesale — layers give spatial
organisation, frames give temporal, and a cel is the content at one intersection
([Aseprite doc model](https://deepwiki.com/aseprite/aseprite/4.3-cels-and-images)). Tags name frame
ranges (`walk`, `idle`) and become animation clips on export.

`src/vox/grid.ts` (the current dense `Vox`) stays as the authoring primitive for generated models
and tests; it becomes a cheap conversion into a `Volume`.

### Undo / redo — snapshots, not commands

The usual advice is that command objects beat snapshots on memory. With copy-on-write chunks that
advice inverts: Goxel keeps a full layer snapshot at every change and it costs almost nothing,
because unchanged blocks are shared references. That buys unlimited undo with no per-operation
inverse code to write and no chance of an inverse being subtly wrong — which is where command-based
undo actually fails in practice.

Rules:

- Snapshot on commit, not on every mouse move. A drag coalesces into one entry.
- Undo entries carry a label and a selection/viewport restore.
- Cap by memory, not by count; evict oldest.
- Palette edits, layer reorders, and canvas resizes go through the same stack. Nothing mutates the
  document outside it.

---

## 5. Editor — 2D slice mode

This is the mode the technique is named for: you draw a model slice by slice, and the stack of 2D
layers is the 3D volume. It is how SpriteStack works and it is what a 2D artist expects
([SpriteStack](https://spritestack.io/)).

- Slice strip along the side, current slice large in the middle, onion-skin of the slice below and
  above at reduced opacity.
- Live stacked preview beside the canvas, updating per stroke.
- Tools: pencil, line, rectangle, ellipse, fill, eyedropper, rectangular/lasso select, move,
  mirror-x/y toggles.
- Copy a slice up or down; insert, delete, duplicate, reorder slices.
- Per-slice offset — this is what makes leaning and tapered shapes possible without 3D editing.

---

## 6. Editor — 3D voxel mode

Quad viewport, the Blender/Unreal convention: top, front, side orthographic plus one perspective
view, resizable from the shared centre
([Blender contextual views](https://docs.blender.org/manual/en/latest/editors/3dview/navigate/views.html)).
Avoyd adds isometric presets on the orthographic camera, which is worth having because the output is
isometric-adjacent.

Brush model from MagicaVoxel, which is the vocabulary voxel artists already know
([brush panel](<https://magicavoxel.fandom.com/wiki/Brush_panel_(interface)>)):

- Brush shapes: voxel, face, box, line, centre, pattern.
- Modes: attach, erase, paint.
- Mirror and axis-lock modes on every brush.
- Box select, region select, pick colour, remove colour, replace colour.

Plus, specific to this project: **slice lock** — restrict any 3D operation to the active z slice, so
the two modes stay one document rather than two workflows.

---

## 7. Palette editor

Sprite stacking lives or dies on value contrast between slices, so the palette is not a side
feature.

Match Aseprite's palette bar, which is the accepted baseline
([Aseprite colour bar](https://www.aseprite.org/docs/tutorial/color-bar-tutorial/)):

- Sort by luminance, hue, or saturation.
- Gradient and gradient-by-hue between two selected entries.
- Shading mode: paint highlights and shadows by stepping along a ramp instead of picking colours.
- Named ramps. A ramp is a first-class object here, not just adjacent swatches, because the AI
  generator should be told to emit ramp indices rather than free hex.
- Replace colour across the whole document; merge duplicates; reduce to N colours.
- Lock the palette so generation and painting cannot introduce off-palette colours.

Import/export `.gpl` (GIMP), `.hex`, `.pal` (JASC), `.ase` (Adobe swatch), and PNG strips — the set
Lospec publishes, which is what pixel artists actually have on disk
([Lospec importing](https://lospec.com/palette-list/importing-palettes)).

Two contrast checks worth building because they are cheap and catch real problems: adjacent slices
that differ by too little in value (the stack reads as a solid blob), and any two palette entries
too close to tell apart (wasted slots).

**Calibrated 2026-08-07** (`experiments/t23_contrast.ts`), against a criterion stated so it can be
argued with: a seam is _visible_ at a 2-level 8-bit step in the render and _comfortable_ at 5. A
palette ΔL\* of 1.0 reaches 2 levels and 2.0 reaches 5, near enough regardless of base lightness
(L\* 15 to 85). So the defaults are **ΔL\* 2** for adjacent slices and a **colour distance of 1**
for duplicate entries, replacing the guessed 3 and 4 — the old duplicate threshold called colours
ten 8-bit levels apart the same colour.

---

## 8. Rendering, rotation, and "shader support"

### Angle count

Pre-bake angles rather than rotating slices at runtime. Evidence: the runtime approach used in the
GameMaker tutorials creates gaps as slice spacing grows and has to redraw each slice several times
to fill them
([advanced guide](https://medium.com/@dev_dwarf/advanced-guide-to-sprite-stacking-using-gamemaker-studio-2-5b133ae5ca64));
our renderer already has no gaps at any angle as long as lift ≤ scale, which was measured here.

Frame counts: 16 is the practical minimum for smooth rotation and 32 for large sprites, with powers
of two preferred — Starcraft shipped 16 at 22.5° increments
([gamedev.net](https://gamedev.net/forums/topic/594196-2d-sprites-how-many-directions-for-smooth-rotation/)).
Default to 16, offer 8/16/32/64. This settles open question 2 in `DESIGN_PROGRESS.md`.

**Re-derived from our own renders 2026-08-07** (`experiments/t24_angles.ts`), and the borrowed
number does not survive contact. Measuring the error a player actually sees — face a heading, get
shown the nearest baked angle, count the pixels whose coverage is wrong — gives a smooth ~1/N decay
with **no knee to point at**: on `car.vox` it is 18 % at 8 angles, 10 % at 16, 6 % at 32, 4 % at 64.
There is no threshold where 16 becomes "enough"; there is a continuum you pick a point on.

Worse for a single default, **the cost of a step depends on the model**. At 16 angles a
near-symmetric blob changes 7 % of its silhouette between adjacent frames; `truck.vox` changes 35 %.
A sprite stack turns differently from a pre-rendered sprite, which is exactly the reason §14 gave
for distrusting the borrowed evidence, and it turns out to matter.

So the count is now **measured per model**: `angleAdvice` in `src/export/angles.ts`, behind a
"suggest" button in the export panel. Under a default target of 8 % mean error it asks for 32 on
`car.vox` and `truck.vox` and 16 on `fork1.vox`. 16 stays the default in the UI because it is a
reasonable middle and doubling costs sheet area, but it is now a starting point rather than a claim.

**And the axis-aligned sub-question is answered: bake them.** At 0/90/180/270 the faces line up with
the pixel grid and the sprite is genuinely thinner — 3 % less coverage on `car.vox`, 14 % on
`fork1.vox`. That is a real residual asymmetry, not the ~45 % striping defect fixed in M0. But
offsetting the whole set by half a step to dodge those headings was measured and made the mean error
**worse** on three models of four (+3.8 %, +5.7 %, +10.5 %; −0.6 % on the fourth), because a thin
silhouette you never baked is one you can never show.

### "Shader support" is three different asks

1. **Preview render effects** — outline, palette cycling, dithering, ambient occlusion, Lambert
   lighting from the exact normal map. All of these are per-pixel passes over an RGBA buffer, all
   run fine on CPU at sprite sizes, and `light()` in `src/vox/render.ts` is already one of them.
   **Build these first, on CPU, as a pass pipeline.**
2. **Procedural voxel shaders** — MagicaVoxel's `xs` commands are not GPU shaders at all; they are
   GLSL-syntax volume generators that add, erase, or paint voxels over a selection, used for bricks,
   noise, terrain, greebles, stairs
   ([shader collection](https://github.com/lachlanmcdonald/magicavoxel-shaders)). This is a
   scripting feature, and for this project it is the highest-value one, because it is the same
   surface the AI can drive. **Build a sandboxed TS/expression evaluator over
   `voxel(x,y,z) -> index`, not a GPU pipeline.**
3. **GPU shaders in the viewport** — only worth it once the 3D mode handles volumes large enough for
   CPU rasterisation to hurt, and only behind the fallback described in §3.

### Normal maps and lighting

Ours are exact — read off which voxel faces are exposed — where the pixel-art field generally
estimates them from height maps or from artist-shaded lighting passes (Sprite Lamp, Laigter, Sprite
Illuminator). This is a genuine advantage and should be surfaced in export, because Godot consumes a
normal map directly on a `CanvasTexture` with a `Light2D`
([GDQuest](https://www.gdquest.com/tutorial/godot/2d/lighting-with-normal-maps/)).

---

## 9. AI pipeline

Keep the shape that survived testing — model emits primitives, code rasterises, CLIP ranks
candidates of the same prompt — and fix the three weak joints.

### Fix 1 — constrained decoding instead of brace matching ✅ done 2026-08-06

`voxgen.py` now sends `response_format: {type: json_schema, …}` with `VOX_SCHEMA`, and llama-server
converts it to a GBNF grammar that constrains decoding token by token
([llama.cpp grammars](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)). The
brace-counting `parse_model` is gone; it is now `json.loads`, and a failure there means the schema
did not go out rather than that the model rambled.

Measured against the live server: the union of the three op shapes (`anyOf`) and the
`^#[0-9a-fA-F]{6}$` colour pattern both survive the grammar conversion, and 4 of 4 candidates in a
`voxbatch` run parsed with no drops. The enforcement is real, not politeness — asked "say hello in
one short sentence of plain English, do not output JSON" with the schema attached, the server could
only emit a schema-valid model (`{"name":"hello","size":[-1,0,1],…}`). The documented catch holds:
the schema is not injected into the prompt, so `SYSTEM` still has to describe the same shape in
words, and the two have to be kept in step by hand.

### Fix 2 — image-only critique ❌ run 2026-08-06, and it does not work

`experiments/t21_critique.py`. One base model per prompt, four prompts, then the same base revised
under three conditions — image only, image + numeric stats, stats only — scored by CLIP against its
own base, which is the same-prompt comparison CLIP is good for. 48 revisions in total.

The ASCIIEval ordering does not transfer. Image-only is not better than image+stats; nothing
separates at this sample size (means +0.004 / +0.006 / +0.004 CLIP, individual items swinging
±0.03). **The finding that actually matters is different: the model overwhelmingly returns its own
input unchanged.** 22 of 24 revisions were byte-identical op lists. Adding "your reply must differ
from it — change the proportions, the ops or the colours" cut that to 14 of 24 and still produced no
modality effect. Letting it answer unconstrained (so it can reason in prose first, which the grammar
otherwise forbids) changed nothing either.

So the critique loop stays out. Candidate generation plus ranking is the loop that works, and §9's
evolutionary refinement — mutating the op list in code rather than asking the model to revise — is
the direction with a reason to expect anything, precisely because it does not depend on the model
being willing to change its answer.

### Fix 3 — CLIP's limits are now externally confirmed

The finding here was that CLIP ranks within one prompt but not across subjects. Independent work
agrees and goes further: CLIP scores do not correlate monotonically with structural quality, and can
rank a broken shape above a refined one ([4-Doodle](https://arxiv.org/pdf/2510.25319),
[Hi3DEval](https://arxiv.org/html/2508.05609)). So do not build a quality gate on CLIP. Use it for
same-prompt candidate selection only, and add cheap deterministic checks it cannot do: silhouette
connectivity, slice-count usage, palette compliance, bounding-box fill, symmetry error. These are
code, they are exact, and they answer open question 4.

### Then — evolutionary refinement ❌ built and run 2026-08-07; the loop works, the objective does not

`src/gen/evolve.ts` and `experiments/t22_evolve.ts`. Generate N → score → keep top K → mutate the
ops (jitter a coordinate, resize, duplicate, drop, recolour) → repeat, seeded so a run repeats
exactly. Mechanically it does everything it promised: 20 generations of 8 is 168 scorings in about
30 seconds and **zero LLM calls**, and it climbs reliably — CLIP rose on every prompt tried (+0.021,
+0.030, +0.046 across a tower, a mushroom and a barrel).

**And the sprites did not get better.** The renders are in `out/evolve/`. The tower is
indistinguishable before and after. The barrel got mottled. The mushroom — which started as a clean
red cap on a stem — came out with the cap **torn into pieces**, its connectivity falling from 1.00
to 0.72 while CLIP went up by 0.03. That is §9 fix 3's warning happening here rather than in a
citation: CLIP does not track structural quality, so a search that maximises it walks straight into
the gap between the two.

So the loop is not blocked on the loop. It is blocked on **having an objective worth maximising**,
and today neither candidate qualifies: CLIP rewards damage under optimisation pressure, and the
deterministic score saturates (§14). The code stays because it is tested and it is the right harness
the day a better scorer exists — a learned one, or a person ranking pairs — but nothing in the app
calls it, and it should not be wired into the generate panel as it stands.

### Out of scope, with reason

Local diffusion with a pixel-art LoRA is the mainstream 2026 route to sprites
([comparison](https://www.apatero.com/blog/ai-game-art-generator-sprites-textures-2026)) but it is
wrong for this project twice over: there is no VRAM while the LLM is loaded, and a 2D image gives no
registered slices, no volume, and no exact normals. Text-to-3D (TRELLIS, Hunyuan3D) produces
voxel-structured latents and could in principle be voxelised, but the same VRAM wall applies.
Revisit only if the LLM is unloaded.

---

## 10. Animation

The honest position from `DESIGN_PROGRESS.md`: this is the hard part, because a walk cycle means
deforming the volume over time, not tweening sprites.

Two tiers, in order:

1. **Per-frame volumes with tags.** Cel model from §4, onion skin, copy-frame-and-edit. Crude,
   works, ships. This is what most voxel animation tools do.
2. **Grid-constrained bones.** A rig where bones move voxels in whole-voxel steps so the grid look
   survives — AniVoxel demonstrates this is viable, with bone mirroring and per-frame visibility.
   SpriteStack interpolates between keyframes so the artist can export as many final frames as the
   game needs, which is the right output model.

Export multiplies: frames × angles. A 16-angle, 8-frame walk is 128 sprites, which is why the atlas
packer in §11 is not optional.

---

## 11. Export

Formats, in priority order:

- **Spritesheet + matching normal-map sheet**, angles across, frames down, with a JSON sidecar.
  Sidecar carries frame rects, pivot per frame, trim offsets, angle and frame indices, tag ranges,
  and the palette. Power-of-two option and tight trim with restored offsets are the established
  conventions across packing tools.
- **`.vox`**, both directions. ✅ **Done 2026-08-07 for the scene graph and layers.**
  `src/vox/vox-scene.ts` writes `nTRN`/`nGRP`/`nSHP` and `LAYR`, so a multi-layer frame exports as
  one model per layer with its name and visibility, and reads back the same way — the editor's
  import turns a multi-model file into a multi-layer document instead of flattening it. Written from
  the raw
  [extension spec](https://github.com/ephtracy/voxel-model/blob/master/MagicaVoxel-file-format-vox-extension.txt)
  rather than a summary, as §14 asked. `MATL` and `NOTE` are still absent: materials mean nothing to
  a flat-shaded sprite stack, and `NOTE` names palette entries, which our project file already
  carries. The single-model `writeVox` stays, byte-identical to `voxgen.py`.
- **Slice strips**, for round-tripping through Aseprite.
- **Godot 4.7 package** — the highest-value target, because gofer already drives a Godot editor
  session. Emit `AtlasTexture` regions, a `CanvasTexture` pairing albedo with the exact normal map,
  `SpriteFrames` for tagged animations, and a `.tres` per asset.
- **`.gpl` / `.hex` / `.pal` / `.ase`** palettes, as in §7.

---

## 12. Milestones

Each one ends with something usable.

**M0 — spikes and the striping fix.** ✅ **Complete 2026-08-06.** Striping fixed (§14) and hashes
regenerated; WebGL2 measured as hardware in the `tao`/`wry` stack Tauri uses, 735× SwiftShader
(§14); `response_format` JSON-schema decoding replaced the regex parser and is enforced server-side
(§9 fix 1); the image-only critique was run across three modalities and does not work (§9 fix 2).

**M1 — the editor exists.** Document model with COW chunks, undo/redo, 2D slice mode, palette
editor, `.vox` read/write, live stacked preview, project save/load. A person can make a sprite stack
by hand and export a sheet. Everything after this is addition, not rework.

✅ **Done 2026-08-06.** Done: `src/doc/volume.ts` (COW chunks), `document.ts` (layers, frames, cels,
tags, ramps, composite, `frameToModel`/`frameToVox` into the existing renderer), `history.ts`
(snapshot undo/redo, entry cap plus a shared-chunk-aware byte cap), `tools.ts` (pencil, line, rect,
ellipse, flood fill, replace, copy-slice, mirror, all mirror-aware), `serialize.ts` (RLE + base64
project file, versioned), `palette.ts` (L\* and HSV, gradients, sorting that reindexes voxels and
ramps together, usage counts, merge, the two contrast checks), `palette-formats.ts` (`.gpl`, `.hex`,
`.pal`, PNG strips), and a `.vox` writer byte-identical to `voxgen.py`. `selection.ts` (rectangle,
lasso, wand, boolean combines, clipboard, move), and `src/editor/` — the 2D slice mode itself: slice
strip, onion skin, twelve tools, mirror, palette bar, layer list, live stacked preview and lit
rotation sheet, keyboard shortcuts, `.json` save and `.vox` export. Driven in a real browser end to
end (draw, undo, redo, second slice, mirror, export) with no console errors.

The three items that were still owed are now in: **import** (`src/editor/files.ts` sniffs a `.vox`
by magic bytes rather than by extension, plus a file picker and drop anywhere in the editor, both
driven in Chromium); **the frame bar** (frames across, add / duplicate / delete, tags underneath
with rename, range editing and a coverage lane — `updateTag`/`tagsAt`/`uniqueTagName` in
`document.ts`); and **the palette panel** (`src/editor/PalettePanel.tsx` — sort by luminance/hue/
saturation, gradient and gradient-by-hue between two picked swatches, named ramps, merge duplicates,
both contrast checks, and `.gpl`/`.hex`/`.pal`/PNG-strip import and export). PNG strip import needed
a decoder, so `src/image/png.ts` gained `decodePng` — non-interlaced, colour types 0/2/3/4/6, depth
8 plus sub-byte indexed, tested against Pillow-written fixtures because our own encoder only ever
writes filter 0.

One bug fell out of the frame work and is fixed: `removeFrame`, `removeLayer`, `moveLayer` and
`copySliceTo` in `useEditor` called `mutate` then `navigate`, and `navigate` spreads the snapshot
captured when the handler was built — so the document change was silently thrown away. They now go
through a single `mutateAndGo` commit.

**M2 — 3D mode.** ✅ **Done 2026-08-06.** Quad viewports, 3D brushes, selection, mirror, slice lock.

`src/editor/view3d.ts` is the geometry: a view is a mapping from volume axes to screen axes plus a
depth order, and every question the mode asks — what did I click, where does a new voxel go — is one
walk along a sorted ray, so there is no depth buffer and no comparison to get wrong. `brush3d.ts`
has the MagicaVoxel vocabulary (voxel, face, box, line, centre × attach, erase, paint) with mirror,
axis lock and slice lock; `select3d.ts` has box and region select and the three colour operations.
`Viewport3D.tsx` is top, front and side at one pixel per voxel plus the lit rotation sheet in place
of a perspective camera — three small CPU renders per edit, no GPU path (§3).

Two decisions worth knowing. Region select walks the six face neighbours, not the twenty-six: blocks
touching at a corner read as two shapes, and treating them as one is how a region select ends up
swallowing the model. Paint refuses to create geometry — it only recolours voxels that exist —
because a paint stroke that quietly adds voxels is a bug you find three edits later.

One bug found while driving it: `editCel` returns a new document whether or not the edit wrote
anything, so identity comparison put empty entries on the undo stack for every click on empty space.
The 3D path now commits on the brush's changed count.

**M3 — generation in-app.** ✅ **Done 2026-08-06,** with one deliberate gap. The `voxbatch` pipeline
behind a panel: prompt, N candidates, ranked grid, pick one into the editor as an ordinary undoable
document. Driven against the live server in Chromium — three candidates for "a red mushroom",
ranked, picked, saved and reloaded with no console errors.

`src/gen/ops.ts` is the op language and rasteriser, a port of `voxgen.py:rasterise` pinned
byte-for-byte against the Python by hashing the `.vox` it writes (`ops.test.ts`), so the browser and
the Python pipeline cannot drift. `src/gen/llama.ts` talks to `localhost:8080` directly — the server
sends permissive CORS headers, so no proxy — with the schema in `response_format`, and records the
seed, temperature and model name it used. Candidates are generated one at a time on purpose: two
slots and no spare VRAM means parallel requests buy queueing, not throughput.

**CLIP is in the panel too, as of 2026-08-07** — the gap this milestone shipped with is closed. CLIP
needs torch on the CPU and cannot run in a browser, so `voxserve.py` is a small local service that
takes the op lists the editor already has, rasterises them with `voxgen.rasterise` (the same code
the TypeScript port is pinned against, so the voxels are identical), and returns the score. The
panel probes it, uses it when it is up, and says so when it is not; nothing depends on it.

**And it changed the default.** Deterministic scoring is exact but, measured over 18 candidates
across three prompts, it **saturates**: for "a stone tower" and "a wooden barrel" every candidate
scored exactly 1.000, so it ranked nothing, while CLIP spread them by 0.02–0.09. On the one prompt
where it did vary ("a red mushroom", spread 0.106) it agreed with CLIP at a rank correlation of
**0.83**. So the invented weights are not aimed wrongly — the measure is simply a _filter for broken
candidates_, not a ranker among good ones, and box-shaped subjects max out every term. The panel now
ranks by CLIP when the service answers and keeps the deterministic score on each card as the "is
this one broken?" read.

Open question 5 is answered: `Document.origin` carries the prompt, seed, sampler and model, the
project file is version 2, and version 1 files migrate by simply not having one.

**M4 — export pipeline.** ✅ **Done 2026-08-06.** Atlas packer, JSON sidecar, normal-map sheets,
Godot package.

`src/export/atlas.ts` bakes angles across and frames down, albedo and normals in the same layout
pixel for pixel, with optional tight trim (offsets recorded so the content goes back where it was)
and a power-of-two option. The sidecar carries the rects, the untrimmed cell, the pivot, the tags,
the palette and the generation record. `src/export/strip.ts` is the Aseprite round trip — slices out
as a grid, painted slices back in, with colours the palette does not have appended rather than
snapped to the nearest. `src/export/godot.ts` writes the `.tres`.

**Verified in the engine, not just against the docs.** Godot 4.7.1 headless loaded a package
exported by the browser UI: `SpriteFrames`, eight animations (`tag_0`…`tag_7`, one per baked angle),
each frame a `CanvasTexture` whose diffuse is an `AtlasTexture` region and whose normal texture is
set. The standalone `CanvasTexture` resource loads too. That settles the §14 entry.

**M5 — animation.** ✅ **Done 2026-08-06, both tiers.**

_Tier 1_ is per-frame volumes with tags: frames and tags from M1, copy-frame-and-edit (a duplicated
frame shares its cels until one is written), an **animation onion skin** that ghosts the same slice
from the frames either side — tinted warm for the previous frame and cool for the next, the way
every 2D tool does it — and playback that loops inside the tag under the playhead, or the whole
document when there is none. The export maths it had to prove is proven: M4 bakes frames × angles
with the tags intact and Godot loads the result.

_Tier 2_ is `src/anim/rig.ts`: bones that own a box of the rest pose and move its voxels in whole
voxel steps. Keys carry an integer offset and a visibility flag; between keys the offset is
interpolated **and then rounded**, which is the entire point — the in-betweens land on the grid
instead of smearing across it. Voxels outside every bone stay put, so a rig can cover an arm without
anyone declaring a root. Mirroring is both a per-bone flag (reflect this bone's x offset) and an
operation (`mirrorBone`, the other half of a cycle). `bakeRig` writes poses into frames 1…n as one
undoable edit; frame 0 stays the rest pose.

Deliberately not built: weighted skinning (meaningless on a grid — a voxel is in a place or it is
not) and rotation (a 90° turn is fine, an arbitrary one resamples and destroys the grid look; both
need a real use case first). The rig is authoring scaffolding held in editor state, not in the
project file — the baked frames are the asset, so `PROJECT_VERSION` stays at 2.

**M6 — effects and procedural shaders.** ✅ **Done 2026-08-06** for the two parts that earn their
place; the third is deliberately not built.

_The CPU pass pipeline_ (`src/fx/passes.ts`): outline (outside by default — an inside outline eats a
tenth of a 16×16 sprite), ordered Bayer dithering that modulates brightness rather than swapping
colours so nothing off-palette appears, palette cycling, Lambert over the exact normal map, and an
occlusion pass that darkens where neighbouring normals turn away. That last one is called
`normalOcclusion` and not "ambient occlusion" on purpose: it is a screen-space approximation, not
the volume integral the name would claim.

_The `voxel(x,y,z)` scripting surface_ (`src/fx/voxelScript.ts`, `src/fx/expr.ts`) is the part §8
calls the highest-value one. A script is one expression run per voxel in a box, in `set`, `add` or
`paint` mode, with the presets §8 names — bricks, noise, terrain, stairs, greebles, hollow — written
in the language as its readable specification. The evaluator is hand-written rather than
`new Function`: generated text handed to `Function` gets `fetch`, `localStorage` and the document,
where this one can only do arithmetic on the numbers it is given and call one fixed table of maths
functions. A test drives that boundary directly, and it caught a real hole — a plain object answers
to `constructor` and `toString` from its prototype, so name lookup goes through `Object.hasOwn`.

_GPU shaders in the viewport_ are **not built, on the plan's own condition.** §8 gates them on
measurement saying CPU rasterisation hurts, and §14's numbers say the opposite up to ~48³: one angle
of a 32³ model is 5.6 ms. The M0 measurement means the GPU is genuinely available under the Tauri
webview when that changes; it does not mean it is needed now.

---

## 13. Risks

| Risk                                              | Why it matters                            | Mitigation                                              |
| ------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| WebKitGTK software WebGL on NVIDIA                | Would gut a GPU-first editor              | Measured hardware here (§14); CPU still authoritative   |
| No VRAM headroom                                  | Kills diffusion, GPU CLIP, second model   | Designed around; stated, not discovered later           |
| CLIP ranking is weak                              | Cannot gate quality on it                 | Same-prompt only; deterministic checks beside it        |
| Animation export blow-up                          | 16 × 8 = 128 sprites per asset            | Atlas packer before animation, not after                |
| Renderer drift during refactors                   | Silent visual regressions                 | `parity.test.ts` hashes; regenerate deliberately        |
| Directional machines still fail                   | Known model limitation                    | Parametric templates; the editor is the fallback        |
| Axis-aligned renders lose ~45 % of visible voxels | Wrong output at the four most-used angles | Root-caused and fixed in M0; see §14                    |
| CPU renderer stops being live above ~48³          | Editing large volumes degrades            | Measured in §14; cache normals, then GPU path if needed |

---

## 14. Gray areas — what is not settled

Everything above is stated with the confidence it earned. This section says where that confidence
runs out. Nothing here is rhetorical; each item can change a decision.

### Found while writing this plan, and now fixed: axis-aligned renders were broken

**Fixed 2026-08-06.** `ox`/`oy` are floored in `voxrender.py` and `src/vox/render.ts`, the parity
hashes in `src/vox/parity.test.ts` were regenerated from the Python, and `src/vox/render.test.ts`
pins the property rather than the pixel count: at 0/90/180/270 the render must use every column the
volume occupies. Measured on `car.vox` at 0°, 82 visible pixels became 158, against 148 at 30°.
Anything exported before that date is still wrong at four angles in sixteen. The rest of this
subsection is the original diagnosis, kept because it explains why the failure was size-dependent.

**This is a defect, not a property of the technique, and it is in the Python too.**

At angle 0 (and 90/180/270) the centring offset is `ox = (diag - sx) / 2`. When `diag - sx` is odd,
`ox` lands on exactly `X.5`, and because the renderer uses Python's round-half-to-even, voxel
columns `x` and `x+1` round to the _same_ output column. Half the horizontal resolution disappears
and the sprite renders as disconnected stripes.

Measured on `car.vox` (16×10, `diag - sx = 3`): 8 distinct output columns instead of 16, and
visible-voxel coverage of 82 at angle 0 against ~150 at 15°/30°/45°/60°/135°. About 45 % of the
visible model is lost at exactly the four angles a top-down game uses most.

It is size-dependent, which is why it went unnoticed: `truck.vox` (26×14) and `fork1.vox` (24×14)
have an even `diag - sx` and render all columns. `car.vox` and any 16×16 model do not. My first
hypothesis — that lowering `lift` below `scale` would break the degeneracy — was tested and is
wrong; coverage gets worse at every lift value.

Flooring the offset fixes it completely (16/16 columns) and costs nothing. It changes every rendered
pixel, so it breaks the Python parity hashes in `src/vox/parity.test.ts` on purpose, and
`voxrender.py` needs the same fix if the Python stays in use. **Do this before M1** — every asset
produced until then is wrong at four angles out of every sixteen.

### Measured, and it moved the boundary

"The CPU renderer is fast enough" was an assertion when §3 was written. Now measured on this box,
single-threaded Bun, synthetic ~35 %-fill models:

| Volume    | 1 angle @ scale 4 | 16 angles @ scale 4 | 32 angles @ scale 8 |
| --------- | ----------------- | ------------------- | ------------------- |
| 16³       | 2.5 ms            | 17 ms               | 98 ms               |
| 32³       | 5.6 ms            | 93 ms               | 497 ms              |
| 64³       | 35 ms             | 582 ms              | 2.4 s               |
| 96³       | 113 ms            | 1.9 s               | 6.6 s               |
| `car.vox` | 0.30 ms           | —                   | —                   |

So CPU-first holds comfortably to 32³ — a single-angle live preview is 5.6 ms, inside a 60 fps
budget — and stops holding at 64³, where one angle alone blows the frame. **The real claim is "CPU
is authoritative up to ~48³", not "CPU is fast enough".** Above that, either the viewport gets a GPU
path or edits stop being live.

**Both optimisations run 2026-08-07, and the one this section predicted was the smaller of the
two.** Caching the surface normals per volume (`prepareNormals`, shared across a `rotationSheet` and
across a frame's angles in `packAtlas`) was worth about 10 %, not the "large bite" predicted here:
the neighbour lookups were never the hot part. The hot part was `data.set([r, g, b, a], at)` — an
array literal allocated per pixel, per image, which at scale 4 is 32 allocations per voxel per
angle. Four direct byte writes instead gave **~4×**. Re-measured on this box, same synthetic models,
medians (the box is also running the LLM, so these are noisier than the numbers above):

| Volume | 1 angle @ scale 4 | 16 angles @ scale 4 | 32 angles @ scale 8 |
| ------ | ----------------- | ------------------- | ------------------- |
| 16³    | 1.9 ms            | 8.6 ms              | —                   |
| 32³    | 5.1–7.6 ms        | 41 ms               | 162 ms              |
| 48³    | 19 ms             | —                   | 479 ms              |
| 64³    | 39–42 ms          | 343 ms              | 1.1 s               |
| 96³    | —                 | 1.2 s               | —                   |

The parity hashes are unchanged: this is the same pixels, faster. The boundary moves but does not
disappear — 48³ is 19 ms for one angle, which is a live preview at 30 fps but not 60, and 64³ still
blows the frame. **"CPU is authoritative up to ~48³" survives, with more headroom underneath it, and
a full 32-angle bake of a 48³ model is now half a second rather than two.**

### Unverified, load-bearing

- ~~**WebGL under WebKitGTK on this machine.**~~ **Measured 2026-08-06: it is hardware.**
  `experiments/webgl_probe.py` opens a real `webkit2gtk-4.1` web view; the same page was also run
  inside a window built from `tao` + `wry`, the two crates Tauri v2 builds its Linux window from, so
  this is the webview stack itself and not a lookalike. A fragment-heavy 512×512 draw (200 sin/cos
  iterations per pixel) runs at **0.017 ms/frame**, against **12.7 ms/frame** for the same page on
  SwiftShader in headless Chromium — 735× — and `nvidia-smi` shows `WebKitWebProcess` as a graphics
  context holding VRAM on GPU 1 while it runs. `MAX_TEXTURE_SIZE` is 32768 here against 8192 on
  SwiftShader.

    Two things fell out that matter more than the headline. **The renderer string is useless as a
    detector**: WebKit masks it, reporting `Apple Inc.` / `Apple GPU` on an NVIDIA box, so code that
    sniffs for `llvmpipe` or `SwiftShader` to decide whether to take a GPU path would be reading a
    fiction — a timing probe is the only honest check. And `LIBGL_ALWAYS_SOFTWARE=1` changed
    nothing, because WebKit's GPU process goes through the NVIDIA EGL driver rather than Mesa's
    libGL. Tauri's two recommended flags cost rather than help here:
    `WEBKIT_DISABLE_COMPOSITING_MODE=1` is neutral, `WEBKIT_DISABLE_DMABUF_RENDERER=1` is ~30 %
    slower.

    This lowers the severity behind §3 but does not change it: CPU-first is still right, because the
    renderer must also run in a Worker, in Bun and in CI, and because one machine measuring hardware
    says nothing about the next. What it does change is that a GPU viewport path for M2/M6 is worth
    building when the volumes get big, rather than being written off as unreliable on this platform.

- ~~**Copy-on-write in TypeScript.**~~ **Measured, and it works.** Manual refcounts were dropped for
  a per-chunk write claim that cloning revokes, which needs no explicit free and so cannot leak or
  corrupt under a GC. 100 one-voxel edits to a full 32³ document, each snapshotted: 48 KB retained
  against 3.2 MB for naive copies, and 2 ms for the whole run. `src/doc/volume.test.ts`.
- ~~**16³ chunks.**~~ **Measured: 8³ wins, and is what `src/doc/volume.ts` uses.** Same 100-snapshot
  workload, 48 KB at 8³ against 160 KB at 16³ — 3.3× — for about 1 ms more time. The suspicion in
  the original note was right.
- ~~**Godot 4.7 export.**~~ **Verified 2026-08-06 against Godot 4.7.1 headless.** The recipe works:
  a `.tres` exported by the editor loads as a `SpriteFrames` with one animation per baked angle,
  each frame a `CanvasTexture` pairing an `AtlasTexture` region of the albedo sheet with the same
  region of the normal sheet.

    **And the lighting works, measured 2026-08-07.** A scene with a `PointLight2D` over that sprite,
    rendered twice with the light on opposite sides: attaching the normal texture changed mean
    brightness from 0.307 to 0.199, and — the test that actually settles it — moving the light from
    left to right made pixels whose exported normal points left **33.6/255 darker** and pixels whose
    normal points right **52.2/255 brighter**. Opposite signs on the two groups is the signature of
    a normal map being consumed; a light that ignored it would move both the same way. So §8's claim
    that the exact normals are a real advantage now rests on a render, not on a tutorial.

- ~~**`.vox` extension chunks.**~~ **Implemented 2026-08-07 from the raw spec** (§11). The details
  that would have been guessed wrong from a summary: `DICT` values are _strings_, so `_t` is
  `"x y z"` and `_r` is the decimal `"4"`; the graph must be Transform → Group → Transform → Shape,
  a group cannot own a shape; a model's id is its index in the stored order of `SIZE`/`XYZI` pairs;
  and the reserved fields really must be −1.

    **Verified two ways, and neither is MagicaVoxel.** The file round-trips through our own reader,
    and — the check that means more — through an independent parser written in Python straight from
    the spec, sharing no code, which asserts the graph shape, the reserved fields, the identity
    rotation and that every model hangs off a transform. MagicaVoxel is not installed on this box,
    so "MagicaVoxel opens it" is still unverified; what is verified is that the bytes match the
    specification.

- **`.ase` palettes.** Listed in §11, not written. The binary layout available to me is a
  second-hand summary; a writer built from that would emit files Adobe may not open, which is worse
  than not offering the format. `.gpl`, `.hex`, `.pal` and PNG strips are implemented and
  round-trip-tested.

### Genuinely uncertain, roughly even odds

- ~~**Image-only critique (§9 fix 2).**~~ **Run 2026-08-06: no.** The three modalities are
  indistinguishable at n=8 each, and the real obstacle is that the model returns its own model
  unchanged 22 times in 24. Details in §9 fix 2, script in `experiments/t21_critique.py`. The
  suspicion recorded here — that removing the stats could make critique worse — was not confirmed
  either; nothing moved in any direction.
- ~~**Grid-constrained bones (§10 tier 2).**~~ **Built and measured 2026-08-06, in the narrow form
  described in §10.** Box-owned bones with whole-voxel offsets work and keep the grid look: every
  baked in-between is an integer offset, and a baked frame holds exactly the voxel count of the rest
  pose (`src/anim/rig.test.ts`). What is still unknown is whether this is _enough_ rig for a walk
  cycle a person would ship — that needs an artist making one, not another test. Rotation and
  weighted skinning remain unbuilt and unscoped, for the reasons in §10.
- ~~**16 angles as the default.**~~ **Re-derived 2026-08-07 and replaced with a measurement** — §8
  has the numbers. The short version: there is no knee in the error curve, the right count is a
  property of the model rather than a global constant, `angleAdvice` measures it per model, and the
  axis-aligned question is settled in favour of baking those angles rather than skipping or
  offsetting them.

    What is still open underneath it: the 8 % mean-error target `angleAdvice` defaults to is a
    judgement, not a measurement. Silhouette error is a proxy for "the rotation looks steppy", and
    nobody has watched a turning sprite at 16 versus 32 and said which they prefer. The curve is
    real; where on it to stand is still taste.

### Measured, and the claim held

- **The editor runs under WebKitGTK.** Not just WebGL (below) but the application: loaded in the
  `tao`/`wry` window, every API it uses works, it mounts, and a Worker bake there produces a sheet
  whose hash matches Chromium's byte for byte. §3 has the detail. This is the measurement that makes
  the "standalone Tauri app" option a decision rather than a gamble.
- **The renderer really does run in a Worker.** §3 listed that among its reasons and nothing had
  ever done it. `src/vox/render-worker.ts` bakes an atlas off the main thread and
  `src/editor/bake.ts` drives it, falling back to the calling thread where there is no `Worker`.
  Measured in Chromium on `fork1.vox`: a 32-angle bake at scale 8 stalled the main thread for a **66
  ms** frame gap when run inline and **32 ms — no gap over 50 ms at all** through the Worker. The
  pixels are identical, checked by SHA-256 of both sheets in the page as well as by a unit test
  comparing `runBake` against `packAtlas`.

    The honest cost: the bake itself is **slower** off-thread — 98 ms against 62 ms for that sheet —
    because the models are structured-cloned across and the worker starts cold. You are buying a
    responsive editor with about 50 % more wall clock, which is the right trade for a button a
    person presses, and the wrong one for a batch job. `packAtlas` stays exported for the batch
    case.

### Settled by measurement, and negative

- **Evolutionary refinement against CLIP (§9).** Runs, climbs, costs no LLM time, and makes the
  sprite worse. Observed directly: a mushroom's cap broke apart for +0.03 CLIP. Do not ship a
  refinement loop over a CLIP objective.

### Invented

- ~~The palette contrast thresholds in §7.~~ **Calibrated 2026-08-07** and now measured rather than
  invented — §7 has the numbers and the criterion. Two things the measurement turned up that matter
  more than the thresholds:

    - **`flatSlicePairs` is blind to hue.** It compares mean lightness, and two slices at the same
      L\* in different hues render 51–77 levels apart — perfectly legible, and still reported as
      flat. The check is a value check, not a legibility check, and should be read that way.
    - **A lit render separates slices on its own.** Two slices of the _same_ colour show a 52-level
      step in the lit image, because Lambert shades a top face differently from a side. The blob
      these checks look for is an unlit, flat-read problem; with the lighting pass on, the stack
      reads even when the palette does not help.

- The weights in `overallScore` (`src/gen/score.ts`) — 0.45 connectivity, 0.35 slice usage, 0.1
  capped bbox fill, 0.1 palette compliance — are a plausible-sounding default sort order, not a
  calibrated one. **Measured against CLIP 2026-08-07 and the answer is more interesting than
  "wrong":** across 18 candidates on three prompts the combined score was exactly 1.000 for every
  candidate on two of them — connectivity, slice usage and the capped bbox fill all max out on
  anything box-shaped — so it produced no ordering at all. Where it did vary it tracked CLIP at 0.83
  rank correlation. The weights are therefore untested rather than wrong, and the real defect is
  saturation: **treat the deterministic score as a filter for broken candidates and rank with
  CLIP.** Recalibrating means finding terms that discriminate among _good_ models, which is a
  different exercise from reweighting these.

---

## 15. What this does not do

No cloud services. No asset store. No multiplayer or collaborative editing. No general 3D modelling
— the volume exists to be sliced. No attempt to make the LLM draw pixels; that is settled dead and
is recorded as such.
