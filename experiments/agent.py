"""TEST D: the user's proposal. Model drives a voxel modeller via tool calls,
gets rendered slices + stacked view back as IMAGES, and self-corrects."""
import json, sys
from llm import chat, img_part, png_of, REC
from vox import Vox, sheet, stacked, grid_to_img, PALETTE

TOOLS = [
 {"type": "function", "function": {"name": "box", "description":
  "Fill an axis-aligned box of voxels. z is up. Coordinates inclusive, 0..15.",
  "parameters": {"type": "object", "properties": {
    "x0": {"type": "integer"}, "y0": {"type": "integer"}, "z0": {"type": "integer"},
    "x1": {"type": "integer"}, "y1": {"type": "integer"}, "z1": {"type": "integer"},
    "color": {"type": "integer", "description": "1..9, 0 erases"}},
   "required": ["x0", "y0", "z0", "x1", "y1", "z1", "color"]}}},
 {"type": "function", "function": {"name": "ellipsoid", "description":
  "Fill an ellipsoid of voxels.",
  "parameters": {"type": "object", "properties": {
    "cx": {"type": "integer"}, "cy": {"type": "integer"}, "cz": {"type": "integer"},
    "rx": {"type": "integer"}, "ry": {"type": "integer"}, "rz": {"type": "integer"},
    "color": {"type": "integer"}},
   "required": ["cx", "cy", "cz", "rx", "ry", "rz", "color"]}}},
 {"type": "function", "function": {"name": "cylinder_z", "description":
  "Vertical cylinder from z0 to z1.",
  "parameters": {"type": "object", "properties": {
    "cx": {"type": "integer"}, "cy": {"type": "integer"}, "z0": {"type": "integer"},
    "z1": {"type": "integer"}, "r": {"type": "integer"}, "color": {"type": "integer"}},
   "required": ["cx", "cy", "z0", "z1", "r", "color"]}}},
 {"type": "function", "function": {"name": "mirror_x", "description":
  "Mirror the left half onto the right half, forcing perfect left-right symmetry.",
  "parameters": {"type": "object", "properties": {}}}},
 {"type": "function", "function": {"name": "render", "description":
  "Render the current model and SEE it: returns a stacked 3D-look view, a side view, "
  "and numeric stats. Call this to check your work.",
  "parameters": {"type": "object", "properties": {}}}},
 {"type": "function", "function": {"name": "done", "description":
  "Finish. Only call when the render looks correct.",
  "parameters": {"type": "object", "properties": {
    "summary": {"type": "string"}}, "required": ["summary"]}}},
]

PAL_TXT = ", ".join(f"{k}={n}" for k, n in
    [(1, "near-black"), (2, "dark purple"), (3, "light grey-purple"), (4, "white"),
     (5, "red"), (6, "gold"), (7, "green"), (8, "blue"), (9, "brown wood")])

SYS = f"""You sculpt small voxel models for a sprite-stacking pixel-art game.
Grid is 16x16x16, x=right, y=depth, z=UP. z=0 is the ground.
Palette: {PAL_TXT}.
Work in this order: block out the big masses first, call render to look at it,
then fix and add detail. Keep it readable at tiny size: bold shapes, few colours.
Call done only after a render you are happy with."""


def run(subject, max_steps=14, seed=7, verbose=True):
    v = Vox(16, 16, 16)
    msgs = [{"role": "system", "content": SYS},
            {"role": "user", "content": f"Sculpt: {subject}"}]
    calls, renders, log = 0, 0, []
    for step in range(max_steps):
        d = chat(msgs, tools=TOOLS, max_tokens=1200, seed=seed, sampler=REC)
        m = d["choices"][0]["message"]
        tcs = m.get("tool_calls") or []
        msgs.append({"role": "assistant", "content": m.get("content") or "",
                     "tool_calls": tcs})
        if not tcs:
            log.append(("text", (m.get("content") or "")[:200]))
            if verbose: print(f"[{step}] no tool call: {(m.get('content') or '')[:160]}")
            break
        stop = False
        for tc in tcs:
            fn = tc["function"]["name"]
            try:
                args = json.loads(tc["function"]["arguments"] or "{}")
            except Exception as e:
                args = {}
            calls += 1
            if verbose: print(f"[{step}] {fn}({json.dumps(args)[:120]})")
            log.append((fn, args))
            if fn == "done":
                stop = True
                msgs.append({"role": "tool", "tool_call_id": tc["id"], "content": "ok"})
                continue
            if fn == "render":
                renders += 1
                st = v.stats()
                stk = stacked(v, scale=8, dy=1, angle=25)
                side = grid_to_img(v.side_view(), 10)
                msgs.append({"role": "tool", "tool_call_id": tc["id"],
                             "content": json.dumps(st)})
                msgs.append({"role": "user", "content": [
                    img_part(png_of(stk)),
                    img_part(png_of(side)),
                    {"type": "text", "text":
                     "Image 1: sprite-stacked view. Image 2: side view. "
                     "Is this reading correctly as the subject? If not, fix it with more "
                     "tool calls. If yes, call done."}]})
                continue
            try:
                if fn == "box":
                    n = v.box(args["x0"], args["y0"], args["z0"],
                              args["x1"], args["y1"], args["z1"], args["color"])
                elif fn == "ellipsoid":
                    n = v.ellipsoid(args["cx"], args["cy"], args["cz"],
                                    args["rx"], args["ry"], args["rz"], args["color"])
                elif fn == "cylinder_z":
                    n = v.cylinder_z(args["cx"], args["cy"], args["z0"],
                                     args["z1"], args["r"], args["color"])
                elif fn == "mirror_x":
                    n = v.mirror_x()
                else:
                    n = -1
                res = f"ok, {n} voxels affected. total={len(v.v)}"
            except Exception as e:
                res = f"error: {e}"
            msgs.append({"role": "tool", "tool_call_id": tc["id"], "content": res})
        if stop:
            break
    return v, dict(steps=step + 1, tool_calls=calls, renders=renders, stats=v.stats())


if __name__ == "__main__":
    subj = sys.argv[1] if len(sys.argv) > 1 else "a red mushroom house with a door"
    tag = sys.argv[2] if len(sys.argv) > 2 else "agent"
    v, info = run(subj)
    print("\nRESULT:", json.dumps(info))
    sheet(v, scale=6).save(f"{tag}_sheet.png")
    stacked(v, scale=8, dy=1, angle=25).save(f"{tag}_stack.png")
    grid_to_img(v.side_view(), 10).save(f"{tag}_side.png")
    v.side_normals().resize((160, 160)).save(f"{tag}_normals.png")
    print(f"wrote {tag}_stack.png {tag}_side.png {tag}_sheet.png {tag}_normals.png")
