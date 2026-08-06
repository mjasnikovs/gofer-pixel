"""Rank candidate models by how much their render looks like the prompt.

The model produces junk maybe half the time, so something has to pick the good
one out of N. Code metrics do not work for this -- connectivity, symmetry,
density and topology all rate an unreadable tank the same as a good mushroom.
CLIP does work: given 16 candidates for one prompt, its top four all had a cap
on a stem and its bottom four were a slab, a stick, a stemless blob and a plain
rectangle.

One limit worth knowing: it only ranks candidates for the SAME prompt. Scores
are not comparable across subjects -- a good stone tower scores below a
mediocre mushroom.

Needs torch + open_clip. Runs on CPU in about a second per candidate, so it
does not compete with the llama-server for VRAM.
"""

import sys

_MODEL = None


def _load():
    global _MODEL
    if _MODEL is None:
        import open_clip
        import torch

        model, _, preprocess = open_clip.create_model_and_transforms(
            "ViT-B-32", pretrained="laion2b_s34b_b79k", device="cpu"
        )
        model.eval()
        _MODEL = (model, preprocess, open_clip.get_tokenizer("ViT-B-32"), torch)
    return _MODEL


def _to_pil(buf):
    """voxslice (w, h, bytearray) -> a 224x224 RGB PIL image on a neutral field."""
    from PIL import Image

    w, h, rgba = buf
    im = Image.frombytes("RGBA", (w, h), bytes(rgba))
    flat = Image.new("RGBA", (w, h), (128, 128, 128, 255))
    flat.alpha_composite(im)
    return flat.convert("RGB").resize((224, 224), Image.NEAREST)


def score(buffers, prompt):
    """Mean CLIP similarity of several renders of one model against the prompt.

    Averaging over angles matters -- a single unlucky view sinks a good asset.
    """
    model, preprocess, tokenizer, torch = _load()
    with torch.no_grad():
        t = model.encode_text(tokenizer([prompt]))
        t = t / t.norm(dim=-1, keepdim=True)
        total = 0.0
        for buf in buffers:
            im = preprocess(_to_pil(buf)).unsqueeze(0)
            f = model.encode_image(im)
            f = f / f.norm(dim=-1, keepdim=True)
            total += float((f @ t.T)[0, 0])
    return total / len(buffers)


def score_model(size, voxels, palette, prompt, angles=(0, 45, 90, 135), scale=4):
    """Score a voxel model directly, rendering the views it needs."""
    import voxrender

    views = [
        voxrender.render_angle(size, voxels, palette, a, scale)[0]
        for a in angles
    ]
    return score(views, prompt)


def main():
    if len(sys.argv) < 3:
        print('usage: voxrank.py "pixel art of a red truck" a.vox b.vox ...')
        return 1
    import voxslice

    prompt = sys.argv[1]
    ranked = []
    for path in sys.argv[2:]:
        size, voxels, palette = voxslice.read_vox(path)
        ranked.append((score_model(size, voxels, palette, prompt), path))
    ranked.sort(reverse=True)
    for s, path in ranked:
        print(f"{s:.4f}  {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
