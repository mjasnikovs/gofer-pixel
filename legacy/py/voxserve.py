"""A local scoring service, so the editor can use CLIP without CLIP running in a browser.

CLIP needs torch, torch runs on the CPU here (both GPUs are full — `PRODUCTION_PLAN.md` §2), and
neither fits in a web page. So the browser sends the op list it already has, this rasterises it with
`voxgen.rasterise` — the same code the TypeScript port is pinned against, so the voxels are
identical — renders four angles and returns the CLIP score.

It is deliberately optional. The editor scores candidates deterministically on its own and only
asks this for CLIP; if it is not running, the panel says so and carries on.

    .venv/bin/python voxserve.py [port]        # default 8765

    curl -s localhost:8765/health
    curl -s localhost:8765/score -d '{"prompt":"a stone tower","specs":[{...}]}'
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import voxgen
import voxrank

MAX_BODY = 64 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # the editor is served from a vite dev server on another port, and this is localhost only
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802 - BaseHTTPRequestHandler's naming
        self._send(200, {})

    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/") in ("", "/health"):
            self._send(200, {"ok": True, "service": "voxserve", "scorer": "clip ViT-B-32"})
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
        specs = request.get("specs") or []
        if not prompt or not isinstance(specs, list):
            self._send(400, {"error": "need a prompt and a list of specs"})
            return

        # the same wording voxbatch.py ranks with, so scores are comparable between the two
        clip_prompt = f"pixel art sprite of {prompt}"
        scores = []
        for spec in specs:
            try:
                grid, palette = voxgen.rasterise(spec)
                if not grid:
                    scores.append(None)
                    continue
                scores.append(voxrank.score_model(spec["size"], grid, palette, clip_prompt))
            except Exception as e:  # noqa: BLE001 - one bad spec must not sink the batch
                print(f"  spec failed: {type(e).__name__}: {e}")
                scores.append(None)

        print(f'scored {len(scores)} candidates for "{prompt}"')
        self._send(200, {"prompt": clip_prompt, "scores": scores})

    def log_message(self, *args):
        pass  # the handlers above already print what matters

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            # a page that navigated away mid-request is not an error worth a traceback
            self.close_connection = True


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"loading CLIP…")
    voxrank._load()  # pay the model load once, at startup, not on the first request
    # threading, not the plain HTTPServer: keep-alive means the browser holds a connection open
    # after the health probe, and a single-threaded server would then never answer the /score that
    # follows on a second connection
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"voxserve on http://127.0.0.1:{port} — /health, POST /score")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("bye")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
