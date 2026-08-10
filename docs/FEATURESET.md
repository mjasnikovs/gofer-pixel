I'd make **pixel-perfectness a hard constraint of the engine**, not something the artist has to
remember. No arbitrary bending, fractional voxel transforms, accidental interpolation, or off-grid
geometry.

### How to read this list

Items and bullets marked **POSTPONE — NOT IMPLEMENT NOW** are decided-against for the current build,
not merely unscheduled. They come back only by an explicit decision to reopen them, and the reason
is recorded next to each one. Everything unmarked is in scope for the someday-list as before.

The three groups postponed on 2026-08-07, and why:

- **Lighting, materials and shaded output (20, 21, 22).** Item 18 already exports normal, depth and
  AO, so the game engine does the lighting. Building a light rig here duplicates the engine and does
  it worse, because we don't know which engine.
- **Animation (24, 25, 26, 27).** A timeline, 3D onion skinning and pose diffing is a second
  application bolted to the first. The document format should still hold a _list_ of voxel states
  from day one so this can be added later without reshaping the file or the sheet packer.
- **Scene graph beyond a flat list (11, 23, and the hierarchy parts of 8 and 28).** Parenting,
  instances and a modifier stack are exactly the "grows into a 3D editor" direction the project says
  it won't take.

### Feature set plan

1. **Infinite-feeling voxel canvas**

    - Clean 3D viewport as the main UI.
    - Orthographic viewing.
    - ~~Perspective viewing.~~ **POSTPONE — NOT IMPLEMENT NOW.** Sprites are orthographic, so a
      perspective mode exists only to look at the model, and it makes "what you see in the preview
      is exactly what gets exported" untrue.
    - Optional grid; minimal visual clutter.
    - Fast orbit/pan/zoom.
    - Focus/isolate selected object.

2. **Strict voxel rules**

    - Everything lives on integer XYZ coordinates.
    - Voxels never deform.
    - No fractional scaling.
    - Rotations that would destroy the voxel grid aren't silently allowed.
    - Nearest-neighbor rendering everywhere.
    - What you see in the sprite preview is exactly what gets exported.

3. **Extremely small core toolset**

    - Draw.
    - Erase.
    - Paint.
    - Fill.
    - Pick color.
    - Box select.
    - Move.
    - Duplicate.
    - Extrude/pull.
    - Mirror.

4. **Context-sensitive tools**

    - Hover empty space → Draw adds voxels.
    - Hover voxel → Paint modifies it.
    - Drag a face → Extrude.
    - Drag selection → Move.
    - Relevant controls appear near the selection instead of permanently occupying panels.

5. **2D-style drawing inside 3D**

    - Lock drawing to XY, XZ or YZ plane.
    - Click a face to temporarily make it your canvas.
    - Rectangle/line/ellipse voxel drawing.
    - Copy/paste selections.
    - Flip horizontal/vertical.
    - Think **pixel editor controls operating in 3D**.

6. **Smart slice mode**

    - Press a key and the model becomes editable slice-by-slice.
    - Mouse wheel moves through depth.
    - Current slice is solid; surrounding slices become ghosted.
    - Lets artists draw complex interiors without fighting the camera.

7. **Palette-first workflow**

    - Project palette.
    - Recent colors.
    - Eyedropper.
    - Palette locking.
    - Replace color globally.
    - Select all voxels of a color.
    - Palette import/export.
    - Optional indexed-color output.

8. **Objects instead of one giant voxel volume**

    - Character / Sword / Shield / Ground / Tree etc.
    - Rename, hide, lock, duplicate.
    - ~~Parent objects.~~ ~~Simple hierarchy.~~ **POSTPONE — NOT IMPLEMENT NOW.** A flat list is
      enough to hide, lock and solo pieces while drawing. Parenting only earns its keep once objects
      move relative to each other, which is animation.
    - Objects remain independently editable.

