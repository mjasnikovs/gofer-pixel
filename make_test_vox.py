"""Write a tiny test .vox (a blocky car) so voxslice.py can be exercised offline."""

import struct
from pathlib import Path

SX, SY, SZ = 16, 10, 7

voxels = []
for z in range(SZ):
    for y in range(SY):
        for x in range(SX):
            body = z < 3 and 1 <= x <= 14 and 1 <= y <= 8
            cabin = 3 <= z < 6 and 4 <= x <= 10 and 2 <= y <= 7
            if body:
                voxels.append((x, y, z, 216))  # red-ish
            elif cabin:
                voxels.append((x, y, z, 84))  # blue-ish
    # wheels
    if z < 2:
        for wx in (2, 3, 12, 13):
            for wy in (0, 9):
                voxels.append((wx, wy, z, 1))


def chunk(tag, content, children=b""):
    return tag + struct.pack("<ii", len(content), len(children)) + content + children


size = chunk(b"SIZE", struct.pack("<3i", SX, SY, SZ))
xyzi = chunk(
    b"XYZI",
    struct.pack("<i", len(voxels)) + b"".join(bytes(v) for v in voxels),
)
main = chunk(b"MAIN", b"", size + xyzi)
Path("car.vox").write_bytes(b"VOX " + struct.pack("<i", 150) + main)
print(f"car.vox: {len(voxels)} voxels")
