"""Deterministic voxel model + sprite-stack / side-view / normal-map renderer.
No AI. This is the ground truth the model is supposed to author."""
from PIL import Image

PALETTE = {
    0: (0, 0, 0, 0),        # empty
    1: (28, 20, 36, 255),   # dark
    2: (68, 56, 84, 255),   # steel
    3: (120, 104, 132, 255),# light steel
    4: (200, 196, 210, 255),# white
    5: (176, 48, 60, 255),  # red
    6: (232, 160, 48, 255), # gold
    7: (56, 132, 84, 255),  # green
    8: (48, 108, 176, 255), # blue
    9: (140, 88, 48, 255),  # wood
}

class Vox:
    def __init__(self, sx=16, sy=16, sz=16):
        self.sx, self.sy, self.sz = sx, sy, sz
        self.v = {}

    def inb(self, x, y, z):
        return 0 <= x < self.sx and 0 <= y < self.sy and 0 <= z < self.sz

    def set(self, x, y, z, c):
        if self.inb(x, y, z):
            if c == 0:
                self.v.pop((x, y, z), None)
            else:
                self.v[(x, y, z)] = c

    def get(self, x, y, z):
        return self.v.get((x, y, z), 0)

    # --- ops the model can call ---
    def box(self, x0, y0, z0, x1, y1, z1, color):
        n = 0
        for x in range(min(x0, x1), max(x0, x1) + 1):
            for y in range(min(y0, y1), max(y0, y1) + 1):
                for z in range(min(z0, z1), max(z0, z1) + 1):
                    if self.inb(x, y, z):
                        self.set(x, y, z, color); n += 1
        return n

    def ellipsoid(self, cx, cy, cz, rx, ry, rz, color):
        n = 0
        for x in range(self.sx):
            for y in range(self.sy):
                for z in range(self.sz):
                    dx = (x - cx) / max(rx, .5); dy = (y - cy) / max(ry, .5); dz = (z - cz) / max(rz, .5)
                    if dx*dx + dy*dy + dz*dz <= 1.0:
                        self.set(x, y, z, color); n += 1
        return n

    def cylinder_z(self, cx, cy, z0, z1, r, color):
        n = 0
        for x in range(self.sx):
            for y in range(self.sy):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                    for z in range(min(z0, z1), max(z0, z1) + 1):
                        if self.inb(x, y, z):
                            self.set(x, y, z, color); n += 1
        return n

    def mirror_x(self):
        """Mirror everything from x < sx/2 onto the other half. Guarantees symmetry."""
        n = 0
        for (x, y, z), c in list(self.v.items()):
            if x < self.sx / 2:
                mx = self.sx - 1 - x
                if self.get(mx, y, z) != c:
                    self.set(mx, y, z, c); n += 1
        return n

    def clear_box(self, x0, y0, z0, x1, y1, z1):
        return self.box(x0, y0, z0, x1, y1, z1, 0)

    # --- derived data ---
    def stats(self):
        if not self.v:
            return dict(voxels=0)
        xs = [p[0] for p in self.v]; ys = [p[1] for p in self.v]; zs = [p[2] for p in self.v]
        return dict(voxels=len(self.v),
                    bbox=[min(xs), min(ys), min(zs), max(xs), max(ys), max(zs)],
                    layers_used=sorted({p[2] for p in self.v}),
                    colors=sorted({c for c in self.v.values()}))

    def slice_layer(self, z):
        """Top-down slice at height z -> 2D grid [y][x]."""
        return [[self.get(x, y, z) for x in range(self.sx)] for y in range(self.sy)]

    def side_view(self):
        """Orthographic side view (look along -y): nearest solid voxel per (x,z)."""
        out = [[0] * self.sx for _ in range(self.sz)]
        for x in range(self.sx):
            for z in range(self.sz):
                for y in range(self.sy):
                    c = self.get(x, y, z)
                    if c:
                        out[self.sz - 1 - z][x] = c
                        break
        return out

    def side_normals(self):
        """Exact normal map for the side view, from the voxel surface. RGB encoded."""
        img = Image.new("RGBA", (self.sx, self.sz), (0, 0, 0, 0))
        px = img.load()
        for x in range(self.sx):
            for z in range(self.sz):
                hit = None
                for y in range(self.sy):
                    if self.get(x, y, z):
                        hit = y; break
                if hit is None:
                    continue
                nx = self.get(x - 1, hit, z) == 0
                nX = self.get(x + 1, hit, z) == 0
                nz = self.get(x, hit, z - 1) == 0
                nZ = self.get(x, hit, z + 1) == 0
                vx = (1 if nX else 0) - (1 if nx else 0)
                vz = (1 if nZ else 0) - (1 if nz else 0)
                vy = -1.0
                ln = (vx * vx + vy * vy + vz * vz) ** .5
                px[x, self.sz - 1 - z] = (int((vx / ln * .5 + .5) * 255),
                                          int((vz / ln * .5 + .5) * 255),
                                          int((-vy / ln * .5 + .5) * 255), 255)
        return img


def grid_to_img(grid, scale=1):
    h = len(grid); w = len(grid[0])
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = im.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = PALETTE.get(grid[y][x], (255, 0, 255, 255))
    return im.resize((w * scale, h * scale), Image.NEAREST) if scale > 1 else im


def sheet(vox, scale=6, cols=4, checker=True):
    """All z-layers laid out as a contact sheet, labelled by position, bottom-left = z0."""
    tiles = [grid_to_img(vox.slice_layer(z), scale) for z in range(vox.sz)]
    tw, th = tiles[0].size
    pad = 4
    rows = (len(tiles) + cols - 1) // cols
    W = cols * (tw + pad) + pad; H = rows * (th + pad) + pad
    out = Image.new("RGBA", (W, H), (24, 24, 28, 255))
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        bg = Image.new("RGBA", (tw, th), (44, 44, 52, 255))
        if checker:
            p = bg.load()
            for y in range(th):
                for x in range(tw):
                    if ((x // scale) + (y // scale)) % 2 == 0:
                        p[x, y] = (52, 52, 62, 255)
        bg.alpha_composite(t)
        out.alpha_composite(bg, (pad + c * (tw + pad), pad + r * (th + pad)))
    return out


def stacked(vox, scale=6, dy=1, angle=0):
    """Sprite-stacking render: each z layer drawn with a vertical offset."""
    import math
    a = math.radians(angle)
    ca, sa = math.cos(a), math.sin(a)
    cx = cy = (vox.sx - 1) / 2
    W = vox.sx + 6; H = vox.sy + vox.sz * dy + 6
    canvas = [[0] * W for _ in range(H)]
    for z in range(vox.sz):
        for y in range(vox.sy):
            for x in range(vox.sx):
                c = vox.get(x, y, z)
                if not c:
                    continue
                rx = (x - cx) * ca - (y - cy) * sa + cx
                ry = (x - cx) * sa + (y - cy) * ca + cy
                px = int(round(rx)) + 3
                py = int(round(ry)) + 3 + (vox.sz - 1 - z) * dy
                if 0 <= px < W and 0 <= py < H:
                    canvas[py][px] = c
    return grid_to_img(canvas, scale)