9. **Voxel-safe transforms**

    - Move by whole voxels.
    - Rotate 90°.
    - Flip X/Y/Z.
    - Mirror.
    - Duplicate.
    - Array/repeat.
    - No operation should unexpectedly create half-voxels.

10. **Symmetry**

    - X/Y/Z mirror drawing.
    - Radial symmetry where mathematically voxel-safe.
    - Visual symmetry plane.
    - Extremely useful for characters, buildings, vehicles, props.
    - This is a _draw-time_ mirror that writes real voxels, not a live modifier — see 23.

11. **Components / instances** — **POSTPONE — NOT IMPLEMENT NOW**

    Editing a source and having every copy update is a scene-graph feature: it needs instance
    identity in the file format, an override model for the broken ones, and a rule for what happens
    when an instance is rotated. Duplicate-and-edit covers the four wheels until it doesn't.

    - Build one wheel and use it four times.
    - Editing the source optionally updates every instance.
    - Break instance when you want a unique version.
    - Great for repetitive pixel/voxel assets.

12. **Camera = Sprite**

    - Position camera.
    - Press **Capture View**.
    - That becomes a named sprite view.
    - Front, Back, Left, Right, ¾, Isometric, Custom, etc.
    - Thumbnail shown immediately.

13. **Automatic directional cameras**

    - "Create 4 directions."
    - "Create 8 directions."
    - "Rotate every 45°."
    - Cameras generated around a common pivot.
    - One-click preview of the resulting sprite set.

14. **Pixel-perfect camera**

    - Orthographic by default for sprites.
    - Fixed sprite resolution.
    - Pixel snapping.
    - ~~Integer zoom.~~ **Wrong invariant — corrected 2026-08-10.** Zoom is how many voxels tall the
      frame is; what lands on the pixel grid is `cell / zoom`, how many pixels tall a voxel is.
      Rounding the first does nothing for the second: the camera every new 16³ document opens on is
      zoom 31, an integer, and 64 / 31 is 2.06, so a row of voxels exports `3 2 2 2 2 2 2 2 3`. SNAP
      walks the zooms at which a voxel is whole, and the rule is in `src/render/perfect.ts`.
    - Camera alignment tools.
    - Consistent object scale between camera views.
    - **The default ring pitch is the 2:1 dimetric, `asin(1/2)`, not true isometric.** Measured:
      true isometric, `atan(1/√2)`, has a screen slope of `1/√3` and no whole-pixel zoom at any zoom
      at all. 2:1 has an exact 0.5 slope, which is the even staircase pixel artists draw by hand,
      and a vertical edge of `√1.5` that still does not close — hand-drawn 2:1 squashes that by eye
      and an orthographic camera cannot. It is the closest an honest camera gets, and it is what
      every tileset and asset pack is drawn to.
    - `asin(1/3)`, 19.47°, is the _only_ three-quarter angle where a whole voxel closes — 3 across,
      1 down, 4 tall. **It is deliberately not offered.** It shows 20% top face against 2:1's 29%,
      and lines up with no existing art. See `src/doc/cameras.ts`.
    - **Sprite cells are not required to be square** — `cellW` and `cellH`. The height sets the
      scale; the width only says how far the frame reaches either side of the pivot.

15. **Live sprite preview**

    - Small 2D preview always available.
    - 16×16 / 32×32 / 64×64 / 128×128 etc.
    - See immediately whether details survive downsampling.
    - Zoomed preview remains nearest-neighbor.

16. **Sprite-sheet workspace**

    - Cameras become columns/rows.
    - Animation frames become the other axis.
    - Drag to reorder.
    - Automatic packing.
    - Padding preview.
    - Transparent background.
    - Preview the actual PNG before exporting.

17. **Single-sprite export**

    - Current camera → PNG.
    - Selected cameras → individual PNGs.
    - All cameras → sprite sheet.
    - Drag-and-drop export could be fantastic.

