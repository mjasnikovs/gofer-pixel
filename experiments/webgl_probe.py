#!/usr/bin/env python3
"""Ask a real WebKitGTK web view — the engine Tauri embeds on Linux — what its WebGL2 is.

PRODUCTION_PLAN.md §3 rests on Tauri's documented warning that WebGL under WebKitGTK can fall
back to software silently on NVIDIA. §14 recorded that as unmeasured on this box. This measures
it: it opens a webkit2gtk-4.1 web view (the same shared library Tauri's wry links against),
creates a WebGL2 context, reads the unmasked vendor and renderer strings, and times a
fragment-heavy draw so the answer does not rest on the string alone.

Usage:
    python3 experiments/webgl_probe.py [label]

Environment flags worth trying, both from Tauri's Linux graphics page:
    WEBKIT_DISABLE_COMPOSITING_MODE=1
    WEBKIT_DISABLE_DMABUF_RENDERER=1
"""

import json
import os
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2, GLib  # noqa: E402

PAGE = """
<!doctype html><html><body><canvas id=c width=512 height=512></canvas><script>
const out = {};
const gl = document.getElementById('c').getContext('webgl2');
if (!gl) {
    out.error = 'no webgl2 context';
} else {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    out.version = gl.getParameter(gl.VERSION);
    out.vendor = gl.getParameter(gl.VENDOR);
    out.renderer = gl.getParameter(gl.RENDERER);
    out.unmaskedVendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null;
    out.unmaskedRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
    out.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

    // a deliberately fragment-heavy shader: software rasterisation shows up as a wall
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, `#version 300 es
        in vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, `#version 300 es
        precision highp float; out vec4 o;
        void main(){
            float a = 0.;
            for (int i = 0; i < 200; i++) { a += sin(float(i) + gl_FragCoord.x) * cos(gl_FragCoord.y); }
            o = vec4(fract(a), 0.2, 0.3, 1.);
        }`);
    gl.compileShader(fs);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        out.linkError = gl.getShaderInfoLog(fs) + gl.getShaderInfoLog(vs);
    } else {
        gl.useProgram(prog);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, 'p');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        const pixel = new Uint8Array(4);
        gl.drawArrays(gl.TRIANGLES, 0, 3);            // warm up
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

        // WebKit rounds performance.now() for privacy, so one small draw measures as 0 ms.
        // Double the frame count until the run is long enough for the clock to mean something.
        let frames = 1;
        let ms = 0;
        while (ms < 250 && frames <= 4096) {
            frames *= 2;
            const t0 = Date.now();
            for (let i = 0; i < frames; i++) { gl.drawArrays(gl.TRIANGLES, 0, 3); }
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);  // forces completion
            ms = Date.now() - t0;
        }
        out.frames = frames;
        out.totalMs = ms;
        out.msPerFrame = ms / frames;
        // one frame is 512*512 pixels * 200 loop iterations of sin+cos
        out.megaFragmentIterationsPerSecond =
            Math.round((512 * 512 * 200 * frames) / (ms * 1000));
        out.pixel = [...pixel];

        // HOLD_MS keeps the GPU busy long enough to be caught in nvidia-smi, which is the check
        // that does not depend on trusting either the renderer string or the clock.
        const hold = HOLD_MS;
        if (hold > 0) {
            const until = Date.now() + hold;
            while (Date.now() < until) {
                for (let i = 0; i < frames; i++) { gl.drawArrays(gl.TRIANGLES, 0, 3); }
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            }
        }
    }
}
document.title = 'RESULT ' + JSON.stringify(out);
</script></body></html>
"""


def main() -> int:
    label = sys.argv[1] if len(sys.argv) > 1 else "default"
    window = Gtk.Window(title="webgl probe")
    window.set_default_size(600, 600)
    view = WebKit2.WebView()
    window.add(view)

    result: dict[str, object] = {}

    def on_title(webview: WebKit2.WebView, _param: object) -> None:
        title = webview.get_title() or ""
        if title.startswith("RESULT "):
            result.update(json.loads(title[len("RESULT ") :]))
            Gtk.main_quit()

    view.connect("notify::title", on_title)
    hold_ms = int(os.environ.get("HOLD_MS", "0"))
    view.load_html(PAGE.replace("HOLD_MS", str(hold_ms)), "file:///")
    window.show_all()
    GLib.timeout_add_seconds(30, Gtk.main_quit)
    Gtk.main()

    flags = {
        key: os.environ.get(key, "")
        for key in ("WEBKIT_DISABLE_COMPOSITING_MODE", "WEBKIT_DISABLE_DMABUF_RENDERER")
        if os.environ.get(key)
    }
    print(json.dumps({"label": label, "flags": flags, "result": result or "timed out"}, indent=2))
    return 0 if result else 1


if __name__ == "__main__":
    raise SystemExit(main())
