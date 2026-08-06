"""Generate a batch, spec-check it in code, lay it out as one keep/kill contact sheet."""
import json, sys
from PIL import Image, ImageDraw
from spec import get_spec, build, check
from vox import stacked, grid_to_img

SUBJECTS = [
 "a red mushroom house with a door",
 "a small stone tower with battlements",
 "a battle tank with a long gun barrel",
 "a chunky knight with helmet and shield",
 "a pile of confetti scattered on the ground",
 "a wooden treasure chest with a gold lock",
 "a leafy green tree with a brown trunk",
 "a campfire with logs and flames",
 "a blue crystal cluster growing from rock",
 "a wooden barrel",
]
SEEDS = [1, 2, 3, 4, 5]

def run():
    rows = []
    for subj in SUBJECTS:
        spec = None
        for s in (1, 2):
            try:
                spec = get_spec(subj, s); break
            except Exception as e:
                print(f"  spec fail {subj[:24]}: {str(e)[:50]}")
        if not spec:
            continue
        print(f"\n{subj[:38]:40s} spec={json.dumps(spec)[:110]}")
        for seed in SEEDS:
            try:
                v = build(subj, spec, seed)
            except Exception as e:
                print(f"   seed{seed} build error {str(e)[:50]}"); continue
            res = check(v, spec)
            passed = sum(1 for _, ok in res if ok); total = len(res)
            fails = [r for r, ok in res if not ok]
            print(f"   seed{seed}: {passed}/{total} " +
                  (f"FAIL:{','.join(fails)}" if fails else "PASS"))
            rows.append(dict(subj=subj, seed=seed, v=v, passed=passed, total=total,
                             fails=fails, spec=spec))
    return rows

def contact_sheet(rows, path="batch_sheet.png", cols=5, cell=120):
    n = len(rows); r = (n + cols - 1) // cols
    pad, hdr = 8, 16
    out = Image.new("RGBA", (cols*(cell+pad)+pad, r*(cell+hdr+pad)+pad), (26,26,32,255))
    d = ImageDraw.Draw(out)
    for i, row in enumerate(rows):
        rr, cc = divmod(i, cols)
        x, y = pad + cc*(cell+pad), pad + rr*(cell+hdr+pad)
        im = stacked(row["v"], scale=4, dy=1, angle=25).convert("RGBA")
        im.thumbnail((cell, cell), Image.NEAREST)
        ok = not row["fails"]
        d.rectangle([x-2, y-2, x+cell+2, y+cell+hdr+2],
                    fill=(30,58,38,255) if ok else (66,30,34,255))
        out.alpha_composite(im, (x + (cell-im.size[0])//2, y + (cell-im.size[1])//2))
        d.text((x+2, y+cell+2),
               f"{'OK ' if ok else 'X  '}{row['subj'][:14]} s{row['seed']}",
               fill=(200,230,200,255) if ok else (240,180,180,255))
    out.save(path)
    return path

if __name__ == "__main__":
    rows = run()
    p = contact_sheet(rows)
    ok = sum(1 for r in rows if not r["fails"])
    print(f"\n==== {ok}/{len(rows)} passed their own spec. wrote {p}")
    json.dump([{k: v for k, v in r.items() if k != "v"} for r in rows],
              open("batch_results.json", "w"), indent=1, default=str)