18. **Output maps**

    - Color.
    - Normal.
    - Depth.
    - Height.
    - Ambient occlusion.
    - Emission.
    - Object/material ID.
    - All derived from exactly the same camera.

19. **Normal-map preview**

    - Generated directly from voxel geometry.
    - Pixel-perfect correspondence with color sprite.
    - Adjustable face smoothing rules if needed.
    - A live 2D lighting preview, **strictly as a diagnostic**: one light, a fixed and labelled axis
      convention, never baked, never exported, never a second light. Its job is to catch an inverted
      green channel before the artist ships a map that lights backwards in Godot.
    - It must not share its convention code with the exporter. Two things agreeing proves nothing
      unless one of them is independently right — the same trap as the raycaster/shader agreement in
      `docs/techstack.md` §2.

20. **Materials without becoming Blender** — **POSTPONE — NOT IMPLEMENT NOW**, except emissive

    Item 18 promises an emission map, so a per-color emissive flag has to exist to say which voxels
    glow. Nothing else here does: rough/metallic have no meaning without a lighting model, and
    "unlit vs lit" is a decision the game engine makes, not this editor.

    - Keep them deliberately simple.
    - Color.
    - Emissive. ← the exception; needed by 18.
    - ~~Rough/metallic only if genuinely useful.~~
    - ~~Perhaps "unlit pixel" vs "lit voxel".~~
    - Avoid node graphs entirely.

21. **Lighting made for pixel art** — **POSTPONE — NOT IMPLEMENT NOW**

    The normal, depth and AO maps hand lighting to the game engine, which knows its own falloff,
    blend mode and axis convention. Reimplementing that here means guessing at all three.

    - Sun.
    - Ambient.
    - Point light.
    - Maybe three-light maximum by default.
    - Hard/soft shadows.
    - Quantized lighting option.
    - Live final-sprite preview.

22. **Pixel-art lighting mode** — **POSTPONE — NOT IMPLEMENT NOW**

    Depends entirely on 21, and picking lighter/darker palette entries automatically is a colour
    science project of its own.

    - Quantize shading into 2/3/4/etc. brightness steps.
    - Palette-aware shading.
    - No ugly smooth gradients.
    - Potentially automatically choose lighter/darker colors from the project's palette.

23. **Non-destructive modifiers** — **POSTPONE — NOT IMPLEMENT NOW**

    A modifier stack means every tool has to ask "am I editing the source or the result?", and that
    question is the beginning of being a 3D editor. Mirror, array and hollow stay as _operations_
    that write voxels and can be undone (9, 10), not as live nodes.

    - Mirror.
    - Repeat.
    - Array.
    - Hollow.
    - Outline.
    - Maybe voxelize.
    - Keep this list intentionally small.

24. **Animation — but voxel-safe** — **POSTPONE — NOT IMPLEMENT NOW**

    The document format should nonetheless be able to hold a _list_ of voxel states from the start,
    so frames can be added later without reshaping the file or the sheet packer.

    - Frame-based, not smooth mesh deformation.
    - Frames can contain changed voxel objects/positions.
    - Whole objects can move on integer coordinates.
    - Swap voxel states/models between frames.
    - No secretly bent knight arms.

25. **Onion skinning in 3D** — **POSTPONE — NOT IMPLEMENT NOW** (depends on 24)

    - Previous frame ghost.
    - Next frame ghost.
    - Adjustable range.
    - Toggle per object.
    - Could be extraordinarily useful for voxel character animation.

26. **Pose variants** — **POSTPONE — NOT IMPLEMENT NOW** (depends on 24)

    - Instead of forcing skeletal deformation: `Knight/Idle` `Knight/Walk1` `Knight/Walk2`
      `Knight/Attack`
    - Reuse unchanged objects between poses.
    - Only modified pieces consume additional data internally.

