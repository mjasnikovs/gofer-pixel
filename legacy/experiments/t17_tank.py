"""T17: fix the machine/vehicle failure.
Literature says: front-back reversal is systematic, few-shot 3D examples help most,
2.5-D layer decomposition prevents most errors, explicit reference frames disambiguate."""
import json, re
from llm import chat, msg_text, REC
from vox import Vox, stacked, grid_to_img
from PIL import Image, ImageDraw

PAL = ("1=near-black 2=dark-purple 3=light-grey-purple 4=white 5=red 6=gold "
       "7=green 8=blue 9=brown-wood")
SUBJ = "a battle tank with a long gun barrel"

FRAME = ("Grid 16x16x16. x=0 LEFT, x=15 RIGHT. y=0 is the FRONT of the model "
         "(the direction it faces), y=15 is the BACK. z=0 is the GROUND, z=15 is UP.")

# a worked example, in the exact output format, of a DIFFERENT directional machine
FEWSHOT = """Worked example - "a small delivery cart facing forward":
[
 {"x0":4,"y0":3,"z0":0,"x1":11,"y1":12,"z1":1,"c":9},   // deck, sits on ground
 {"x0":3,"y0":4,"z0":1,"x1":3,"y1":6,"z1":3,"c":1},     // left front wheel
 {"x0":12,"y0":4,"z0":1,"x1":12,"y1":6,"z1":3,"c":1},   // right front wheel
 {"x0":5,"y0":8,"z0":2,"x1":10,"y1":12,"z1":6,"c":3},   // cargo box at the BACK
 {"x0":7,"y0":0,"z0":2,"x1":8,"y1":3,"z1":2,"c":1}      // shaft reaching to y=0, the FRONT
]
Note how the shaft runs from y=3 down to y=0 so it protrudes out of the FRONT,
and the cargo box sits at high y, the BACK."""

def gen(prompt, seed):
    d = chat([{"role": "user", "content": prompt}], max_tokens=2500, seed=seed,
             sampler=REC)
    v = Vox(16, 16, 16)
    m = re.search(r"\[.*\]", re.sub(r"//.*", "", msg_text(d)), re.S)
    if m:
        try:
            for b in json.loads(m.group(0)):
                v.box(b["x0"], b["y0"], b["z0"], b["x1"], b["y1"], b["z1"], b["c"])
        except Exception:
            pass
    return v

OUT = ('Output ONLY a JSON array of boxes: '
       '[{"x0":..,"y0":..,"z0":..,"x1":..,"y1":..,"z1":..,"c":..}, ...]')

CONDS = {
 "baseline": f"Sculpt a voxel model of: {SUBJ}\nGrid 16x16x16, z up.\nPalette: {PAL}\n{OUT}",

 "frame":    f"Sculpt a voxel model of: {SUBJ}\n{FRAME}\nPalette: {PAL}\n"
             f"The gun barrel MUST reach y=0 so it sticks out of the front.\n{OUT}",

 "fewshot":  f"{FRAME}\nPalette: {PAL}\n{FEWSHOT}\n\n"
             f"Now do the same for: {SUBJ}\n{OUT}",

 "layered":  f"Sculpt a voxel model of: {SUBJ}\n{FRAME}\nPalette: {PAL}\n"
             "Work bottom-up. First state in one line what occupies each height band: "
             "z0-1 (tracks), z2-4 (hull), z5-7 (turret), z8+ (details), and where the "
             "barrel runs in y. Then output the boxes.\n" + OUT,

 "both":     f"{FRAME}\nPalette: {PAL}\n{FEWSHOT}\n\n"
             f"Now do the same for: {SUBJ}\nWork bottom-up: tracks on the ground, hull "
             "above, turret on top, and the barrel running forward to y=0.\n" + OUT,
}

def barrel_ok(v):
    """Does something thin actually reach the front (low y) above ground?"""
    if not v.v: return False
    front = [p for p in v.v if p[1] <= 1 and p[2] >= 2]
    return len(front) > 0 and len(front) < 0.15 * len(v.v)

def wide(v):
    if not v.v: return False
    xs=[p[0] for p in v.v]; zs=[p[2] for p in v.v]
    return (max(zs)-min(zs)+1) < (max(xs)-min(xs)+1)

rows = []
for name, p in CONDS.items():
    hits = 0
    for seed in (1, 2, 3, 4):
        v = gen(p, seed)
        ok = bool(v.v) and barrel_ok(v) and wide(v)
        hits += ok
        rows.append((f"{name} s{seed}", v, ok))
    print(f"{name:9s} barrel-reaches-front AND wider-than-tall: {hits}/4")

cell = 130; cols = 4; pad = 8; hdr = 14
out = Image.new("RGBA", (cols*(cell+pad)+pad, ((len(rows)+cols-1)//cols)*(cell+hdr+pad)+pad),
                (26,26,32,255))
d = ImageDraw.Draw(out)
for i, (lbl, v, ok) in enumerate(rows):
    r, c = divmod(i, cols); x, y = pad+c*(cell+pad), pad+r*(cell+hdr+pad)
    d.rectangle([x-2,y-2,x+cell+2,y+cell+hdr+2], fill=(30,58,38,255) if ok else (60,30,34,255))
    im = stacked(v, scale=4, dy=1, angle=25).convert("RGBA"); im.thumbnail((cell,cell), Image.NEAREST)
    out.alpha_composite(im, (x+(cell-im.size[0])//2, y+(cell-im.size[1])//2))
    d.text((x+2, y+cell+1), lbl, fill=(220,220,220,255))
out.save("t17_tank.png"); print("wrote t17_tank.png")
