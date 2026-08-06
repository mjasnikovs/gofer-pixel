"""Local LLM -> voxel model -> sprite-stacking sheet.

The model never draws pixels. It emits a short list of solid primitives; we
rasterise them deterministically, so every z-slice is registered by
construction. Then (optionally) we show the render back to the model and let
it patch its own ops.
"""

import json
import struct
import sys
import urllib.request
from pathlib import Path

import voxslice

SERVER = "http://localhost:8080/v1/chat/completions"

MAX_OPS = 40

_XYZ = {"type": "array", "items": {"type": "integer"}, "minItems": 3, "maxItems": 3}
_COLOR = {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"}


def _op(kind, **props):
    return {
        "type": "object",
        "properties": {"op": {"const": kind}, **props},
        "required": ["op", *props],
        "additionalProperties": False,
    }


# llama-server converts this to a GBNF grammar and constrains decoding token by token, so a
# malformed op cannot be produced rather than being repaired afterwards. The catch documented in
# llama.cpp's grammar README is that the schema is *not* injected into the prompt, so SYSTEM above
# still has to describe the same shape in words — the two must be kept in step by hand.
VOX_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "size": _XYZ,
        "mirror_x": {"type": "boolean"},
        "ops": {
            "type": "array",
            "minItems": 1,
            "maxItems": MAX_OPS,
            "items": {
                "anyOf": [
                    _op("box", **{"from": _XYZ, "to": _XYZ, "color": _COLOR}),
                    _op("ball", at=_XYZ, r=_XYZ, color=_COLOR),
                    _op("erase", **{"from": _XYZ, "to": _XYZ}),
                ]
            },
        },
    },
    "required": ["name", "size", "mirror_x", "ops"],
    "additionalProperties": False,
}

SYSTEM = """You are a voxel modeller. You answer with JSON only, no prose, no markdown fence.

Schema:
{"name": str,
 "size": [sx, sy, sz],
 "mirror_x": bool,
 "ops": [ ... ]}

Axes: x = length/width, y = depth, z = up. Origin is the min corner.
Ops are applied in order; later ops paint over earlier ones.
  {"op":"box","from":[x,y,z],"to":[x,y,z],"color":"#rrggbb"}   inclusive bounds
  {"op":"ball","at":[x,y,z],"r":[rx,ry,rz],"color":"#rrggbb"}  axis-aligned ellipsoid
  {"op":"erase","from":[x,y,z],"to":[x,y,z]}                   carve empty space

Rules:
- Keep size within 32x32x32 and use at most 40 ops.
- If mirror_x is true, only model x < sx/2; the other half is generated.
- Build in readable layers: the object must look correct sliced horizontally,
  so avoid overhangs that would leave a slice floating and unreadable.
- Use 4-8 distinct colors with real value contrast, not near-identical shades."""

REVISE = """That is the sprite-stack render of your model (slices drawn bottom to top,
each one pixel higher, so it leans toward the viewer). Judge the silhouette and
proportions, then return the FULL corrected JSON. JSON only."""


