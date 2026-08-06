"""MagicaVoxel .vox -> sprite-stacking sheet. Stdlib only (zlib + struct)."""

import struct
import sys
import zlib
from pathlib import Path


def read_vox(path):
    """Return (size_xyz, {(x,y,z): palette_index}, palette[256] of (r,g,b,a))."""
    data = Path(path).read_bytes()
    if data[:4] != b"VOX ":
        raise ValueError(f"{path}: not a .vox file")

    size = None
    voxels = {}
    palette = DEFAULT_PALETTE[:]

    pos = 8  # skip magic + version
    # MAIN chunk header, then walk its children linearly
    _, _, _ = struct.unpack_from("<4sii", data, pos)[0:3]
    pos += 12

    while pos < len(data):
        cid, n_content, n_children = struct.unpack_from("<4sii", data, pos)
        body = pos + 12
        if cid == b"SIZE":
            size = struct.unpack_from("<3i", data, body)
        elif cid == b"XYZI":
            (count,) = struct.unpack_from("<i", data, body)
            for i in range(count):
                x, y, z, c = data[body + 4 + i * 4 : body + 8 + i * 4]
                voxels[(x, y, z)] = c
        elif cid == b"RGBA":
            palette = [
                tuple(data[body + i * 4 : body + i * 4 + 4]) for i in range(256)
            ]
        pos = body + n_content + n_children

    if size is None:
        raise ValueError(f"{path}: no SIZE chunk")
    return size, voxels, palette


def slice_layers(size, voxels, palette, scale=1):
    """One RGBA layer per z, bottom-first. Layer is (w, h, bytearray)."""
    sx, sy, sz = size
    w, h = sx * scale, sy * scale
    layers = []
    for z in range(sz):
        buf = bytearray(w * h * 4)
        for (x, y, vz), c in voxels.items():
            if vz != z:
                continue
            r, g, b, a = palette[c - 1]
            # .vox Y is depth; flip it so the sheet reads top-down like a screen
            py = sy - 1 - y
            for dy in range(scale):
                row = ((py * scale + dy) * w + x * scale) * 4
                for dx in range(scale):
                    buf[row + dx * 4 : row + dx * 4 + 4] = bytes((r, g, b, a))
        layers.append((w, h, buf))
    return layers


def compose_sheet(layers, columns=8, pad=1):
    """Lay layers out in a grid: one cell per slice, bottom slice first."""
    lw, lh = layers[0][0], layers[0][1]
    rows = (len(layers) + columns - 1) // columns
    cols = min(columns, len(layers))
    sw = cols * (lw + pad) + pad
    sh = rows * (lh + pad) + pad
    sheet = bytearray(sw * sh * 4)
    for i, (w, h, buf) in enumerate(layers):
        ox = pad + (i % columns) * (w + pad)
        oy = pad + (i // columns) * (h + pad)
        for y in range(h):
            src = y * w * 4
            dst = ((oy + y) * sw + ox) * 4
            sheet[dst : dst + w * 4] = buf[src : src + w * 4]
    return sw, sh, sheet


def compose_stacked(layers, dy=1, pad=0):
    """Preview render: draw every slice bottom-to-top, each `dy` px higher."""
    lw, lh = layers[0][0], layers[0][1]
    sw = lw + pad * 2
    sh = lh + dy * (len(layers) - 1) + pad * 2
    out = bytearray(sw * sh * 4)
    for i, (w, h, buf) in enumerate(layers):
        oy = pad + (len(layers) - 1 - i) * dy
        for y in range(h):
            for x in range(w):
                s = (y * w + x) * 4
                if buf[s + 3] == 0:
                    continue
                d = ((oy + y) * sw + pad + x) * 4
                out[d : d + 4] = buf[s : s + 4]
    return sw, sh, out


def write_png(path, w, h, rgba):
    raw = b"".join(
        b"\x00" + bytes(rgba[y * w * 4 : (y + 1) * w * 4]) for y in range(h)
    )

    def chunk(tag, payload):
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload))
        )

    Path(path).write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


# MagicaVoxel's built-in palette, generated procedurally (matches the default ramp)
DEFAULT_PALETTE = [(255, 255, 255, 255)] + [
    (
        (i >> 0 & 7) * 36 + 3,
        (i >> 3 & 7) * 36 + 3,
        (i >> 6 & 3) * 85,
        255,
    )
    for i in range(255)
]


def main():
    if len(sys.argv) < 2:
        print("usage: voxslice.py model.vox [scale] [out_prefix]")
        return 1
    src = sys.argv[1]
    scale = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    prefix = sys.argv[3] if len(sys.argv) > 3 else Path(src).stem

    size, voxels, palette = read_vox(src)
    layers = slice_layers(size, voxels, palette, scale)

    write_png(f"{prefix}_sheet.png", *compose_sheet(layers))
    write_png(f"{prefix}_stacked.png", *compose_stacked(layers, dy=scale))
    print(
        f"{src}: {size[0]}x{size[1]}x{size[2]}, {len(voxels)} voxels, "
        f"{len(layers)} slices -> {prefix}_sheet.png, {prefix}_stacked.png"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
