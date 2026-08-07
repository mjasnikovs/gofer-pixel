"""T20: the real job. N candidates for ONE prompt, CLIP ranks them.
Is CLIP's top-4 visibly better than its bottom-4?"""
import json, re, torch, open_clip
from PIL import Image, ImageDraw
from llm import chat, msg_text, REC
from vox import Vox, stacked, grid_to_img

SUBJ = "a red mushroom house with a door"
CLIP_TEXT = "pixel art sprite of a red mushroom house with a door"
N = 16

PAL = ("1=near-black 2=dark-purple 3=light-grey-purple 4=white 5=red 6=gold "
       "7=green 8=blue 9=brown-wood")

model, _, preprocess = open_clip.create_model_and_transforms(
    "ViT-B-32", pretrained="laion2b_s34b_b79k", device="cpu")
model.eval()
tok = open_clip.get_tokenizer("ViT-B-32")
with torch.no_grad():
    T = model.encode_text(tok([CLIP_TEXT]))
    T /= T.norm(dim=-1, keepdim=True)

def clip_score(im):
    im = im.convert("RGB").resize((224, 224), Image.NEAREST)
    with torch.no_grad():
        f = model.encode_image(preprocess(im).unsqueeze(0))
        f /= f.norm(dim=-1, keepdim=True)
        return float((f @ T.T)[0, 0])

def build(seed):
    p = (f"Sculpt a voxel model in a 16x16x16 grid (x right, y depth, z UP, z=0 ground) "
         f"of: {SUBJ}\nPalette: {PAL}\n"
         'Output ONLY a JSON array of boxes: '
         '[{"x0":..,"y0":..,"z0":..,"x1":..,"y1":..,"z1":..,"c":..}, ...]')
    d = chat([{"role": "user", "content": p}], max_tokens=2500, seed=seed, sampler=REC)
    v = Vox(16, 16, 16)
    m = re.search(r"\[.*\]", re.sub(r"//.*", "", msg_text(d)), re.S)
    if m:
        try:
            for b in json.loads(m.group(0)):
                v.box(b["x0"], b["y0"], b["z0"], b["x1"], b["y1"], b["z1"], b["c"])
        except Exception:
            pass
    return v

cands = []
for seed in range(1, N + 1):
    v = build(seed)
    if not v.v:
        print(f"seed{seed:3d}: empty, skipped"); continue
    # average the score over 4 viewing angles - one bad angle shouldn't sink an asset
    ims = [stacked(v, scale=6, dy=1, angle=a) for a in (0, 45, 90, 135)]
    ims.append(grid_to_img(v.side_view(), 10))
    s = sum(clip_score(i) for i in ims) / len(ims)
    cands.append((s, seed, v))
    print(f"seed{seed:3d}: clip={s:.4f}")

cands.sort(key=lambda t: -t[0])
print(f"\ntop:    {[ (round(s,3), sd) for s, sd, _ in cands[:4] ]}")
print(f"bottom: {[ (round(s,3), sd) for s, sd, _ in cands[-4:] ]}")

cell = 150; pad = 8; hdr = 14
rows = [("TOP-4 by CLIP", cands[:4]), ("BOTTOM-4 by CLIP", cands[-4:])]
out = Image.new("RGBA", (4*(cell+pad)+pad, 2*(cell+hdr+pad)+pad), (26, 26, 32, 255))
d = ImageDraw.Draw(out)
for r, (lbl, grp) in enumerate(rows):
    for c, (s, seed, v) in enumerate(grp):
        im = stacked(v, scale=5, dy=1, angle=25).convert("RGBA")
        im.thumbnail((cell, cell), Image.NEAREST)
        x, y = pad + c*(cell+pad), pad + r*(cell+hdr+pad)
        out.alpha_composite(im, (x+(cell-im.size[0])//2, y+(cell-im.size[1])//2))
        d.text((x+2, y+cell+1), f"{lbl if c==0 else ''} s{seed} {s:.3f}",
               fill=(200,230,200,255) if r == 0 else (240,180,180,255))
out.save("t20_bestof.png")
print("wrote t20_bestof.png (row1 = CLIP's best, row2 = CLIP's worst)")
