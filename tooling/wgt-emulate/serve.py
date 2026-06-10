#!/usr/bin/env python3
"""
wgt-emulate — run the Tizen WGT in a desktop browser without a TV.

The bootstrap WGT (packages/shell-tizen-bootstrap/src) is plain web: it uses
localStorage, XMLHttpRequest, and the DOM only — no Tizen native APIs until the
*hosted* shell.min.js takes over. That means the entire Hosted Shell Bootstrap
(HSB) flow — connect form → manifest fetch → hosted-shell load → baked fallback
— can be exercised in any desktop Chromium with zero Tizen tooling.

This server does two jobs at once:

  1. Serves the WGT payload directory (default: the bootstrap src/) at  /
  2. Stands in for a Jellyfin server's  ${server}/shell/  drop folder:
       GET /shell/manifest.json   -> version + sha256 (+ optional shellUrl)
       GET /shell/shell.min.js    -> a stub "emulated shell" (or a real file)

So in the browser you open  http://localhost:8088/ , type
http://localhost:8088  into the connect form, and the bootloader fetches the
manifest and hosted shell from this same server — exactly the on-device flow.

Failure modes are first-class so you can watch the fallback branches render:
  --fail-manifest   manifest.json -> 503  (bootloader uses shell.min.js?t=...)
  --fail-shell      shell.min.js  -> 503  (bootloader loads baked boot-shell)

A Tizen native-API stub (tizen-stub.js) is injected ahead of the bootloader so
that a *real* built shell.min.js (which touches window.tizen / webapis /
NativeShell) also runs far enough to be useful in a desktop browser.

Usage:
  python3 serve.py                       # serve bootstrap src + mock shell
  python3 serve.py --port 9000
  python3 serve.py --real-shell ../../packages/shell-tizen/dist/shell.min.js
  python3 serve.py --fail-shell          # exercise baked-fallback branch
  python3 serve.py --self-test           # headless: assert endpoints, exit 0/1
  python3 serve.py --root ../../packages/shell-tizen-bootstrap/src
"""

import argparse
import hashlib
import http.server
import json
import socketserver
import sys
import threading
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
DEFAULT_ROOT = REPO_ROOT / "packages" / "shell-tizen-bootstrap" / "src"
TIZEN_STUB = HERE / "tizen-stub.js"

# A minimal stand-in shell so the emulated HSB flow has something to load and
# something visible to confirm "the hosted shell took over". A real shell can be
# substituted with --real-shell.
STUB_SHELL_JS = """\
/* wgt-emulate stub shell — served from /shell/shell.min.js */
(function () {
  window.__emulatedShell = true;
  var server = (function () { try { return localStorage.getItem('jellyfin.shell.serverUrl'); } catch (_) { return null; } })();
  var box = document.createElement('div');
  box.id = 'emulated-shell';
  box.style.cssText = 'position:fixed;inset:0;background:#0a3d2a;color:#d8ffe8;' +
    'font-family:sans-serif;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;z-index:2147483646;text-align:center;padding:40px';
  box.innerHTML =
    '<h1 style="font-size:56px;margin:0 0 16px">EMULATED SHELL LOADED</h1>' +
    '<p style="font-size:24px;opacity:.85">/shell/shell.min.js was fetched and executed by the bootstrap.</p>' +
    '<p style="font-size:20px;opacity:.7">server = ' + (server || '(none)') + '</p>' +
    '<p style="font-size:18px;opacity:.6">window.__hsbShellUrl = ' + (window.__hsbShellUrl || '(set after onload)') + '</p>';
  document.body.appendChild(box);
  try { console.log('[wgt-emulate] stub shell executed; serverUrl =', server); } catch (_) {}
})();
"""


def sha256_bytes(data: bytes) -> str:
    h = hashlib.sha256()
    h.update(data)
    return h.hexdigest()


def make_handler(opts):
    root = opts["root"]
    shell_bytes = opts["shell_bytes"]
    shell_sha = sha256_bytes(shell_bytes)
    stub_js = TIZEN_STUB.read_bytes() if (opts["inject_tizen"] and TIZEN_STUB.exists()) else b""

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(root), **kw)

        # quieter, single-line logging that shows the HSB request flow
        def log_message(self, fmt, *args):
            sys.stderr.write("[wgt-emulate] %s\n" % (fmt % args))

        def _send(self, status, body: bytes, ctype: str):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            path = self.path.split("?", 1)[0]

            if path == "/shell/manifest.json":
                if opts["fail_manifest"]:
                    return self._send(503, b'{"error":"forced manifest failure"}',
                                      "application/json")
                manifest = {
                    "version": opts["shell_version"],
                    "sha256": shell_sha,
                    "shellUrl": opts["shell_url"],  # null -> bootloader derives base+shell.min.js
                    "emittedBy": "wgt-emulate",
                }
                return self._send(200, json.dumps(manifest, indent=2).encode(),
                                  "application/json")

            if path == "/shell/shell.min.js":
                if opts["fail_shell"]:
                    return self._send(503, b"// forced shell failure", "application/javascript")
                return self._send(200, shell_bytes, "application/javascript")

            if path in ("/", "/index.html") and stub_js:
                return self._serve_index_with_stub()

            return super().do_GET()

        def _serve_index_with_stub(self):
            index = root / "index.html"
            if not index.exists():
                return self._send(404, b"index.html not found", "text/plain")
            html = index.read_text(encoding="utf-8")
            # Inject the Tizen native-API stub immediately after <head> so it is
            # defined before the bootloader (and any hosted shell) runs.
            inject = "<script>\n" + stub_js.decode("utf-8") + "\n</script>"
            if "<head>" in html:
                html = html.replace("<head>", "<head>\n" + inject, 1)
            else:
                html = inject + html
            return self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")

    return Handler


