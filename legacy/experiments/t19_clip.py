"""T19: can CLIP rank our pixel-art renders?
Two questions:
  (a) RETRIEVAL - given a render, does the correct subject text win over the others?
  (b) QUALITY  - does CLIP agree with my eyeball good/bad calls?
Ground truth for (b) is my own judgement recorded in DESIGN_PROGRESS, stated here."""
import glob, os, torch, open_clip
from PIL import Image

DEV = "cpu"
model, _, preprocess = open_clip.create_model_and_transforms(
    "ViT-B-32", pretrained="laion2b_s34b_b79k", device=DEV)
model.eval()
tok = open_clip.get_tokenizer("ViT-B-32")
print("CLIP ViT-B-32 loaded on CPU")

CLASSES = {
 "organic":      "pixel art of a red mushroom house with a door",
 "architecture": "pixel art of a stone tower with battlements",
 "vehicle":      "pixel art of a battle tank with a gun barrel",
 "character":    "pixel art of a knight with a helmet and shield",
}
KEYS = list(CLASSES)
with torch.no_grad():
    T = model.encode_text(tok([CLASSES[k] for k in KEYS]).to(DEV))
    T /= T.norm(dim=-1, keepdim=True)

# my eyeball verdicts from the t09 contact sheet
GOOD = {"json_organic", "json_architecture", "json_character",
        "dsl_organic", "dsl_architecture", "dsl_vehicle"}
BAD  = {"json_vehicle", "dsl_character"}

def embed(path, upscale=224):
    im = Image.open(path).convert("RGB")
    im = im.resize((upscale, upscale), Image.NEAREST)
    with torch.no_grad():
        f = model.encode_image(preprocess(im).unsqueeze(0).to(DEV))
        return f / f.norm(dim=-1, keepdim=True)

for view in ("side", "stack"):
    files = sorted(glob.glob(f"t09_*_{view}.png"))
    hits = 0; scores = {}
    print(f"\n===== {view} view ({len(files)} images) =====")
    for f in files:
        b = os.path.basename(f).replace("t09_", "").replace(f"_{view}.png", "")
        parts = b.split("_")
        if len(parts) != 3:
            continue
        variant, cls, mir = parts
        I = embed(f)
        sim = (I @ T.T)[0]
        pred = KEYS[int(sim.argmax())]
        hits += pred == cls
        own = float(sim[KEYS.index(cls)])
        scores[f"{variant}_{cls}"] = max(scores.get(f"{variant}_{cls}", -9), own)
        print(f"  {b:28s} true={cls:12s} pred={pred:12s} "
              f"{'OK' if pred==cls else '  '}  own_score={own:.3f}")
    print(f"  retrieval accuracy: {hits}/{len(files)} (chance = {len(files)//4})")

    g = [v for k, v in scores.items() if k in GOOD]
    bd = [v for k, v in scores.items() if k in BAD]
    if g and bd:
        print(f"  mean score  GOOD={sum(g)/len(g):.3f}  BAD={sum(bd)/len(bd):.3f}  "
              f"separated={'YES' if min(g) > max(bd) else 'NO'}")
