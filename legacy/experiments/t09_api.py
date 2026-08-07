"""TEST 9/10/12/13: builder API ablation + best-of-N + forced symmetry + subject classes.
Three ways to ask for the same voxel model, all executed by the same renderer."""
import json, re, sys
from llm import chat, msg_text, REC
from vox import Vox, stacked, grid_to_img
from score import score
import agent

PAL = ("1=near-black 2=dark-purple 3=light-grey-purple 4=white 5=red 6=gold "
       "7=green 8=blue 9=brown-wood")

SUBJECTS = {
 "organic":      "a red mushroom house with a round cap and a door",
 "architecture": "a small stone tower with battlements and a door",
 "vehicle":      "a battle tank with a long gun barrel pointing forward",
 "character":    "a chunky knight standing, with helmet and shield",
}

# --- variant A: raw JSON coordinate list (MineBench style) ---
def build_json(subj, seed, mirror=False):
    p = (f"Design a voxel model in a 16x16x16 grid (x right, y depth, z UP, z=0 ground) "
         f"of: {subj}\nPalette: {PAL}\n"
         "Output ONLY a JSON array of boxes: "
         '[{"x0":..,"y0":..,"z0":..,"x1":..,"y1":..,"z1":..,"c":..}, ...] '
         "Use 6-20 boxes. Bold readable shapes.")
    d = chat([{"role": "user", "content": p}], max_tokens=2500, seed=seed, sampler=REC)
    v = Vox(16, 16, 16)
    m = re.search(r"\[.*\]", msg_text(d), re.S)
    if m:
        try:
            for b in json.loads(m.group(0)):
                v.box(b["x0"], b["y0"], b["z0"], b["x1"], b["y1"], b["z1"], b["c"])
        except Exception as e:
            pass
    if mirror: v.mirror_x()
    return v

# --- variant B: one-shot program in a tiny DSL (OpenSCAD-ish) ---
DSL_DOC = """Commands, one per line:
box x0 y0 z0 x1 y1 z1 color
ell cx cy cz rx ry rz color
cyl cx cy z0 z1 r color
mirror
Coordinates 0..15 inclusive, z is UP, z=0 is the ground."""

def build_dsl(subj, seed, mirror=False):
    p = (f"Sculpt a voxel model of: {subj}\nGrid 16x16x16. Palette: {PAL}\n{DSL_DOC}\n"
         "Think briefly, then output the final program between <prog> and </prog>. "
         "Bold readable shapes, 6-20 commands.")
    d = chat([{"role": "user", "content": p}], max_tokens=2500, seed=seed, sampler=REC)
    t = msg_text(d)
    m = re.search(r"<prog>(.*?)</prog>", t, re.S)
    prog = m.group(1) if m else t
    v = Vox(16, 16, 16)
    for line in prog.splitlines():
        tok = line.strip().split()
        if not tok: continue
        try:
            if tok[0] == "box" and len(tok) >= 8:
                v.box(*[int(a) for a in tok[1:8]])
            elif tok[0] == "ell" and len(tok) >= 8:
                v.ellipsoid(*[int(a) for a in tok[1:8]])
            elif tok[0] == "cyl" and len(tok) >= 7:
                v.cylinder_z(*[int(a) for a in tok[1:7]])
            elif tok[0] == "mirror":
                v.mirror_x()
        except Exception:
            pass
    if mirror: v.mirror_x()
    return v

# --- variant C: interactive tool loop (already built) ---
def build_tools(subj, seed, mirror=False):
    agent.TOOLS = agent.TOOLS
    v, info = agent.run(subj, max_steps=12, seed=seed, verbose=False)
    if mirror: v.mirror_x()
    return v

VARIANTS = {"json": build_json, "dsl": build_dsl, "tools": build_tools}

if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "json,dsl"
    N = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    results = {}
    for vname in which.split(","):
        fn = VARIANTS[vname]
        for cls, subj in SUBJECTS.items():
            for mirror in (False, True):
                cands = []
                for seed in range(1, N + 1):
                    try:
                        v = fn(subj, seed, mirror)
                        cands.append((score(v).get("total", 0), seed, v))
                    except Exception as e:
                        print(f"   err {vname}/{cls}/{seed}: {str(e)[:70]}")
                if not cands: continue
                cands.sort(key=lambda t: -t[0])
                best, worst = cands[0], cands[-1]
                tag = f"{vname}_{cls}_{'mir' if mirror else 'raw'}"
                results[tag] = dict(best=best[0], worst=worst[0],
                                    mean=round(sum(c[0] for c in cands)/len(cands), 2),
                                    n=len(cands), best_seed=best[1],
                                    stats=score(best[2]))
                print(f"{tag:28s} best={best[0]:5.2f} mean={results[tag]['mean']:5.2f} "
                      f"worst={worst[0]:5.2f}  {json.dumps(score(best[2]))[:120]}")
                stacked(best[2], scale=7, dy=1, angle=25).save(f"t09_{tag}_stack.png")
                grid_to_img(best[2].side_view(), 9).save(f"t09_{tag}_side.png")
    json.dump(results, open(f"t09_results_{which.replace(',','_')}.json", "w"), indent=1)
    print("\nwrote t09 pngs + json")