27. **Animation + camera multiplication** — **POSTPONE — NOT IMPLEMENT NOW** (depends on 24)

    The cheap half of animation, but worthless without frames to multiply.

    - 8 cameras × 6 walk frames = automatic 48-sprite sheet.
    - Artist works on the voxel animation once.
    - Editor handles the tedious sprite generation.

28. **Layers that don't suck**

    - I'd actually call them **Objects**, not Layers.
    - Search.
    - Hide.
    - Lock.
    - Solo.
    - ~~Group.~~ ~~Drag hierarchy.~~ **POSTPONE — NOT IMPLEMENT NOW**, with 8. Reorder a flat list
      instead.
    - Nothing more unless necessary.

29. **Command/search palette** — **POSTPONE — NOT IMPLEMENT NOW**

    A search box over a small toolset is an empty room. Revisit when there are enough commands that
    finding one is a real problem.

    - `Ctrl/Cmd + K`
    - Type "mirror X".
    - Type "export 8 directions".
    - Type "replace red".
    - Advanced functionality doesn't need permanent buttons.

30. **Radial/context menu** — **POSTPONE — NOT IMPLEMENT NOW**

    Same reason as 29; item 4 already puts controls next to the selection.

    - Right-click selection: `Duplicate / Mirror / Rotate / Delete / Group`
    - Keeps the main UI almost empty.

31. **Selection intelligence**

    - Click = voxel.
    - Double-click = connected region.
    - Modifier-click = whole object.
    - Select by color.
    - Select connected color.
    - Expand/shrink selection.

32. **Undo that feels indestructible**

    - Long undo history.
    - Autosave.
    - Crash recovery.
    - Automatic project snapshots.
    - ~~Visual history for major operations.~~ **POSTPONE — NOT IMPLEMENT NOW.** Rendering a
      thumbnail per undo step is a feature about undo, not a feature of it.

33. **Reference images**

    - Drop pixel art into Front/Side/Top.
    - Adjustable opacity.
    - Lock it.
    - Build voxels directly against it.
    - Potentially trace pixels → voxels.

34. **2D sprite → voxel starting point**

    - Import PNG.
    - Every opaque pixel becomes a voxel.
    - Choose extrusion depth.
    - Instantly gives artists something to sculpt from.

35. **Voxel stamp library** — **POSTPONE — NOT IMPLEMENT NOW**

    Copy/paste and duplicate cover this until artists have a body of work worth a library.

    - Save reusable chunks: hand, tree branch, window, wheel, rock.
    - Drag them into the scene.
    - User-created, not a giant complicated asset marketplace.

36. **Beautiful project browser** — **POSTPONE — NOT IMPLEMENT NOW**

    The OS file dialog opens files today. Templates are worth keeping in mind as a small "new
    project" dialog, not a browser.

    - Projects represented by rendered sprites rather than boring filenames.
    - Recent projects.
    - Templates: `16³ Character`, `32³ Character`, `Isometric Tile`, `Prop`, `Diorama`.

37. **One-click game-engine export**

    - PNG sprite sheet.
    - Individual PNGs.
    - Metadata JSON.
    - Camera/direction names.
    - ~~Frame duration.~~ needs 24.
    - Pivot/origin.
    - Collision bounds optionally.

38. **Export presets**

    - "Godot 8-direction character."
    - "Unity sprite sheet."
    - "Raw PNG."
    - "Isometric tiles."
    - User-created presets.
    - After configuring once, exporting becomes literally one button.

39. **Deliberately hide complexity**

    - Beginner sees maybe: **Draw · Erase · Select · Color · Camera · Export**
    - More functionality appears contextually or through shortcuts.
    - The app shouldn't advertise how powerful it is by covering the screen in buttons.

40. **The core product principle**

    - **Artist makes voxel art. Software does everything else.**
    - Cameras generate sprites.
    - Geometry generates normals/depth/AO.
    - Cameras × animation generate sheets.
    - Palette rules preserve pixel art.
    - Grid rules prevent invalid transforms.
    - Export presets handle technical formatting.
