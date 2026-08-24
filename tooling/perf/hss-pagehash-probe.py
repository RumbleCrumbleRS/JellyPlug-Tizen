#!/usr/bin/env python3
"""JELA-693 — decisive test of the `pageHash` cache-key diagnosis.

THE CLAIM UNDER TEST
--------------------
`HomeScreenSectionService.MonitorLiveUpdatedSectionsForUser` does this when the
caller omits `pageHash` (HSS 2.5.11.0, still present at upstream HEAD):

    if (pageHash == null) {
        pageHash = Guid.NewGuid();          // a key nothing can ever have stored
        CacheSectionsForUser(userId, pageHash.Value);
        ...
    }

If that reading is right, then the cache is not "invalidated within 30 s" — it
is never *read*, because the key is fresh random on every request. Two falsifiable
predictions follow, and this script tests both against the live server:

  SAME  — reuse one explicit pageHash across a long gap. The entry should still
          be there (nothing in the plugin ever evicts from this dictionary), so
          every repeat hit should be orders of magnitude faster than the first.
  DIFF  — a fresh pageHash per request. Every hit pays the full build. This is
          the arm that reproduces current production behaviour.

If SAME repeats are fast and DIFF hits are uniformly slow, the diagnosis holds
and `CacheTimeoutSeconds` is exonerated. If SAME repeats are *also* slow, the
diagnosis is wrong and something really is invalidating entries — report that.

The two arms are INTERLEAVED, not run in blocks. Sequential arms cannot be
separated from server drift (JELA-679), and this ticket's entire history is
numbers taken through load that nobody checked. A `/System/Info` control is
sampled next to every datum for the same reason.

Usage:
    JELLYFIN_URL=... JELLYFIN_API_KEY=... \
      tooling/perf/hss-pagehash-probe.py --user <userId> --out results.json

Run tooling/perf/preflight.sh FIRST.
"""

import argparse
import hashlib
import json
import os
import ssl
import sys
import time
import urllib.parse
import urllib.request
import uuid

REPEATS = 4      # hits per cycle, after the priming hit
GAP_S = 20       # seconds between hits, comfortably past the alleged <30 s window
CYCLES = 3


def _get(url, key, timeout=90):
    r = urllib.request.Request(url, headers={
        "Authorization": 'MediaBrowser Token="%s"' % key,
        "Accept": "application/json",
    })
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(r, timeout=timeout, context=ctx) as resp:
        body = resp.read()
        xrt = resp.headers.get("x-response-time-ms")
    return (float(xrt) if xrt else None,
            hashlib.sha256(body).hexdigest()[:12],
            len(body))


def control(base, key, n=3):
    vals = []
    for _ in range(n):
        try:
            xrt, _, _ = _get(base + "/System/Info", key, timeout=30)
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
        # Pagination params must be present for the server to take the
        # cached path the plugin's own client uses.
        q["PageHash"] = page_hash
        q["Page"] = 1
        q["NumResultsPerPage"] = 10
    return base + "/HomeScreen/Sections?" + urllib.parse.urlencode(q)


def run_cycle(base, key, user, arm, out_rows):
    """One cycle of an arm. SAME pins the pageHash; DIFF re-rolls it."""
    pinned = str(uuid.uuid4())
    hits = []
    for j in range(REPEATS + 1):
        ph = pinned if arm == "SAME" else str(uuid.uuid4())
        url = sections_url(base, user, ph)
        ctrl = control(base, key)
        try:
            xrt, sha, n = _get(url, key)
            err = None
        except Exception as e:
            xrt, sha, n, err = None, None, None, "%s: %s" % (type(e).__name__, e)
        hits.append({"j": j, "pageHash": ph, "xrt": xrt, "sha": sha,
                     "bytes": n, "control_ms": ctrl, "error": err,
                     "role": "prime" if j == 0 else "repeat"})
        print("   %s j=%d %-6s xrt=%10s sha=%s ctrl=%s %s"
              % (arm, j, hits[-1]["role"], xrt, sha, ctrl, err or ""),
              flush=True)
        if j < REPEATS:
            time.sleep(GAP_S)
    out_rows.append({"arm": arm, "pinned": pinned, "hits": hits})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cycles", type=int, default=CYCLES)
    args = ap.parse_args()

    base = os.environ["JELLYFIN_URL"].rstrip("/")
    key = os.environ["JELLYFIN_API_KEY"]

    rows = []
    for c in range(1, args.cycles + 1):
        # interleave: order flips each cycle so drift cannot favour one arm
        arms = ["SAME", "DIFF"] if c % 2 else ["DIFF", "SAME"]
        for arm in arms:
            print("cycle %d/%d arm=%s" % (c, args.cycles, arm), flush=True)
            run_cycle(base, key, args.user, arm, rows)
            with open(args.out, "w") as f:
                json.dump(rows, f, indent=1)

    # Summary only; the verdict stays with a human.
    print("\n=== repeats only (prime excluded), ms ===", flush=True)
    for arm in ("SAME", "DIFF"):
        v = sorted(h["xrt"] for r in rows if r["arm"] == arm
                   for h in r["hits"] if h["role"] == "repeat" and h["xrt"])
        if v:
            print("%-5s n=%2d min=%.0f median=%.0f max=%.0f"
                  % (arm, len(v), v[0], v[len(v) // 2], v[-1]), flush=True)
    print("DONE -> %s" % args.out, flush=True)


if __name__ == "__main__":
    sys.exit(main())