def ask(messages, temperature=0.4, schema=VOX_SCHEMA):
    """One chat completion. With a schema, decoding is grammar-constrained server-side."""
    payload = {"messages": messages, "temperature": temperature, "max_tokens": 4096}
    if schema is not None:
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "vox_model", "strict": True, "schema": schema},
        }
    req = urllib.request.Request(
        SERVER,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.load(r)["choices"][0]["message"]["content"]


def parse_model(text):
    """The reply is schema-constrained, so it parses or it is a server-side failure.

    This used to strip fences and count braces to find the object in whatever prose came back.
    That repair step is gone: `ask` sends a JSON schema, llama-server turns it into a grammar,
    and text that does not match the schema can no longer be generated. If this raises, the
    request went out without the schema or the server ignored it — both worth knowing about
    loudly rather than papering over.
    """
    return json.loads(text)


def rasterise(spec):
    """Ops -> ({(x,y,z): palette_index}, palette). Out-of-bounds voxels dropped."""
    sx, sy, sz = spec["size"]
    grid, palette, index = {}, [], {}

    def idx(hexcol):
        c = hexcol.lstrip("#")
        rgb = tuple(int(c[i : i + 2], 16) for i in (0, 2, 4))
        if rgb not in index:
            palette.append(rgb + (255,))
            index[rgb] = len(palette)  # .vox indices are 1-based
        return index[rgb]

    def put(x, y, z, ci):
        if 0 <= x < sx and 0 <= y < sy and 0 <= z < sz:
            if ci is None:
                grid.pop((x, y, z), None)
            else:
                grid[(x, y, z)] = ci

    for op in spec["ops"]:
        kind = op["op"]
        if kind in ("box", "erase"):
            (x0, y0, z0), (x1, y1, z1) = op["from"], op["to"]
            ci = None if kind == "erase" else idx(op["color"])
            for x in range(min(x0, x1), max(x0, x1) + 1):
                for y in range(min(y0, y1), max(y0, y1) + 1):
                    for z in range(min(z0, z1), max(z0, z1) + 1):
                        put(x, y, z, ci)
        elif kind == "ball":
            (cx, cy, cz), (rx, ry, rz) = op["at"], op["r"]
            ci = idx(op["color"])
            for x in range(cx - rx, cx + rx + 1):
                for y in range(cy - ry, cy + ry + 1):
                    for z in range(cz - rz, cz + rz + 1):
                        dx = (x - cx) / max(rx, 0.5)
                        dy = (y - cy) / max(ry, 0.5)
                        dz = (z - cz) / max(rz, 0.5)
                        if dx * dx + dy * dy + dz * dz <= 1.0:
                            put(x, y, z, ci)

    if spec.get("mirror_x"):
        for (x, y, z), ci in list(grid.items()):
            put(sx - 1 - x, y, z, ci)

    palette += [(0, 0, 0, 0)] * (256 - len(palette))
    return grid, palette


def write_vox(path, size, grid, palette):
    def chunk(tag, content, children=b""):
        return tag + struct.pack("<ii", len(content), len(children)) + content + children

    body = chunk(b"SIZE", struct.pack("<3i", *size))
    body += chunk(
        b"XYZI",
        struct.pack("<i", len(grid))
        + b"".join(bytes((x, y, z, c)) for (x, y, z), c in grid.items()),
    )
    body += chunk(b"RGBA", b"".join(bytes(c) for c in palette))
    Path(path).write_bytes(
        b"VOX " + struct.pack("<i", 150) + chunk(b"MAIN", b"", body)
    )


def render(spec, prefix, scale=4):
    grid, palette = rasterise(spec)
    if not grid:
        raise ValueError("model produced no voxels")
    write_vox(f"{prefix}.vox", spec["size"], grid, palette)
    layers = voxslice.slice_layers(spec["size"], grid, palette, scale)
    voxslice.write_png(f"{prefix}_sheet.png", *voxslice.compose_sheet(layers))
    voxslice.write_png(
        f"{prefix}_stacked.png", *voxslice.compose_stacked(layers, dy=scale)
    )
    return len(grid), len(layers)


def main():
    if len(sys.argv) < 2:
        print('usage: voxgen.py "a red pickup truck" [passes] [out_prefix]')
        return 1
    prompt = sys.argv[1]
    passes = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    prefix = sys.argv[3] if len(sys.argv) > 3 else "gen"

    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": prompt},
    ]
    spec = None
    for p in range(passes):
        if p:  # feed the render back for a vision critique pass
            png = Path(f"{prefix}_stacked.png").read_bytes()
            import base64

            messages += [
                {"role": "assistant", "content": json.dumps(spec)},
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": "data:image/png;base64,"
                                + base64.b64encode(png).decode()
                            },
                        },
                        {"type": "text", "text": REVISE},
                    ],
                },
            ]
        spec = parse_model(ask(messages))
        n_vox, n_slices = render(spec, prefix)
        print(
            f"pass {p + 1}: {spec['name']} {spec['size']}, "
            f"{len(spec['ops'])} ops -> {n_vox} voxels, {n_slices} slices"
        )
    print(f"wrote {prefix}.vox, {prefix}_sheet.png, {prefix}_stacked.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
