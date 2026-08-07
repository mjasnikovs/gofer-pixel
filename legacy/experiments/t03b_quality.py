"""TEST 3b: grammar + DRY across subjects -> real PNGs to eyeball."""
import json, urllib.request, re
from llm import URL
from PIL import Image

W = H = 24
GRAMMAR = f'root ::= row{{{H}}}\nrow ::= [0-7]{{{W}}} "\\n"\n'
PAL = {0:(0,0,0,0),1:(26,20,32,255),2:(58,92,58,255),3:(96,150,90,255),
       4:(160,205,130,255),5:(240,240,245,255),6:(200,70,70,255),7:(38,30,48,255)}

CFG = dict(temperature=1.0, top_p=0.95, top_k=40, presence_penalty=1.5,
           repeat_penalty=1.0, dry_multiplier=0.8, dry_base=1.75,
           dry_allowed_length=24)

SUBJECTS = ["a green slime monster with one big eye, side view",
            "a wooden treasure chest with a gold lock, front view",
            "a knight helmet with a red plume, front view",
            "a potion bottle with glowing liquid, side view"]

def gen(subj, seed):
    p = (f"Draw a {W}x{H} pixel sprite: {subj}\n"
         "Palette digits: 0=transparent 1=dark outline 2=dark body 3=mid body "
         "4=light body 5=white highlight 6=red accent 7=shadow\n"
         f"Leave a 2px transparent margin. Output exactly {H} lines of {W} digits.")
    body = {"messages": [{"role": "user", "content": p}], "max_tokens": 1400,
            "seed": seed, "grammar": GRAMMAR}
    body.update(CFG)
    req = urllib.request.Request(URL, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as r:
        d = json.load(r)
    return d["choices"][0]["message"]["content"]

def to_img(t, scale=8):
    ls = [l for l in t.strip().splitlines() if re.fullmatch(r"[0-7]{%d}" % W, l)][:H]
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0)); px = im.load()
    for y, l in enumerate(ls):
        for x, c in enumerate(l):
            px[x, y] = PAL[int(c)]
    return im.resize((W*scale, H*scale), Image.NEAREST)

tiles = []
for subj in SUBJECTS:
    for seed in (1, 2, 3):
        t = gen(subj, seed)
        tiles.append(to_img(t))
        print(f"ok {subj[:30]:32s} seed={seed}")

cols = 3
tw, th = tiles[0].size
out = Image.new("RGBA", (cols*(tw+6)+6, ((len(tiles)+cols-1)//cols)*(th+6)+6),
                (30,30,36,255))
for i, t in enumerate(tiles):
    r, c = divmod(i, cols)
    out.alpha_composite(t, (6+c*(tw+6), 6+r*(th+6)))
out.save("t03b_grid.png")
print("wrote t03b_grid.png  (rows = subjects, cols = seeds)")
