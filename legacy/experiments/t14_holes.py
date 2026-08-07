"""TEST 14: rotation holes. Sweep angle x layer-repetition, measure gaps."""
import math
from vox import Vox, PALETTE
from PIL import Image

def render_naive(v, angle, dy):
    """Each layer drawn ONCE, spaced dy apart. This is the buggy form."""
    a = math.radians(angle); ca, sa = math.cos(a), math.sin(a)
    cx = cy = (v.sx - 1) / 2
    W = v.sx * 2; H = v.sy + v.sz * dy + 8
    canvas = [[0] * W for _ in range(H)]
    for z in range(v.sz):
        for (x, y, zz), c in v.v.items():
            if zz != z: continue
            rx = (x - cx) * ca - (y - cy) * sa + cx
            ry = (x - cx) * sa + (y - cy) * ca + cy
            px = int(round(rx)) + v.sx // 2
            py = int(round(ry)) + 4 + (v.sz - 1 - z) * dy
            if 0 <= px < W and 0 <= py < H:
                canvas[py][px] = c
    return canvas

def render(v, angle, rep, scale=1):
    """rep = how many times each z layer is drawn, 1px apart. This is the fix."""
    a = math.radians(angle); ca, sa = math.cos(a), math.sin(a)
    cx = cy = (v.sx - 1) / 2
    W = v.sx * 2; H = v.sy + v.sz * rep + 8
    canvas = [[0] * W for _ in range(H)]
    for z in range(v.sz):
        for k in range(rep):
            for (x, y, zz), c in v.v.items():
                if zz != z: continue
                rx = (x - cx) * ca - (y - cy) * sa + cx
                ry = (x - cx) * sa + (y - cy) * ca + cy
                px = int(round(rx)) + v.sx // 2
                py = int(round(ry)) + 4 + (v.sz - 1 - z) * rep - k
                if 0 <= px < W and 0 <= py < H:
                    canvas[py][px] = c
    return canvas

def holes(canvas):
    """Count transparent pixels fully enclosed by filled pixels (4-neighbour)."""
    H = len(canvas); W = len(canvas[0]); n = 0
    for y in range(1, H-1):
        for x in range(1, W-1):
            if canvas[y][x] == 0 and canvas[y-1][x] and canvas[y+1][x] \
               and canvas[y][x-1] and canvas[y][x+1]:
                n += 1
    return n

# A SOLID object never shows holes; the documented pitfall needs thin geometry
# and layers spaced further apart. Build a hollow tower with a thin mast.
solid = Vox(16, 16, 16)
solid.box(4, 4, 0, 11, 11, 9, 2)
solid.ellipsoid(7, 7, 11, 4, 4, 3, 6)

thin = Vox(16, 16, 16)
thin.box(3, 3, 0, 12, 12, 11, 2)          # hollow box: walls only
thin.clear_box(4, 4, 1, 11, 11, 11)
thin.box(7, 7, 12, 8, 8, 15, 5)           # 2x2 mast
thin.box(2, 7, 5, 13, 8, 5, 6)            # thin ledge

def sweep(v, name, dys, fn):
    print(f"\nholes for {name}, by angle x layer spacing (dy)")
    print("angle |" + "".join(f" dy{d:<3d}" for d in dys))
    for ang in (0, 15, 30, 45, 60, 75, 90):
        row = f"{ang:5d} |"
        for dy in dys:
            row += f" {holes(fn(v, ang, dy)):4d}"
        print(row)

print("########## NAIVE: each layer drawn once, spaced dy apart")
sweep(solid, "SOLID object", (1, 2, 3, 4), render_naive)
sweep(thin, "THIN-WALLED object", (1, 2, 3, 4), render_naive)
print("\n########## FIXED: each layer drawn dy times, 1px apart")
sweep(solid, "SOLID object", (1, 2, 3, 4), render)
sweep(thin, "THIN-WALLED object", (1, 2, 3, 4), render)