def build_opts(args):
    root = Path(args.root).resolve()
    if not (root / "index.html").exists():
        sys.exit(f"error: {root}/index.html not found — is --root a WGT payload dir?")
    if args.real_shell:
        rp = Path(args.real_shell).resolve()
        if not rp.exists():
            sys.exit(f"error: --real-shell {rp} not found")
        shell_bytes = rp.read_bytes()
    else:
        shell_bytes = STUB_SHELL_JS.encode("utf-8")
    return {
        "root": root,
        "shell_bytes": shell_bytes,
        "shell_version": args.shell_version,
        "shell_url": args.shell_url,
        "fail_manifest": args.fail_manifest,
        "fail_shell": args.fail_shell,
        "inject_tizen": not args.no_tizen_stub,
    }


def serve(args):
    opts = build_opts(args)
    handler = make_handler(opts)
    with socketserver.ThreadingTCPServer((args.bind, args.port), handler) as httpd:
        httpd.allow_reuse_address = True
        url = f"http://localhost:{args.port}"
        print("=" * 64)
        print("  wgt-emulate — WGT browser harness")
        print("=" * 64)
        print(f"  payload root : {opts['root']}")
        print(f"  shell source : {'--real-shell ' + args.real_shell if args.real_shell else 'built-in stub shell'}")
        print(f"  shell sha256 : {sha256_bytes(opts['shell_bytes'])[:16]}…")
        if args.fail_manifest:
            print("  manifest     : FORCED 503 (tests shell.min.js?t= fallback)")
        if args.fail_shell:
            print("  shell.min.js : FORCED 503 (tests baked boot-shell fallback)")
        print()
        print(f"  1. Open   {url}/   in desktop Chrome/Chromium")
        print(f"  2. Type   {url}    into the connect form, press Connect")
        print("  3. Watch the on-screen HSB overlay walk the boot phases")
        print("  Ctrl-C to stop.")
        print("=" * 64)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n[wgt-emulate] stopped.")


def self_test(args):
    """Start the server on a thread and assert the HSB endpoints behave."""
    opts = build_opts(args)
    handler = make_handler(opts)
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", args.port), handler)
    httpd.allow_reuse_address = True
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{args.port}"
    failures = []

    def get(path):
        with urllib.request.urlopen(base + path, timeout=5) as r:
            return r.status, r.read(), r.headers.get("Content-Type", "")

    try:
        # 1. WGT payload index serves and contains the bootloader.
        st, body, ct = get("/index.html")
        text = body.decode("utf-8", "ignore")
        if st != 200 or "HSB bootloader" not in text and "jellyfin.shell.serverUrl" not in text:
            failures.append(f"index.html: status={st} bootloader-marker-missing")
        else:
            print("OK 1: WGT index.html serves with the HSB bootloader inlined")

        # 2. Tizen stub injected ahead of bootloader (unless disabled).
        if not args.no_tizen_stub:
            if "window.tizen" not in text:
                failures.append("index.html: tizen-stub not injected")
            else:
                print("OK 2: tizen-stub.js injected into <head>")

        # 3. manifest.json serves with a sha256 that matches the served shell.
        st, body, ct = get("/shell/manifest.json")
        m = json.loads(body)
        served_shell = get("/shell/shell.min.js")[1]
        if st != 200 or m.get("sha256") != sha256_bytes(served_shell):
            failures.append(f"manifest.json: status={st} sha mismatch")
        else:
            print(f"OK 3: /shell/manifest.json sha256 matches /shell/shell.min.js ({m['version']})")

        # 4. shell.min.js serves as JS.
        st, body, ct = get("/shell/shell.min.js")
        if st != 200 or "javascript" not in ct:
            failures.append(f"shell.min.js: status={st} ctype={ct}")
        else:
            print("OK 4: /shell/shell.min.js serves as application/javascript")
    finally:
        httpd.shutdown()
        httpd.server_close()

    if failures:
        for f in failures:
            print("FAIL:", f)
        sys.exit(1)
    print("ALL SELF-TEST CHECKS PASS")


def main():
    ap = argparse.ArgumentParser(description="Run the Tizen WGT in a desktop browser.")
    ap.add_argument("--port", type=int, default=8088)
    ap.add_argument("--bind", default="127.0.0.1",
                    help="interface to bind (default: localhost only; pass "
                         "0.0.0.0 to expose to the LAN, e.g. for a real TV)")
    ap.add_argument("--root", default=str(DEFAULT_ROOT),
                    help="WGT payload dir to serve (default: bootstrap src/)")
    ap.add_argument("--real-shell", default=None,
                    help="serve a real built shell.min.js instead of the stub")
    ap.add_argument("--shell-version", default="emu-0.0.0",
                    help="version string reported in manifest.json")
    ap.add_argument("--shell-url", default=None,
                    help="explicit shellUrl in manifest.json (default: null -> derived)")
    ap.add_argument("--fail-manifest", action="store_true",
                    help="serve manifest.json as 503 to test the shell.min.js?t= fallback")
    ap.add_argument("--fail-shell", action="store_true",
                    help="serve shell.min.js as 503 to test the baked boot-shell fallback")
    ap.add_argument("--no-tizen-stub", action="store_true",
                    help="do not inject the Tizen native-API stub into index.html")
    ap.add_argument("--self-test", action="store_true",
                    help="headless: start server, assert endpoints, exit 0/1")
    args = ap.parse_args()

    if args.self_test:
        self_test(args)
    else:
        serve(args)


if __name__ == "__main__":
    main()
