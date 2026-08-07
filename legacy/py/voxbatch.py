"""Generate N candidates, rank them, export the winner.

This is the pipeline that survived testing. The model never draws pixels and
never judges its own work -- it emits primitives, we rasterise them, CLIP picks
the best of the batch, and the export is deterministic code.

  voxbatch.py "a red pickup truck" 12 out/truck
"""

import sys
import traceback
from pathlib import Path

import voxgen
import voxrank
import voxrender
import voxslice


def generate(prompt, n, temperature=0.8):
    """N independent attempts. Parse failures are dropped, not retried."""
    out = []
    for i in range(n):
        messages = [
            {"role": "system", "content": voxgen.SYSTEM},
            {"role": "user", "content": prompt},
        ]
        try:
            spec = voxgen.parse_model(voxgen.ask(messages, temperature))
            grid, palette = voxgen.rasterise(spec)
            if not grid:
                print(f"  {i + 1}/{n}: empty model, dropped")
                continue
            out.append((spec, grid, palette))
            print(f"  {i + 1}/{n}: {spec.get('name', '?')}, {len(grid)} voxels")
        except Exception as e:
            print(f"  {i + 1}/{n}: {type(e).__name__}: {str(e)[:60]}")
    return out


def export(spec, grid, palette, prefix, steps=8, scale=4):
    Path(prefix).parent.mkdir(parents=True, exist_ok=True)
    size = spec["size"]
    voxgen.write_vox(f"{prefix}.vox", size, grid, palette)
    layers = voxslice.slice_layers(size, grid, palette, scale)
    voxslice.write_png(f"{prefix}_sheet.png", *voxslice.compose_sheet(layers))
    alb, nrm = voxrender.rotation_sheet(size, grid, palette, steps, scale)
    voxslice.write_png(f"{prefix}_rot.png", *alb)
    voxslice.write_png(f"{prefix}_rot_n.png", *nrm)
    voxslice.write_png(f"{prefix}_rot_lit.png", *voxrender.light(alb, nrm))
    return f"{prefix}.vox"


def main():
    if len(sys.argv) < 2:
        print('usage: voxbatch.py "a red pickup truck" [n] [out_prefix] [steps]')
        return 1
    prompt = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    prefix = sys.argv[3] if len(sys.argv) > 3 else "out/gen"
    steps = int(sys.argv[4]) if len(sys.argv) > 4 else 8

    print(f'generating {n} candidates for "{prompt}"')
    cands = generate(prompt, n)
    if not cands:
        print("no usable candidates")
        return 1

    clip_prompt = f"pixel art sprite of {prompt}"
    print(f'ranking {len(cands)} candidates against "{clip_prompt}"')
    scored = []
    for i, (spec, grid, palette) in enumerate(cands):
        try:
            s = voxrank.score_model(spec["size"], grid, palette, clip_prompt)
        except Exception:
            traceback.print_exc()
            return 1
        scored.append((s, i))
        print(f"  {i + 1}: {s:.4f}")
    scored.sort(reverse=True)

    best_s, best_i = scored[0]
    spec, grid, palette = cands[best_i]
    export(spec, grid, palette, prefix, steps)
    print(f"\nwinner: candidate {best_i + 1}, clip={best_s:.4f}, {len(grid)} voxels")
    print(f"wrote {prefix}.vox {prefix}_sheet.png {prefix}_rot.png "
          f"{prefix}_rot_n.png {prefix}_rot_lit.png")

    # keep the worst one too, so the ranking stays auditable
    worst_s, worst_i = scored[-1]
    spec, grid, palette = cands[worst_i]
    export(spec, grid, palette, f"{prefix}_worst", steps)
    print(f"kept worst for comparison: clip={worst_s:.4f} -> {prefix}_worst_rot.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
