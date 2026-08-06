"""T18: parametric templates. Code guarantees the topology; the model only picks numbers.
The structure of a tank is knowledge WE have. Don't make the model rediscover it."""
import json, re
from llm import chat, msg_text, REC
from vox import Vox, stacked, grid_to_img
from PIL import Image, ImageDraw

def tank(p):
    v = Vox(16, 16, 16)
    hw = int(p["hull_w"]); hl = int(p["hull_len"]); hh = int(p["hull_h"])
    tw = int(p["track_w"]); th = int(p["track_h"])
    tur = int(p["turret_r"]); turh = int(p["turret_h"])
    bl = int(p["barrel_len"]); bt = int(p["barrel_thick"])
    cb, ct, cr, cd = p["c_body"], p["c_track"], p["c_turret"], p["c_detail"]
    cx, cy = 8, 8
    y0, y1 = cy - hl // 2, cy + hl // 2
    # tracks
    v.box(cx-hw//2-tw, y0, 0, cx-hw//2-1, y1, th, ct)
    v.box(cx+hw//2+1, y0, 0, cx+hw//2+tw, y1, th, ct)
    # hull
    v.box(cx-hw//2, y0, 1, cx+hw//2, y1, 1+hh, cb)
    # turret
    v.cylinder_z(cx, cy+1, 2+hh, 2+hh+turh, tur, cr)
    # barrel: runs FORWARD to low y, guaranteed by construction
    bz = 2 + hh + turh // 2
    v.box(cx-bt//2, max(0, cy+1-tur-bl), bz, cx+bt//2+ (1 if bt>1 else 0),
          cy+1-tur, bz, cd)
    v.mirror_x()
    return v

SCHEMA = """{"hull_w":6-10,"hull_len":8-12,"hull_h":1-3,"track_w":1-2,"track_h":1-3,
"turret_r":2-4,"turret_h":1-3,"barrel_len":3-6,"barrel_thick":1-2,
"c_body":1-9,"c_track":1-9,"c_turret":1-9,"c_detail":1-9}"""
PAL = ("1=near-black 2=dark-purple 3=light-grey-purple 4=white 5=red 6=gold "
       "7=green 8=blue 9=brown-wood")

VARIANTS = ["a heavy green battle tank", "a small fast scout tank",
            "a rusty brown desert tank", "a dark armoured siege tank"]

rows = []
for subj in VARIANTS:
    p = (f"Choose parameters for a voxel tank: {subj}\nPalette: {PAL}\n"
         f"Output ONLY JSON matching (values inside the given ranges):\n{SCHEMA}")
    d = chat([{"role": "user", "content": p}], max_tokens=500, seed=1, sampler=REC)
    m = re.search(r"\{.*\}", msg_text(d), re.S)
    try:
        params = json.loads(m.group(0))
        v = tank(params)
        print(f"{subj[:30]:32s} {json.dumps(params)[:130]}")
    except Exception as e:
        print(f"{subj[:30]:32s} FAIL {str(e)[:60]}"); continue
    rows.append((subj, v))

cell = 150; pad = 8; hdr = 14
out = Image.new("RGBA", (len(rows)*(cell+pad)+pad, 2*(cell+hdr+pad)+pad), (26,26,32,255))
dr = ImageDraw.Draw(out)
for i, (lbl, v) in enumerate(rows):
    for r, im in enumerate([stacked(v, scale=5, dy=1, angle=25).convert("RGBA"),
                            grid_to_img(v.side_view(), 8).convert("RGBA")]):
        im.thumbnail((cell, cell), Image.NEAREST)
        x, y = pad+i*(cell+pad), pad+r*(cell+hdr+pad)
        out.alpha_composite(im, (x+(cell-im.size[0])//2, y+(cell-im.size[1])//2))
        dr.text((x+2, y+cell+1), lbl[:22], fill=(220,220,220,255))
out.save("t18_template.png"); print("wrote t18_template.png (row1 stacked, row2 side)")
