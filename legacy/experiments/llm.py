import json, urllib.request, base64, io, time

URL = "http://localhost:8080/v1/chat/completions"

# server/model-card defaults for Qwen3.6
REC = dict(temperature=0.7, top_p=0.8, top_k=20, presence_penalty=1.5, repeat_penalty=1.0)
GREEDY = dict(temperature=0.0, top_p=1.0, top_k=0, presence_penalty=0.0, repeat_penalty=1.0)

def chat(messages, tools=None, max_tokens=4096, seed=1234, timeout=900, sampler=None):
    body = {"messages": messages, "max_tokens": max_tokens, "seed": seed}
    body.update(sampler or REC)
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    req = urllib.request.Request(URL, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.load(r)
    d["_wall_s"] = round(time.time() - t0, 1)
    return d

def msg_text(d):
    return d["choices"][0]["message"].get("content") or ""

def img_part(png_bytes):
    b64 = base64.b64encode(png_bytes).decode()
    return {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}}

def png_of(pil_img):
    buf = io.BytesIO()
    pil_img.save(buf, format="PNG")
    return buf.getvalue()
