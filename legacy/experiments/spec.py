"""Spec-first generation: model declares what the asset should be, then builds it,
then code checks the build against the declaration."""
import json, re
from llm import chat, msg_text, REC
from vox import Vox
from score import components

PAL = ("1=near-black 2=dark-purple 3=light-grey-purple 4=white 5=red 6=gold "
       "7=green 8=blue 9=brown-wood")

SPEC_SCHEMA = """{
 "pieces": "one" | "few" | "many",        // one solid mass, 2-5 parts, or scattered
 "grounded": true|false,                   // touches z=0
 "symmetric": true|false,                  // mirror-symmetric left/right
 "proportion": "tall" | "square" | "wide",
 "protrusion": true|false,                 // a thin part sticking out of the mass
 "hollow": true|false,
 "colors": [ints],                         // palette entries that must appear
 "must_read_as": "short phrase"
}"""

def get_spec(subj, seed=1):
    p = (f"You will sculpt a voxel model of: {subj}\n"
         f"FIRST declare what it must look like, as JSON matching:\n{SPEC_SCHEMA}\n"
         "Describe the subject honestly - scattered things are \"many\" pieces and not "
         "grounded; machines are asymmetric with protrusions. JSON only.")
    d = chat([{"role": "user", "content": p}], max_tokens=600, seed=seed, sampler=REC)
    m = re.search(r"\{.*\}", msg_text(d), re.S)
    return json.loads(m.group(0)) if m else None

def build(subj, spec, seed=1):
    p = (f"Sculpt a voxel model in a 16x16x16 grid (x right, y depth, z UP, z=0 ground) "
         f"of: {subj}\nPalette: {PAL}\n"
         f"It MUST satisfy this spec:\n{json.dumps(spec)}\n"
         'Output ONLY a JSON array of boxes: '
         '[{"x0":..,"y0":..,"z0":..,"x1":..,"y1":..,"z1":..,"c":..}, ...]')
    d = chat([{"role": "user", "content": p}], max_tokens=2500, seed=seed, sampler=REC)
    v = Vox(16, 16, 16)
    m = re.search(r"\[.*\]", msg_text(d), re.S)
    if m:
        try:
            for b in json.loads(m.group(0)):
                v.box(b["x0"], b["y0"], b["z0"], b["x1"], b["y1"], b["z1"], b["c"])
        except Exception:
            pass
    return v

def check(v, spec):
    """Return list of (rule, passed). Pure code, no model."""
    out = []
    if not v.v:
        return [("nonempty", False)]
    out.append(("nonempty", True))
    st = v.stats(); x0, y0, z0, x1, y1, z1 = st["bbox"]
    w, dpth, h = x1-x0+1, y1-y0+1, z1-z0+1
    comps = components(v)

    want = spec.get("pieces")
    if want == "one":   out.append(("pieces=one", comps == 1))
    elif want == "few": out.append(("pieces=few", 2 <= comps <= 5))
    elif want == "many":out.append(("pieces=many", comps >= 6))

    if "grounded" in spec:
        out.append(("grounded", (z0 == 0) == bool(spec["grounded"])))

    if "symmetric" in spec:
        m = sum(1 for (x, y, z), c in v.v.items() if v.get(v.sx-1-x, y, z) == c)
        sym = m / len(v.v)
        out.append(("symmetric", (sym > 0.9) == bool(spec["symmetric"])))

    prop = spec.get("proportion")
    if prop:
        ratio = h / max(w, 1)
        got = "tall" if ratio > 1.25 else ("wide" if ratio < 0.8 else "square")
        out.append((f"proportion={prop}", got == prop))

    if spec.get("protrusion"):
        # a thin part: some layer whose area is <=25% of the largest layer's area
        areas = [sum(1 for p in v.v if p[2] == z) for z in range(v.sz)]
        areas = [a for a in areas if a]
        out.append(("protrusion", bool(areas) and min(areas) <= 0.25 * max(areas)))

    want_c = set(spec.get("colors") or [])
    if want_c:
        got_c = set(st["colors"])
        out.append(("colors", len(want_c & got_c) >= max(1, len(want_c) - 1)))
    return out
