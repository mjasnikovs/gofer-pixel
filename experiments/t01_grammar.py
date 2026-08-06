"""TEST 1: GBNF grammar-constrained grid emission.
If malformed rows are impossible, do we get art or well-formed noise?"""
import json, urllib.request, re
from llm import URL, REC

W = H = 24
GRAMMAR = f'root ::= row{{{H}}}\nrow ::= [0-7]{{{W}}} "\\n"\n'

SUBJ = "a small green slime monster with one big eye, side view"
P = (f"Draw a {W}x{H} pixel sprite: {SUBJ}\n"
     "Palette digits: 0=transparent 1=outline 2=mid 3=light 4=highlight "
     "5=eye 6=accent 7=shadow\n"
     f"Output exactly {H} lines of exactly {W} digits.")

def call(grammar=None, seed=1, extra=None, prompt=P):
    body = {"messages": [{"role": "user", "content": prompt}],
            "max_tokens": 1400, "seed": seed}
    body.update(REC)
    if extra: body.update(extra)
    if grammar: body["grammar"] = grammar
    req = urllib.request.Request(URL, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as r:
        return json.load(r)

def show(t, label):
    ls = [l for l in t.strip().splitlines() if re.fullmatch(r"[0-7]+", l)]
    widths = sorted({len(l) for l in ls})
    nz = sum(1 for l in ls for c in l if c != "0")
    filled_rows = sum(1 for l in ls if set(l) != {"0"})
    print(f"\n### {label}: lines={len(ls)} widths={widths} nonzero={nz} "
          f"rows_with_content={filled_rows}")
    for l in ls[:H]:
        print("   " + l.replace("0", "."))
    return nz, widths, len(ls)

print("grammar =", repr(GRAMMAR))
for seed in (1, 2, 3):
    try:
        d = call(GRAMMAR, seed)
        show(d["choices"][0]["message"]["content"], f"T1 grammar seed={seed} "
             f"tok={d['usage']['completion_tokens']}")
    except Exception as e:
        print("T1 grammar ERROR:", e)
        break
