# Proof-of-concept prompt

Paste the block below into a fresh session.

---

Build the gofer-pixel proof of concept.

Read `CLAUDE.md`, then `docs/techstack.md`, then open `docs/editor.png` and `docs/featureset.png` —
those two images are the spec. `docs/FEATURESET.md` is a someday-list, not a plan. `legacy/` is dead
code kept for reference; read `legacy/README.md` before opening anything in it, and never import
from it.

## The goal

One vertical slice that proves the whole idea is real: **a voxel model goes in, a sprite sheet and a
matching normal map come out, the viewport orbits at 60 fps, it looks like the mockups, and the
whole test suite runs in under a second.**

It has to be convincing on feel, not just on correctness. If orbiting is laggy, if the panels look
like a grey form, or if the sprite comes out muddy, the proof of concept has failed even with green
tests.

## Build exactly this, in this order

Each step ends with `bun run check` green. Do not start the next one until it is.

**1. `src/render/raycast.ts` — the CPU raycaster.** One ray per output pixel, orthographic camera,
integer voxel grid, nearest everything. Returns colour, normal, depth and voxel id from the same
ray. `docs/spikes/raycast-parity.ts` is a validated reference implementation — read it, do not copy
it wholesale; it is untyped spike code. Obey both contract rules in techstack.md §2: snap camera
basis components under `1e-6` to exactly zero and pass the basis through `Math.fround`, and use a
shared finite sentinel (`1e18`) instead of `Infinity` for a zero direction component in the slab
test, in `tDelta` and in the initial `tMax`. Write a property test that every occupied voxel column
survives at 0°, 90°, 180° and 270° — that defect has now bitten this project twice from two
different directions.

**2. `src/render/raycast.glsl.ts` — the same algorithm as a fragment shader,** plus a Playwright
test asserting it matches the CPU render exactly on colour and normal and within one unit on encoded
depth, on at least five cameras including both axis-aligned ones. Chromium needs
`--use-angle=vulkan --enable-features=Vulkan --use-gl=angle --ignore-gpu-blocklist` or it silently
falls back to software. This test is the reason the architecture works; write it before the
viewport, not after.

**3. `src/theme/theme.ts` plus the astryx theme build.** The mockups are a dark, dense tool chrome —
a distinct body, surface and elevated-panel ramp, not one grey everywhere. Read
`skills/gofer-ui/SKILL.md` first and run the `astryx docs` commands it names; that skill exists
because a sibling project shipped a screen that measured 89.5 % one colour. Re-add the `theme`
script to package.json pointing at the real file. Getting this right early is not polish — "does it
look good" is one of the things being proven.

**4. The viewport.** A WebGL2 canvas running the shader, orbit / pan / zoom, one hard-coded lit
model loaded from `legacy/assets/car.vox` via a `.vox` reader (`legacy/src/vox/vox-file.ts` is
correct format code worth re-deriving from). The render loop must be **drivable** — expose
`renderNow()` and a monotonic frame counter, and never let `requestAnimationFrame` own it, because a
test has to await a frame having landed rather than a duration.

**5. Cameras.** A named camera list with live thumbnails and a "create 8 directions" button, exactly
as in `docs/editor.png`. A camera is a stored orthographic transform plus a name.

**6. The sheet.** Render every camera on the CPU into one packed sprite sheet plus a matching normal
sheet, show both in the panel, and let the user download the PNGs. Golden-hash both in `bun test` —
this is the whole point of the CPU renderer being the exporter.

## Do not build

Editing tools, drawing, layers, animation, frames, undo, palette editing, LLM generation, export
presets, engine-specific exporters, materials, or a 2D slice mode. All of those are understood and
none of them prove anything. If one seems necessary, say so instead of building it.

## The testing law — this is not negotiable

**A test that contains a duration is a broken test.** No `sleep`, no `page.waitForTimeout`, no
`waitFor`, no polling, no `@testing-library/user-event`, no animated scrolling, no screenshot
diffing. React updates flush synchronously inside `act()`. Clicks are `element.click()` on a real
happy-dom node. Golden pixel hashes come from the CPU raycaster, which needs no GPU. Playwright is
roughly ten tests for what genuinely cannot exist outside a browser, and it must not gate
`bun run check`.

If you ever find yourself wanting to wait for something, the thing you are testing needs an event or
a promise, and adding it is part of the task.

## Done means all of these, demonstrated and not asserted

- `bun run check` is green and takes under 5 seconds, with no browser in it.
- The Playwright suite is green and takes under 10 seconds.
- The CPU and GPU renders match on five cameras, proven by a test in the repo.
- `bun run dev` orbits `car.vox` at 60 fps — measure it, do not assume it.
- One click produces an 8-direction sprite sheet and a normal sheet, both downloadable, both
  golden-hashed.
- A screenshot of the running app that plausibly resembles `docs/editor.png`.

Report the measured numbers for each. Where you did not verify something, say "not verified" in the
same sentence as the claim.
