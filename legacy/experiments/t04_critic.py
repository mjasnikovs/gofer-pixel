"""TESTS 4/5/7: critic accuracy.
4 - image-only vs image+text vs text-only  (ASCIIEval predicts image-only wins)
5 - scale sweep
7 - one slice per image vs contact sheet
Auto-scored against exact ground truth from random voxel scenes."""
import random, json, re
from llm import chat, msg_text, img_part, png_of, REC
from vox import Vox, sheet, grid_to_img

def scene(seed):
    r = random.Random(seed)
    v = Vox(16, 16, 16)
    for _ in range(r.randint(2, 4)):
        x0, y0, z0 = r.randint(1, 8), r.randint(1, 8), r.randint(0, 8)
        v.box(x0, y0, z0, x0 + r.randint(2, 5), y0 + r.randint(2, 5),
              z0 + r.randint(1, 3), r.choice([1, 2, 3, 5, 6, 7, 8, 9]))
    return v

def num(t):
    m = re.findall(r"\d+", t or "")
    return int(m[0]) if m else -1

def grid_text(g):
    return "\n".join("".join(str(c) for c in row) for row in g)

SCENES = [(s, scene(s)) for s in range(101, 111)]

def ask_layers(v, mode, scale):
    truth = len({p[2] for p in v.v})
    q = ("Below are the 16 horizontal slices of a 16x16x16 voxel model, "
         "slice 0 first. How many of the 16 slices contain at least one coloured "
         "shape? Answer with a single number only.")
    if mode == "text":
        body = "\n\n".join(f"slice {z}:\n{grid_text(v.slice_layer(z))}"
                           for z in range(16))
        content = [{"type": "text", "text": q + "\n\n" + body}]
    elif mode == "image":
        content = [img_part(png_of(sheet(v, scale=scale, cols=4))),
                   {"type": "text", "text": q}]
    else:  # image+text stats
        st = v.stats()
        content = [img_part(png_of(sheet(v, scale=scale, cols=4))),
                   {"type": "text", "text": q + f"\n\nModel stats: {json.dumps(st)}"}]
    d = chat([{"role": "user", "content": content}], max_tokens=120, sampler=REC)
    return num(msg_text(d)), truth

print("=== TEST 4: modality, contact sheet @scale 8 ===")
for mode in ("image", "image_text", "text"):
    hits, errs = 0, []
    for s, v in SCENES:
        got, truth = ask_layers(v, mode, 8)
        errs.append(abs(got - truth)); hits += (got == truth)
    print(f"  {mode:11s} exact={hits}/10  mean_abs_err={sum(errs)/len(errs):.1f}")

print("\n=== TEST 5: scale sweep, image-only ===")
for sc in (2, 4, 8, 16):
    hits, errs = 0, []
    for s, v in SCENES:
        got, truth = ask_layers(v, "image", sc)
        errs.append(abs(got - truth)); hits += (got == truth)
    print(f"  scale={sc:2d}x  exact={hits}/10  mean_abs_err={sum(errs)/len(errs):.1f}")

print("\n=== TEST 7: one slice per image (is slice z empty?) ===")
hits = tot = 0
for s, v in SCENES[:5]:
    used = {p[2] for p in v.v}
    for z in (0, 4, 8, 12):
        im = grid_to_img(v.slice_layer(z), 16)
        d = chat([{"role": "user", "content": [img_part(png_of(im)),
                  {"type": "text", "text": "Does this 16x16 image contain any "
                   "non-transparent pixels? Answer YES or NO only."}]}],
                 max_tokens=20, sampler=REC)
        got = "YES" in msg_text(d).upper()
        hits += (got == (z in used)); tot += 1
print(f"  empty/non-empty single slice: {hits}/{tot} correct")
