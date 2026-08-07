I'd make **pixel-perfectness a hard constraint of the engine**, not something the artist has to
remember. No arbitrary bending, fractional voxel transforms, accidental interpolation, or off-grid
geometry.

### Feature set plan

1. **Infinite-feeling voxel canvas**

    - Clean 3D viewport as the main UI.
    - Orthographic and perspective viewing.
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
    - Parent objects.
    - Simple hierarchy.
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

11. **Components / instances**

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
    - Integer zoom.
    - Camera alignment tools.
    - Consistent object scale between camera views.

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
    - Live 2D lighting preview so the artist can see what the normal map actually does.

20. **Materials without becoming Blender**

    - Keep them deliberately simple.
    - Color.
    - Emissive.
    - Rough/metallic only if genuinely useful.
    - Perhaps "unlit pixel" vs "lit voxel".
    - Avoid node graphs entirely.

21. **Lighting made for pixel art**

    - Sun.
    - Ambient.
    - Point light.
    - Maybe three-light maximum by default.
    - Hard/soft shadows.
    - Quantized lighting option.
    - Live final-sprite preview.

22. **Pixel-art lighting mode**

    - Quantize shading into 2/3/4/etc. brightness steps.
    - Palette-aware shading.
    - No ugly smooth gradients.
    - Potentially automatically choose lighter/darker colors from the project's palette.

23. **Non-destructive modifiers**

    - Mirror.
    - Repeat.
    - Array.
    - Hollow.
    - Outline.
    - Maybe voxelize.
    - Keep this list intentionally small.

24. **Animation — but voxel-safe**

    - Frame-based, not smooth mesh deformation.
    - Frames can contain changed voxel objects/positions.
    - Whole objects can move on integer coordinates.
    - Swap voxel states/models between frames.
    - No secretly bent knight arms.

25. **Onion skinning in 3D**

    - Previous frame ghost.
    - Next frame ghost.
    - Adjustable range.
    - Toggle per object.
    - Could be extraordinarily useful for voxel character animation.

26. **Pose variants**

    - Instead of forcing skeletal deformation: `Knight/Idle` `Knight/Walk1` `Knight/Walk2`
      `Knight/Attack`
    - Reuse unchanged objects between poses.
    - Only modified pieces consume additional data internally.

27. **Animation + camera multiplication**

    - 8 cameras × 6 walk frames = automatic 48-sprite sheet.
    - Artist works on the voxel animation once.
    - Editor handles the tedious sprite generation.

28. **Layers that don't suck**

    - I'd actually call them **Objects**, not Layers.
    - Search.
    - Hide.
    - Lock.
    - Group.
    - Solo.
    - Drag hierarchy.
    - Nothing more unless necessary.

29. **Command/search palette**

    - `Ctrl/Cmd + K`
    - Type "mirror X".
    - Type "export 8 directions".
    - Type "replace red".
    - Advanced functionality doesn't need permanent buttons.

30. **Radial/context menu**

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
    - Visual history for major operations.

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

35. **Voxel stamp library**

    - Save reusable chunks: hand, tree branch, window, wheel, rock.
    - Drag them into the scene.
    - User-created, not a giant complicated asset marketplace.

36. **Beautiful project browser**

    - Projects represented by rendered sprites rather than boring filenames.
    - Recent projects.
    - Templates: `16³ Character`, `32³ Character`, `Isometric Tile`, `Prop`, `Diorama`.

37. **One-click game-engine export**

    - PNG sprite sheet.
    - Individual PNGs.
    - Metadata JSON.
    - Camera/direction names.
    - Frame duration.
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
