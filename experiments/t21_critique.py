"""TEST 21: does an image-only critique pass actually improve the model?

PRODUCTION_PLAN.md §9 fix 2. `DESIGN_PROGRESS.md` records that showing the render back to the
model did not help — but that test fed the image *and* numeric stats together, which ASCIIEval
reports is the weaker middle condition (image-only > text+image > text-only). So the experiment
that was actually run is not the one the literature says should win. This runs all three.

Design:
  * one base model per prompt, generated with schema-constrained decoding (voxgen.VOX_SCHEMA)
  * the same base is then revised three times, once per condition:
      image        the stacked render + the revise instruction, nothing else
      image_stats  the render + the instruction + numeric stats  (the condition already tried)
      stats        the instruction + numeric stats, no image     (text-only control)
  * outcome is CLIP against the prompt, which is same-prompt ranking — the one thing
    `voxrank.py` is trustworthy for. A revision counts as a win if it beats its own base.

Usage: .venv/bin/python experiments/t21_critique.py [repeats]
"""

import base64
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import voxgen  # noqa: E402
import voxrank  # noqa: E402
import voxslice  # noqa: E402

PROMPTS = [
    "a stone tower",
    "a red mushroom",
    "a small oak tree",
    "a wooden barrel",
]

REVISE = """That is the sprite-stack render of your model (slices drawn bottom to top,
each one pixel higher, so it leans toward the viewer). Judge the silhouette and
proportions, then return the FULL corrected JSON."""

# With its own JSON in context the model overwhelmingly copies it back. This variant removes
# "return it unchanged" as an option, so the modalities can be compared on revisions that are
# actually revisions.
PUSH = """

The previous model is wrong in at least one way. Your reply must differ from it:
change the proportions, the ops or the colours so the render reads better."""

OUT = Path("out/critique")


def stats(size, grid, palette):
    """The numeric summary the earlier critique test fed alongside the image."""
    sx, sy, sz = size
    per_slice = [0] * sz
    xs, ys, zs = set(), set(), set()
    for (x, y, z), _ in grid.items():
        per_slice[z] += 1
        xs.add(x)
        ys.add(y)
        zs.add(z)
    used = len({c for c in grid.values()})
    return {
        "size": [sx, sy, sz],
        "voxels": len(grid),
        "colors_used": used,
        "filled_slices": sum(1 for n in per_slice if n),
        "voxels_per_slice": per_slice,
        "bbox": [
            [min(xs, default=0), min(ys, default=0), min(zs, default=0)],
            [max(xs, default=0), max(ys, default=0), max(zs, default=0)],
        ],
    }


def stacked_png(size, grid, palette, scale=4):
    layers = voxslice.slice_layers(size, grid, palette, scale)
    w, h, buf = voxslice.compose_stacked(layers, dy=scale)
    path = OUT / "tmp_stacked.png"
    voxslice.write_png(str(path), w, h, buf)
    return path.read_bytes()


def image_part(png):
    return {
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64," + base64.b64encode(png).decode()},
    }


def parse_free(text):
    """The old brace-matching parse, kept here only for the unconstrained arm of this test."""
    text = text.strip()
    start = text.index("{")
    depth = 0
    for i, ch in enumerate(text[start:], start):
        depth += (ch == "{") - (ch == "}")
        if depth == 0:
            return json.loads(text[start : i + 1])
    raise ValueError("no complete JSON object in reply")


def revise(prompt, spec, grid, palette, condition, constrained=True, push=False):
    png = stacked_png(spec["size"], grid, palette)
    numbers = json.dumps(stats(spec["size"], grid, palette))
    instruction = REVISE + (PUSH if push else "")
    if condition == "image":
        content = [image_part(png), {"type": "text", "text": instruction}]
    elif condition == "image_stats":
        content = [
            image_part(png),
            {"type": "text", "text": instruction + "\n\nModel stats: " + numbers},
        ]
    else:  # stats only, no image
        content = [{"type": "text", "text": instruction + "\n\nModel stats: " + numbers}]

    messages = [
        {"role": "system", "content": voxgen.SYSTEM},
        {"role": "user", "content": prompt},
        {"role": "assistant", "content": json.dumps(spec)},
        {"role": "user", "content": content},
    ]
    if constrained:
        return voxgen.parse_model(voxgen.ask(messages, temperature=0.4))
    # unconstrained: the grammar forbids prose, so the model cannot look at the picture and
    # think before it answers. This arm lets it, and pays the brace-matching parse for it.
    return parse_free(voxgen.ask(messages, temperature=0.4, schema=None))


def clip_of(spec, grid, palette, prompt):
    return voxrank.score_model(spec["size"], grid, palette, f"pixel art sprite of {prompt}")


def main():
    args = sys.argv[1:]
    push = "--push" in args
    repeats = int(next((a for a in args if not a.startswith("-")), "1"))
    OUT.mkdir(parents=True, exist_ok=True)
    conditions = ("image", "image_stats", "stats")
    arms = (
        [(condition, True, True) for condition in conditions]
        if push
        else [
            (condition, constrained, False)
            for constrained in (True, False)
            for condition in conditions
        ]
    )
    deltas = {arm: [] for arm in arms}
    failures = {arm: 0 for arm in arms}
    copies = {arm: 0 for arm in arms}

    for run in range(repeats):
        for prompt in PROMPTS:
            messages = [
                {"role": "system", "content": voxgen.SYSTEM},
                {"role": "user", "content": prompt},
            ]
            spec = voxgen.parse_model(voxgen.ask(messages, temperature=0.8))
            grid, palette = voxgen.rasterise(spec)
            if not grid:
                print(f"  {prompt}: empty base model, skipped")
                continue
            base = clip_of(spec, grid, palette, prompt)
            print(f"\n{prompt} (run {run + 1}) base clip={base:.4f} voxels={len(grid)}")

            for arm in arms:
                condition, constrained, pushed = arm
                label = (
                    f"{condition}{'' if constrained else ' (free)'}{' (push)' if pushed else ''}"
                )
                try:
                    revised = revise(
                        prompt, spec, grid, palette, condition, constrained, pushed
                    )
                    rgrid, rpalette = voxgen.rasterise(revised)
                    if not rgrid:
                        raise ValueError("revision produced no voxels")
                    after = clip_of(revised, rgrid, rpalette, prompt)
                except Exception as e:  # noqa: BLE001 - a failed revision is a result
                    failures[arm] += 1
                    print(f"  {label:19s} FAILED {type(e).__name__}: {str(e)[:50]}")
                    continue
                same = revised.get("ops") == spec.get("ops")
                copies[arm] += same
                deltas[arm].append(after - base)
                print(
                    f"  {label:19s} clip={after:.4f}  delta={after - base:+.4f}"
                    f"  voxels={len(rgrid)}{'  (unchanged ops)' if same else ''}"
                )

    print("\n=== summary ===")
    for arm in arms:
        condition, constrained, pushed = arm
        label = f"{condition}{'' if constrained else ' (free)'}{' (push)' if pushed else ''}"
        values = deltas[arm]
        if not values:
            print(f"  {label:19s} no usable revisions, failed {failures[arm]}")
            continue
        wins = sum(1 for v in values if v > 0)
        print(
            f"  {label:19s} mean delta={statistics.fmean(values):+.4f}  "
            f"median={statistics.median(values):+.4f}  "
            f"improved {wins}/{len(values)}  copied {copies[arm]}/{len(values)}  "
            f"failed {failures[arm]}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
