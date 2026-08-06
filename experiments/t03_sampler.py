"""TEST 3: kill the blank-canvas / row-repeat attractor. Grammar always on."""
import json, urllib.request, re, itertools
from llm import URL

W = H = 24
GRAMMAR = f'root ::= row{{{H}}}\nrow ::= [0-7]{{{W}}} "\\n"\n'
SUBJ = "a small green slime monster with one big eye, side view"
P = (f"Draw a {W}x{H} pixel sprite: {SUBJ}\n"
     "Palette digits: 0=transparent 1=outline 2=mid 3=light 4=highlight "
     "5=eye 6=accent 7=shadow\n"
     f"Output exactly {H} lines of exactly {W} digits.")

BASE = dict(temperature=0.7, top_p=0.8, top_k=20, presence_penalty=1.5,
            repeat_penalty=1.0, min_p=0.0, dry_multiplier=0.0)

CFGS = {
 "baseline":        {},
 "no_presence":     dict(presence_penalty=0.0),
 "minp":            dict(min_p=0.05, top_p=1.0, top_k=0),
 "dry":             dict(dry_multiplier=0.8, dry_base=1.75, dry_allowed_length=24),
 "dry_strong":      dict(dry_multiplier=1.5, dry_base=1.75, dry_allowed_length=12),
 "hot":             dict(temperature=1.0, top_p=0.95, top_k=40),
 "hot_dry":         dict(temperature=1.0, top_p=0.95, top_k=40,
                         dry_multiplier=0.8, dry_base=1.75, dry_allowed_length=24),
 "rep_pen":         dict(repeat_penalty=1.05, repeat_last_n=64),
}

def call(cfg, seed):
    body = {"messages": [{"role": "user", "content": P}], "max_tokens": 1400,
            "seed": seed, "grammar": GRAMMAR}
    body.update(BASE); body.update(cfg)
    req = urllib.request.Request(URL, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as r:
        return json.load(r)

def score(t):
    ls = [l for l in t.strip().splitlines() if re.fullmatch(r"[0-7]{%d}" % W, l)]
    if len(ls) != H:
        return dict(ok=False, reason="geometry")
    nz = sum(1 for l in ls for c in l if c != "0")
    content_rows = [l for l in ls if set(l) != {"0"}]
    distinct = len(set(content_rows))
    maxrep = max([content_rows.count(l) for l in set(content_rows)] or [0])
    cols = [sum(1 for l in ls if l[x] != "0") for x in range(W)]
    return dict(ok=True, nonzero=nz, content_rows=len(content_rows),
                distinct_rows=distinct, max_row_repeat=maxrep,
                colors=len({c for l in ls for c in l if c != "0"}),
                good=(nz > 60 and distinct >= 8 and maxrep <= 4))

best = {}
for name, cfg in CFGS.items():
    res = []
    for seed in (1, 2, 3, 4):
        try:
            d = call(cfg, seed)
            s = score(d["choices"][0]["message"]["content"])
            s["_text"] = d["choices"][0]["message"]["content"]
            res.append(s)
        except Exception as e:
            res.append(dict(ok=False, reason=str(e)[:60]))
    ng = sum(1 for r in res if r.get("good"))
    print(f"{name:12s} good={ng}/4  " + " | ".join(
        f"nz={r.get('nonzero','-')},d={r.get('distinct_rows','-')},"
        f"rep={r.get('max_row_repeat','-')}" for r in res))
    best[name] = (ng, res)

print("\n===== best config samples =====")
for name, (ng, res) in sorted(best.items(), key=lambda kv: -kv[1][0])[:2]:
    print(f"\n--- {name} ({ng}/4)")
    for r in res:
        if r.get("good"):
            for l in r["_text"].strip().splitlines()[:H]:
                print("   " + l.replace("0", "."))
            break
