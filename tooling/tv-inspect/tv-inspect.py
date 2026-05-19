#!/usr/bin/env python3
"""
tv-inspect — remote inspection of a Tizen TV web app via Chrome DevTools Protocol.

Runs `tizen run --debug` against a target TV, parses the Web Inspector port,
connects to the Chrome DevTools Protocol over WebSocket, evaluates a set of
JS expressions inside the page, captures a full-page screenshot, writes the
results to disk, and optionally uploads them to a Paperclip issue as
attachments.

Usage:
    pip install websocket-client requests
    python tv-inspect.py --target QN82Q60RAFXZA --pkg JelShellTV.Jellyfin \\
        [--issue-id <paperclip-issue-uuid>] [--out ./out]

Environment (only required when --issue-id is passed):
    PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID, PAPERCLIP_RUN_ID

Exit codes:
    0  ok                   (screenshot + globals captured)
    2  cli/usage error
    3  tizen run failed     (TV not connected / app not installed / shell blocked)
    4  inspector unreachable (port forward never came up)
    5  CDP eval failed
    6  upload failed
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

try:
    import websocket  # type: ignore
except ImportError:
    sys.stderr.write(
        "Missing dependency: websocket-client. Install with:\n"
        "    pip install websocket-client\n"
    )
    sys.exit(2)


# ---------- helpers ---------------------------------------------------------


def which(cmd: str) -> str | None:
    p = shutil.which(cmd)
    if p:
        return p
    # On Windows, tizen + sdb often live outside PATH. Try defaults.
    candidates = [
        Path(r"C:\tizen-studio\tools\ide\bin") / f"{cmd}.bat",
        Path(r"C:\tizen-studio\tools") / f"{cmd}.exe",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return None


def run(cmd: list[str], timeout: float = 60.0, capture: bool = True) -> tuple[int, str, str]:
    """Run a subprocess, return (rc, stdout, stderr). Never raises on non-zero."""
    print(f"[run] {' '.join(cmd)}", flush=True)
    p = subprocess.run(
        cmd,
        capture_output=capture,
        text=True,
        timeout=timeout,
        check=False,
    )
    if capture:
        if p.stdout:
            print(p.stdout, end="", flush=True)
        if p.stderr:
            print(p.stderr, end="", file=sys.stderr, flush=True)
    return p.returncode, p.stdout or "", p.stderr or ""


def wait_port(host: str, port: int, timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1.0):
                return True
        except OSError:
            time.sleep(0.4)
    return False


# ---------- tizen + cdp -----------------------------------------------------


def launch_debug(tizen_bin: str, pkg: str, target: str) -> int:
    """
    Run `tizen run --debug` and return the local devtools port.

    `tizen run --debug` output looks like:
        ... Trying to connected: ...
        ... port: 38231
        ... or: "open http://localhost:38231 ..."
    We accept either form.
    """
    rc, out, err = run([tizen_bin, "run", "--debug", "-p", pkg, "-t", target], timeout=90)
    blob = out + "\n" + err
    if rc != 0:
        # `tizen run --debug` sometimes prints "port: N" then exits non-zero on
        # an unrelated tail step. Don't bail until we've tried to parse a port.
        print(f"[warn] tizen run rc={rc}, will still try to parse port", flush=True)

    # Patterns to try, most specific first.
    patterns = [
        r"port[:\s]+(\d{4,5})",
        r"localhost:(\d{4,5})",
        r"127\.0\.0\.1:(\d{4,5})",
    ]
    for pat in patterns:
        m = re.search(pat, blob, re.IGNORECASE)
        if m:
            port = int(m.group(1))
            print(f"[ok] parsed devtools port: {port}", flush=True)
            return port

    if rc != 0:
        sys.exit(3)
    sys.exit(4)


def cdp_targets(port: int) -> list[dict]:
    url = f"http://127.0.0.1:{port}/json"
    with urllib.request.urlopen(url, timeout=5) as r:
        return json.loads(r.read().decode("utf-8"))


def cdp_pick_page(targets: list[dict]) -> dict:
    pages = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
    if not pages:
        raise RuntimeError(f"no page targets in {targets!r}")
    # Prefer non-DevTools URL.
    for p in pages:
        if "devtools" not in (p.get("url") or ""):
            return p
    return pages[0]


class CDP:
    def __init__(self, ws_url: str) -> None:
        self.ws = websocket.create_connection(ws_url, timeout=10)
        self._id = 0

    def send(self, method: str, params: dict | None = None) -> dict:
        self._id += 1
        msg = {"id": self._id, "method": method, "params": params or {}}
        self.ws.send(json.dumps(msg))
        while True:
            raw = self.ws.recv()
            if not raw:
                continue
            data = json.loads(raw)
            # CDP also pushes events with no `id`. Skip them.
            if data.get("id") == self._id:
                return data

    def close(self) -> None:
        try:
            self.ws.close()
        except Exception:
            pass


def evaluate(cdp: CDP, expr: str) -> Any:
    resp = cdp.send(
        "Runtime.evaluate",
        {"expression": expr, "returnByValue": True, "awaitPromise": True},
    )
    r = resp.get("result", {}).get("result", {})
    if "value" in r:
        return r["value"]
    return {"_type": r.get("type"), "_subtype": r.get("subtype"), "_desc": r.get("description")}


# ---------- paperclip upload ------------------------------------------------


def upload_attachment(issue_id: str, path: Path) -> bool:
    api = os.environ.get("PAPERCLIP_API_URL")
    key = os.environ.get("PAPERCLIP_API_KEY")
    company = os.environ.get("PAPERCLIP_COMPANY_ID")
    run_id = os.environ.get("PAPERCLIP_RUN_ID", "")
    if not (api and key and company):
        print("[skip] PAPERCLIP_* env not present, attachments stay local", flush=True)
        return False
    try:
        import requests  # type: ignore
    except ImportError:
        print("[skip] requests not installed, attachments stay local", flush=True)
        return False
    url = f"{api}/api/companies/{company}/issues/{issue_id}/attachments"
    with path.open("rb") as fh:
        files = {"file": (path.name, fh)}
        headers = {
            "Authorization": f"Bearer {key}",
            "X-Paperclip-Run-Id": run_id,
        }
        r = requests.post(url, files=files, headers=headers, timeout=60)
    if r.status_code >= 400:
        print(f"[upload] {path.name} -> HTTP {r.status_code}: {r.text[:300]}", flush=True)
        return False
    print(f"[upload] {path.name} ok", flush=True)
    return True


# ---------- main ------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", required=True, help="sdb target name, e.g. QN82Q60RAFXZA")
    ap.add_argument("--pkg", default="JelShellTV.Jellyfin", help="Tizen app id")
    ap.add_argument("--out", default="./out", help="output dir")
    ap.add_argument("--issue-id", default=None, help="Paperclip issue id; upload artifacts")
    ap.add_argument(
        "--skip-launch",
        action="store_true",
        help="don't run `tizen run --debug`; assume inspector already on --port",
    )
    ap.add_argument("--port", type=int, default=None, help="devtools port (skips parse)")
    args = ap.parse_args()

    tizen_bin = which("tizen")
    if not tizen_bin and not args.skip_launch:
        sys.stderr.write("tizen CLI not on PATH and not at C:\\tizen-studio\\tools\\ide\\bin\\\n")
        return 2

    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    if args.port:
        port = args.port
    elif args.skip_launch:
        sys.stderr.write("--skip-launch requires --port\n")
        return 2
    else:
        port = launch_debug(tizen_bin, args.pkg, args.target)  # type: ignore[arg-type]

    if not wait_port("127.0.0.1", port, timeout=20):
        sys.stderr.write(f"devtools port {port} did not open within 20s\n")
        return 4

    targets = cdp_targets(port)
    page = cdp_pick_page(targets)
    print(f"[ok] page url={page.get('url')}  title={page.get('title')!r}", flush=True)

    cdp = CDP(page["webSocketDebuggerUrl"])
    try:
        cdp.send("Page.enable")
        cdp.send("Runtime.enable")

        # Give the app a moment to settle if it just launched.
        time.sleep(2.0)

        probes = {
            "hsbShellUrl": "window.__hsbShellUrl",
            "hsbFallback": "window.__hsbFallback",
            "locationHref": "location.href",
            "documentTitle": "document.title",
            "bodyText": "(document.body && document.body.innerText || '').slice(0, 1000)",
            "userAgent": "navigator.userAgent",
            "errors": (
                "(window.__hsbErrors && JSON.stringify(window.__hsbErrors)) || "
                "(window.__hsbLastError ? String(window.__hsbLastError) : null)"
            ),
            "storageServerUrl": "(function(){try{return localStorage.getItem('serverUrl');}catch(e){return String(e);}})()",
        }
        globals_out: dict[str, Any] = {}
        for k, expr in probes.items():
            try:
                globals_out[k] = evaluate(cdp, expr)
            except Exception as e:
                globals_out[k] = {"_error": str(e)}
        print("[globals]", json.dumps(globals_out, indent=2), flush=True)

        # Screenshot.
        shot = cdp.send(
            "Page.captureScreenshot",
            {"format": "png", "captureBeyondViewport": False},
        )
        b64 = shot.get("result", {}).get("data")
        if not b64:
            sys.stderr.write(f"no screenshot data, raw resp: {json.dumps(shot)[:500]}\n")
            return 5
        png_bytes = base64.b64decode(b64)
        ts = time.strftime("%Y%m%dT%H%M%S")
        png_path = out / f"tv-screenshot-{ts}.png"
        png_path.write_bytes(png_bytes)
        print(f"[ok] screenshot -> {png_path}  ({len(png_bytes)} bytes)", flush=True)

        json_path = out / f"tv-globals-{ts}.json"
        json_path.write_text(json.dumps(globals_out, indent=2))
        print(f"[ok] globals    -> {json_path}", flush=True)
    finally:
        cdp.close()

    if args.issue_id:
        ok1 = upload_attachment(args.issue_id, png_path)
        ok2 = upload_attachment(args.issue_id, json_path)
        if not (ok1 and ok2):
            return 6

    return 0


if __name__ == "__main__":
    sys.exit(main())
