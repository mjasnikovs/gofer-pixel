"""Pure-code quality scorer for a voxel asset. No model in the loop.
Inspired by EvoCAD's use of topological metrics."""
from vox import Vox

def components(v):
    seen, comps = set(), 0
    for p in v.v:
        if p in seen: continue
        comps += 1; stack = [p]; seen.add(p)
        while stack:
            x, y, z = stack.pop()
            for d in ((1,0,0),(-1,0,0),(0,1,0),(0,-1,0),(0,0,1),(0,0,-1)):
                q = (x+d[0], y+d[1], z+d[2])
                if q in v.v and q not in seen:
                    seen.add(q); stack.append(q)
    return comps

def euler(v):
    """V - E + F on the voxel complex: a cheap topology signature."""
    V = len(v.v)
    E = sum(1 for (x,y,z) in v.v for d in ((1,0,0),(0,1,0),(0,0,1))
            if (x+d[0], y+d[1], z+d[2]) in v.v)
    F = 0
    for (x,y,z) in v.v:
        for a,b in (((1,0,0),(0,1,0)), ((1,0,0),(0,0,1)), ((0,1,0),(0,0,1))):
            if all(((x+a[0]*i+b[0]*j, y+a[1]*i+b[1]*j, z+a[2]*i+b[2]*j) in v.v)
                   for i,j in ((1,0),(0,1),(1,1))):
                F += 1
    return V - E + F

def symmetry(v):
    if not v.v: return 0.0
    m = sum(1 for (x,y,z), c in v.v.items() if v.get(v.sx-1-x, y, z) == c)
    return m / len(v.v)

def side_fill(v):
    sv = v.side_view()
    on = sum(1 for r in sv for c in r if c)
    return on / (v.sx * v.sz)

def score(v):
    if not v.v:
        return dict(total=0.0, reason="empty")
    st = v.stats()
    x0,y0,z0,x1,y1,z1 = st["bbox"]
    bb = (x1-x0+1)*(y1-y0+1)*(z1-z0+1)
    density = len(v.v)/bb
    comps = components(v)
    s = dict(
        voxels=len(v.v), components=comps, euler=euler(v),
        symmetry=round(symmetry(v), 3), density=round(density, 3),
        side_fill=round(side_fill(v), 3), colors=len(st["colors"]),
        layers=len(st["layers_used"]),
        grounded=int(z0 == 0),
    )
    # readable asset: one connected mass, uses vertical space, not a solid brick,
    # not a wisp, several colours, sits on the ground
    s["total"] = round(
        1.6 * (comps == 1)
        + 1.2 * min(s["layers"] / 10, 1.0)
        + 1.2 * (1.0 if 0.10 <= s["side_fill"] <= 0.55 else 0.0)
        + 1.0 * (1.0 if 0.25 <= density <= 0.85 else 0.0)
        + 0.8 * min(s["colors"] / 4, 1.0)
        + 0.6 * s["symmetry"]
        + 0.6 * s["grounded"], 3)
    return s
