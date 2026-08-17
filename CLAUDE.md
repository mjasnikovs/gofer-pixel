# gofer-pixel

A local pixel sprite editor. An artist builds voxel art; the software turns cameras into sprite
sheets and turns geometry into colour, normal, depth, AO and emission maps. It is **not** a 3D
editor and does not grow into one. Every feature is judged by whether it helps produce pixels.

Read `docs/techstack.md`, `docs/FEATURESET.md`, `docs/TASKS.md`, `docs/VALIDATE.md`.
**`docs/editor.png` and `docs/featureset.png` are the spec** and beat FEATURESET.md where they
disagree — one overrule: the bottom-left settings box is gone and the layout is four columns.

## The renderer — one algorithm, two backends

TypeScript on the CPU renders every exported sprite and runs inside `bun test` (128² sprite from a
128³ model, 3.5 ms); it is the golden-pixel oracle. GLSL on the GPU renders only the interactive
viewport. They agree byte for byte, **conditional on two contract rules, not test concessions**:
camera basis components under `1e-6` snap to exactly `0` and the basis goes through `Math.fround`,
or an "axis-aligned" camera is not one and `1/dir` explodes differently in float32 and float64; and
a zero direction component uses a shared finite sentinel (`1e18`), never `Infinity` — in the slab
test, in `tDelta`, and in the initial `tMax`. Break either and axis-aligned views silently lose a
fifth of the model.

## Layout

`src/render/` raycaster, shader, camera, light · `src/vox/` `.vox` → `Volume` · `src/doc/` document,
gestures, files, history · `src/sheet/` packing and export · `src/image/` PNG, zip · `src/viewport/`
orbit/pan/zoom · `src/app/` one `AppState`, one `reduce`, the panels · `src/theme/` never edit the
generated CSS · `browser/` Playwright.

**A panel takes `state` and `dispatch`, nothing else** — except memoised derivations and ports
(`Files`, `Store`), because a panel must not choose which disk a read goes through. Logic that would
otherwise need a mounted window lives in its own module with its own tests; look for that seam
before reaching for a mount.

**AI generation was removed 2026-08-17** — all of `src/gen/`. A disabled menu row and an empty
`GenerateDialog.tsx` remain. Do not rebuild it from memory; the measurements are in git.

## Testing — nothing waits

**A test containing a duration is a broken test.** No `sleep`, `waitForTimeout`, `waitFor`, polling,
`user-event`, screenshot diffing. React flushes synchronously in `act()`, clicks are
`element.click()`, and the viewport's `renderNow()` plus a frame counter let a test await a frame
having landed. One panel over a real reducer is `test/panel.tsx`; `App.test.tsx` is for composition.
**Never put a big `Volume` through a window test** — a 64³ grid costs 17 s under React's dev build.
Playwright does not gate `check`, runs one worker, and needs
`--use-angle=vulkan --enable-features=Vulkan --use-gl=angle --ignore-gpu-blocklist`.

## Commands and conventions

`bun run check` is the gate (format, lint, typecheck, test — no browser); also `dev` (:1430),
`build`, `test:browser`, `theme`, `format`. ESLint 10 type-aware strict, Prettier (4 spaces, no
semicolons, single quotes, no bracket spacing, width 100), TypeScript 6 with
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — which bans `!` on indexed access, so
use `?? fallback` or a guard. Imports are extensionless. Read `skills/gofer-ui/SKILL.md` before
touching the theme; `src/theme/theme.test.ts` gates it. Godot 4.7.1 is at `/usr/bin/godot`.
