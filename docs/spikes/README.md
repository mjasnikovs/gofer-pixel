# spikes — validated reference implementations, not production code

These three files are the experiments behind `docs/techstack.md`. They are excluded from lint,
format, typecheck and test. Read them; do not import them.

- **`raycast-parity.ts`** — the load-bearing one. Runs a CPU raycaster and a GLSL raycaster over the
  same volume and camera and compares them pixel by pixel. As committed it reports **zero**
  colour and normal differences on five cameras, on both the NVIDIA driver and SwiftShader.
  It already contains the camera-basis snap and the finite-sentinel rules from techstack.md §2 —
  the version without them disagreed on the axis-aligned side view and lost a fifth of the model.
- **`cpu-raycast-bench.ts`** — where the "3.5 ms for a 128x128 sprite from a 128³ model" number
  comes from.
- **`gpu-bench.ts`** — where the headless-Chromium flags and the 1.21 ms vs 61.7 ms number come
  from.

Run them with `bun docs/spikes/<file>.ts`. The two GPU ones need `playwright`.
