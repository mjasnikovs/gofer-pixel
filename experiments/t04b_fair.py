"""TEST 4 (fair): image+text where text carries NO answer. Plus richer per-slice probes."""
import json, re
from llm import chat, msg_text, img_part, png_of, REC
from vox import sheet, grid_to_img
from t04_critic import SCENES, num, grid_text

Q = ("How many of the 16 slices contain at least one coloured shape? "
     "Answer with a single number only.")

def run(mode):
    hits, errs = 0, []
    for s, v in SCENES:
        truth = len({p[2] for p in v.v})
        if mode == "image":
            c = [img_part(png_of(sheet(v, 8, 4))), {"type": "text", "text":
                 "16 horizontal slices of a voxel model, slice 0 first. " + Q}]
        elif mode == "image_neutral":
            c = [img_part(png_of(sheet(v, 8, 4))), {"type": "text", "text":
                 "16 horizontal slices of a voxel model, slice 0 first, laid out "
                 "4 per row on a dark checkered background. " + Q}]
        elif mode == "image_leaky":
            c = [img_part(png_of(sheet(v, 8, 4))), {"type": "text", "text":
                 Q + f"\n\nModel stats: {json.dumps(v.stats())}"}]
        d = chat([{"role": "user", "content": c}], max_tokens=120, sampler=REC)
        got = num(msg_text(d)); errs.append(abs(got - truth)); hits += got == truth
    return hits, sum(errs) / len(errs)

for m in ("image", "image_neutral", "image_leaky"):
    h, e = run(m)
    print(f"  {m:14s} exact={h}/10  mean_abs_err={e:.1f}")

print("\n=== per-slice decomposition: count shapes in ONE slice ===")
hits = tot = 0
for s, v in SCENES[:6]:
    for z in (2, 6, 10):
        truth = len({c for row in v.slice_layer(z) for c in row if c})
        d = chat([{"role": "user", "content": [
            img_part(png_of(grid_to_img(v.slice_layer(z), 16))),
            {"type": "text", "text": "How many DISTINCT colours appear in this image, "
             "not counting the transparent/checkered background? Number only."}]}],
            max_tokens=30, sampler=REC)
        got = num(msg_text(d)); hits += got == truth; tot += 1
print(f"  distinct colours in a single slice: {hits}/{tot} exact")
