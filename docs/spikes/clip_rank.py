"""Rank the PNGs `gen-clip.ts` wrote, with CLIP on the CPU.

The point of the spike: legacy ranked candidates by re-rasterising the op list in Python and
rendering it with the sprite stacker. If CLIP can read the CPU raycaster's own PNGs, Python holds
nothing but CLIP and the second rasteriser disappears.

    .venv/bin/python docs/spikes/clip_rank.py "a stone tower" out/gen-clip
"""

import glob
import os
import sys
import time


def main():
    prompt = sys.argv[1] if len(sys.argv) > 1 else "a stone tower"
    directory = sys.argv[2] if len(sys.argv) > 2 else "out/gen-clip"

    t0 = time.time()
    import open_clip
    import torch
    from PIL import Image

    model, _, preprocess = open_clip.create_model_and_transforms(
        "ViT-B-32", pretrained="laion2b_s34b_b79k", device="cpu"
    )
    model.eval()
    tokenizer = open_clip.get_tokenizer("ViT-B-32")
    print(f"loaded CLIP in {time.time() - t0:.1f}s")

    text = f"pixel art sprite of {prompt}"
    with torch.no_grad():
        t = model.encode_text(tokenizer([text]))
        t = t / t.norm(dim=-1, keepdim=True)

        groups = {}
        for path in sorted(glob.glob(os.path.join(directory, "*.png"))):
            groups.setdefault(os.path.basename(path).split("-")[0], []).append(path)

        rows = []
        for name, paths in groups.items():
            t1 = time.time()
            total = 0.0
            for path in paths:
                image = Image.open(path).convert("RGB").resize((224, 224), Image.NEAREST)
                f = model.encode_image(preprocess(image).unsqueeze(0))
                f = f / f.norm(dim=-1, keepdim=True)
                total += float((f @ t.T)[0, 0])
            rows.append((total / len(paths), name, time.time() - t1))

    rows.sort(reverse=True)
    for score, name, secs in rows:
        print(f"{score:.4f}  candidate {name}  ({len(groups[name])} views, {secs:.2f}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
