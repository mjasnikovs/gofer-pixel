# spikes — validated reference implementations, not production code

These are the experiments behind `docs/techstack.md` and the local-AI section of `docs/TASKS.md`.
They are excluded from lint, format, typecheck and test. Read them; do not import them.

- **`raycast-parity.ts`** — the load-bearing one. Runs a CPU raycaster and a GLSL raycaster over the
  same volume and camera and compares them pixel by pixel. As committed it reports **zero**
  colour and normal differences on five cameras, on both the NVIDIA driver and SwiftShader.
  It already contains the camera-basis snap and the finite-sentinel rules from techstack.md §2 —
  the version without them disagreed on the axis-aligned side view and lost a fifth of the model.
- **`cpu-raycast-bench.ts`** — where the "3.5 ms for a 128x128 sprite from a 128³ model" number
  comes from.
- **`gpu-bench.ts`** — where the headless-Chromium flags and the 1.21 ms vs 61.7 ms number come
  from.

- **`gen-clip.ts`** and **`clip_rank.py`** — the local-AI spike. Generates N candidates against the
  live llama-server, rasterises them, renders four views each with the CPU raycaster and writes them
  to `out/gen-clip/`; the Python half ranks those PNGs with CLIP. This is what settled that CLIP can
  read the *new* renderer's pictures, which is why `py/clipserve.py` holds no rasteriser. It also
  produced the six candidates the fill-sign change in `src/gen/score.ts` was measured on.

Run them with `bun docs/spikes/<file>.ts`. The two GPU ones need `playwright`; `gen-clip.ts` needs
llama-server on :8080, and `clip_rank.py` needs `.venv`.
