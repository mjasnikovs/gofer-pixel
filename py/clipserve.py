"""A local scoring service, so the editor can rank candidates with CLIP.

CLIP needs torch, torch runs on the CPU here because both GPUs are full with llama-server, and
neither fits in a web page. So the page renders its candidates with the renderer it already has and
posts the PNGs; this does nothing but CLIP.

That is the whole difference from the version this replaces. `legacy/py/voxserve.py` took op lists,
rasterised them a second time with `voxgen.rasterise` and rendered them a second time with the
sprite stacker — two rasterisers and two renderers that had to stay byte-identical or the score was
of a picture the artist never saw. Neither exists here.

    .venv/bin/python py/clipserve.py [port]        # default 8765

    curl -s localhost:8765/health
    POST /score  {"prompt": "a stone tower", "candidates": [["<base64 png>", ...], ...]}
    ->           {"prompt": "pixel art sprite of a stone tower", "scores": [0.3587, ...]}

One score per candidate: the mean similarity over its views, because a single unlucky angle sinks a
good asset. `null` where a candidate could not be read.

Two limits, both measured and both worth knowing before trusting a number:
  - CLIP ranks candidates of the SAME prompt. Scores are not comparable across subjects.
  - It is a sort order, not a quality bar. Under optimisation pressure it rewards damage.
"""

import base64
import io
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 64 * 1024 * 1024

_MODEL = None


def _load():
    """Pay the model load once. ~4.6s on this CPU, measured 2026-08-08."""
    global _MODEL
    if _MODEL is None:
        import open_clip
        import torch

        model, _, preprocess = open_clip.create_model_and_transforms(
            "ViT-B-32", pretrained="laion2b_s34b_b79k", device="cpu"
        )
        model.eval()
        _MODEL = (model, preprocess, open_clip.get_tokenizer("ViT-B-32"), torch)
    return _MODEL


def score_views(views, prompt):
    """Mean CLIP similarity of one candidate's views against the prompt."""
    from PIL import Image

    model, preprocess, tokenizer, torch = _load()
    with torch.no_grad():
        t = model.encode_text(tokenizer([prompt]))
        t = t / t.norm(dim=-1, keepdim=True)
        total = 0.0
        for view in views:
            data = base64.b64decode(view)
            # NEAREST on the way up to CLIP's 224: the whole point of this editor is that a pixel
            # is a pixel, and a bilinear resize would score a blurred version of the sprite.
            image = (
                Image.open(io.BytesIO(data))
                .convert("RGB")
                .resize((224, 224), Image.NEAREST)
            )
            f = model.encode_image(preprocess(image).unsqueeze(0))
            f = f / f.norm(dim=-1, keepdim=True)
            total += float((f @ t.T)[0, 0])
    return total / len(views)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # The editor is served from a vite dev server on another port, and this binds to localhost.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802 - BaseHTTPRequestHandler's naming
        self._send(200, {})

    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/") in ("", "/health"):
            self._send(200, {"ok": True, "service": "clipserve", "scorer": "clip ViT-B-32"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path.rstrip("/") != "/score":
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_BODY:
            self._send(413, {"error": "body too large"})
            return
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError as e:
            self._send(400, {"error": f"bad JSON: {e}"})
            return

        prompt = request.get("prompt") or ""
        candidates = request.get("candidates")
        if not prompt or not isinstance(candidates, list):
            self._send(400, {"error": "need a prompt and a list of candidates"})
            return

        # The wording the ranking was validated with. It stays here rather than in the page so the
        # scores of two sessions are comparable.
        clip_prompt = f"pixel art sprite of {prompt}"
        started = time.time()
        scores = []
        for views in candidates:
            try:
                if not isinstance(views, list) or not views:
                    scores.append(None)
                    continue
                scores.append(score_views(views, clip_prompt))
            except Exception as e:  # noqa: BLE001 - one bad candidate must not sink the batch
                print(f"  candidate failed: {type(e).__name__}: {e}")
                scores.append(None)

        print(
            f'scored {len(scores)} candidates for "{prompt}"'
            f" in {time.time() - started:.1f}s"
        )
        self._send(200, {"prompt": clip_prompt, "scores": scores})

    def log_message(self, *args):
        pass  # the handlers above already print what matters

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            # A page that navigated away mid-request is not worth a traceback.
            self.close_connection = True


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print("loading CLIP…")
    _load()
    # Threading, not the plain HTTPServer: keep-alive means the browser holds a connection open
    # after the health probe, and a single-threaded server would then never answer the /score that
    # follows on a second connection.
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"clipserve on http://127.0.0.1:{port} — /health, POST /score")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("bye")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
