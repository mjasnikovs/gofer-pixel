"""TEST 15: voxel-exact normals vs height-map + Sobel baseline, compared in a lit scene."""
import math
from vox import Vox, grid_to_img, PALETTE
from PIL import Image

v = Vox(16, 16, 16)
v.box(3, 4, 0, 12, 11, 2, 2)
v.box(5, 5, 3, 10, 10, 6, 3)
v.ellipsoid(7, 7, 8, 4, 4, 3, 5)
v.box(7, 0, 4, 8, 5, 4, 1)

SX, SZ = v.sx, v.sz

def depth_map():
    """Nearest solid y per (x,z); None if empty. This is the true height field."""
    d = [[None] * SX for _ in range(SZ)]
    for x in range(SX):
        for z in range(SZ):
            for y in range(v.sy):
                if v.get(x, y, z):
                    d[SZ - 1 - z][x] = y; break
    return d

def exact_normals():
    return v.side_normals()

def sobel_normals(strength=2.0):
    d = depth_map()
    img = Image.new("RGBA", (SX, SZ), (0, 0, 0, 0)); px = img.load()
    def h(x, y):
        if 0 <= x < SX and 0 <= y < SZ and d[y][x] is not None:
            return -d[y][x]
        return None
    for y in range(SZ):
        for x in range(SX):
            if d[y][x] is None: continue
            def g(xx, yy):
                r = h(xx, yy); return r if r is not None else h(x, y)
            gx = ((g(x+1,y-1)+2*g(x+1,y)+g(x+1,y+1)) -
                  (g(x-1,y-1)+2*g(x-1,y)+g(x-1,y+1)))
            gy = ((g(x-1,y+1)+2*g(x,y+1)+g(x+1,y+1)) -
                  (g(x-1,y-1)+2*g(x,y-1)+g(x+1,y-1)))
            nx, ny, nz = -gx * strength, -gy * strength, 1.0
            ln = math.sqrt(nx*nx + ny*ny + nz*nz)
            px[x, y] = (int((nx/ln*.5+.5)*255), int((ny/ln*.5+.5)*255),
                        int((nz/ln*.5+.5)*255), 255)
    return img

def light(albedo, normals, lx, ly, lz):
    ln = math.sqrt(lx*lx+ly*ly+lz*lz); lx, ly, lz = lx/ln, ly/ln, lz/ln
    out = Image.new("RGBA", (SX, SZ), (0,0,0,0))
    a, n, o = albedo.load(), normals.load(), out.load()
    for y in range(SZ):
        for x in range(SX):
            if a[x, y][3] == 0: continue
            r, g, b, _ = n[x, y]
            nx, ny, nz = r/127.5-1, g/127.5-1, b/127.5-1
            d = max(0.0, nx*lx + ny*ly + nz*lz) * 0.85 + 0.25
            cr, cg, cb, ca = a[x, y]
            o[x, y] = (min(255,int(cr*d)), min(255,int(cg*d)), min(255,int(cb*d)), ca)
    return out

alb = grid_to_img(v.side_view(), 1)
ex, sb = exact_normals(), sobel_normals()
S = 8
tiles = []
for name, nm in (("exact", ex), ("sobel", sb)):
    row = [nm.resize((SX*S, SZ*S), Image.NEAREST)]
    for L in ((-1,-1,0.6), (0,-1,0.8), (1,-0.3,0.6)):
        row.append(light(alb, nm, *L).resize((SX*S, SZ*S), Image.NEAREST))
    tiles.append((name, row))

W = 4*(SX*S+6)+6; H = 2*(SZ*S+6)+6
out = Image.new("RGBA", (W, H), (26,26,32,255))
for r, (name, row) in enumerate(tiles):
    for c, im in enumerate(row):
        out.alpha_composite(im, (6+c*(SX*S+6), 6+r*(SZ*S+6)))
out.save("t15_normals.png")

diff = sum(1 for y in range(SZ) for x in range(SX)
           if ex.load()[x,y][3] and sb.load()[x,y][3]
           and max(abs(ex.load()[x,y][i]-sb.load()[x,y][i]) for i in range(3)) > 40)
tot = sum(1 for y in range(SZ) for x in range(SX) if ex.load()[x,y][3])
print(f"pixels where the two normal maps disagree by >40/255: {diff}/{tot}")
print("wrote t15_normals.png  (row1 exact, row2 sobel; col1 normal map, cols2-4 lit)")
