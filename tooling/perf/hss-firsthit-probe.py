#!/usr/bin/env python3
"""JELA-703 — cost the pin's FIRST HIT before shipping it.

The client-side pinned pageHash (see hss-pagehash-probe.py / JELA-693) makes
every repeat load in a (user, time-bucket) a ~4 ms cache hit. But the FIRST
request of each bucket takes the plugin's miss path, which spawns a build
thread and SpinWaits the request thread until the entry appears — plausibly
WORSE than today's no-pageHash path, which builds inline. JELA-703 must not
ship on the repeat-hit number alone; this probe measures the entry fee.

Two interleaved arms, order flipped per cycle, /System/Info control beside
every datum (JELA-692 discipline — run tooling/perf/preflight.sh FIRST):

  NULL  — GET /HomeScreen/Sections?UserId=<u>. Today's path: the server mints
          Guid.NewGuid() and builds inline.
  MISS  — GET with a FRESH PageHash=<uuid>&Page=1&NumResultsPerPage=1000 per
          request: exactly what the shell's jellyfin.shell.hssPin flag sends
          on the first load of a bucket (SpinWait path, guaranteed miss).

A final equivalence pass answers two more JELA-703 questions:
  - does the pinned (paginated-branch) response carry the same section list
    shape as the null path at NumResultsPerPage=1000 (nothing truncated)?
  - how big is one leaked cache entry (bytes served per (user, bucket))?
It fetches 2 NULL + 2 MISS bodies, compares JSON shape (top-level keys,
Items count, TotalRecordCount, section-name multiset), then re-hits one of
the MISS keys to confirm the entry it seeded now serves as a repeat hit.

Usage:
    JELLYFIN_URL=... JELLYFIN_API_KEY=... \
      tooling/perf/hss-firsthit-probe.py --user <userId> --out results.json
"""

import argparse
import collections
import hashlib
import json
import os
import ssl
import sys
import time
import urllib.parse
import urllib.request
import uuid

PER_ARM = 12  # first-hits per arm
GAP_S = 20  # past the ~10 s Jellyfin/SQLite warm window (JELA-693)


def _get(url, key, timeout=90):
    r = urllib.request.Request(
        url,
        headers={
            "Authorization": 'MediaBrowser Token="%s"' % key,
            "Accept": "application/json",
        },
    )
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(r, timeout=timeout, context=ctx) as resp:
        body = resp.read()
        xrt = resp.headers.get("x-response-time-ms")
    return (float(xrt) if xrt else None, body)


def control(base, key, n=3):
    vals = []
    for _ in range(n):
        try:
            xrt, _ = _get(base + "/System/Info", key, timeout=30)
            if xrt is not None:
                vals.append(xrt)
        except Exception:
            pass
    if not vals:
        return None
    vals.sort()
    return vals[len(vals) // 2]


def sections_url(base, user, page_hash):
    q = {"UserId": user}
    if page_hash:
        q["PageHash"] = page_hash
        q["Page"] = 1
        q["NumResultsPerPage"] = 1000  # what the shell's hssPin flag sends
    return base + "/HomeScreen/Sections?" + urllib.parse.urlencode(q)


def shape(body):
    try:
        d = json.loads(body)
    except Exception:
        return {"parse_error": True, "bytes": len(body)}
    items = d.get("Items") or []
    return {
        "bytes": len(body),
        "sha12": hashlib.sha256(body).hexdigest()[:12],
        "top_keys": sorted(d.keys()),
        "items": len(items),
        "total_record_count": d.get("TotalRecordCount"),
        "sections": sorted(
            collections.Counter(
                str(i.get("Section")) for i in items
            ).items()
        ),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--per-arm", type=int, default=PER_ARM)
    args = ap.parse_args()

    base = os.environ["JELLYFIN_URL"].rstrip("/")
    key = os.environ["JELLYFIN_API_KEY"]

    rows = []
    seeded = []  # (pageHash, sha12) from MISS hits, for the repeat check
    for c in range(args.per_arm):
        # interleave: order flips each cycle so drift cannot favour one arm
        arms = ["NULL", "MISS"] if c % 2 == 0 else ["MISS", "NULL"]
        for arm in arms:
            ph = str(uuid.uuid4()) if arm == "MISS" else None
            url = sections_url(base, args.user, ph)
            ctrl = control(base, key)
            try:
                xrt, body = _get(url, key)
                err = None
            except Exception as e:
                xrt, body, err = None, b"", "%s: %s" % (type(e).__name__, e)
            rows.append(
                {
                    "cycle": c,
                    "arm": arm,
                    "pageHash": ph,
                    "xrt": xrt,
                    "bytes": len(body),
                    "sha12": hashlib.sha256(body).hexdigest()[:12],
                    "control_ms": ctrl,
                    "error": err,
                }
            )
            if arm == "MISS" and not err:
                seeded.append(ph)
            print(
                "cycle %2d %-4s xrt=%10s bytes=%5d ctrl=%s %s"
                % (c, arm, xrt, len(body), ctrl, err or ""),
                flush=True,
            )
            with open(args.out, "w") as f:
                json.dump({"rows": rows}, f, indent=1)
            time.sleep(GAP_S)

    # ---- equivalence + entry sizing + seeded-entry repeat check ----------
    eq = {"null": [], "miss": [], "repeat": None}
    for arm in ("null", "miss"):
        for _ in range(2):
            ph = str(uuid.uuid4()) if arm == "miss" else None
            try:
                _, body = _get(sections_url(base, args.user, ph), key)
                eq[arm].append(shape(body))
            except Exception as e:
                eq[arm].append({"error": str(e)})
            time.sleep(2)
    if seeded:
        try:
            xrt, body = _get(sections_url(base, args.user, seeded[-1]), key)
            eq["repeat"] = {"xrt": xrt, **shape(body)}
        except Exception as e:
            eq["repeat"] = {"error": str(e)}

    with open(args.out, "w") as f:
        json.dump({"rows": rows, "equivalence": eq}, f, indent=1)

    # Summary only; the verdict stays with a human.
    print("\n=== first hits, ms ===", flush=True)
    for arm in ("NULL", "MISS"):
        v = sorted(r["xrt"] for r in rows if r["arm"] == arm and r["xrt"])
        if v:
            print(
                "%-4s n=%2d min=%.0f median=%.0f max=%.0f"
                % (arm, len(v), v[0], v[len(v) // 2], v[-1]),
                flush=True,
            )
    print("equivalence: %s" % json.dumps(eq)[:400], flush=True)
    print("DONE -> %s" % args.out, flush=True)


if __name__ == "__main__":
    sys.exit(main())
