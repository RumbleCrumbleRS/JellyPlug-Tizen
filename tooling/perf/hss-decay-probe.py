#!/usr/bin/env python3
"""JELA-693 — measure whether /HomeScreen/Sections has a warm window at all.

WHY THIS EXISTS
---------------
JELA-685 observed "warm to 48 ms, wait 30 s, next hit 7,752 ms" and concluded
the HomeScreenSections cache was being *invalidated* inside 30 seconds. Every
one of those readings was taken while the Intro Skipper backfill was saturating
the box (JELA-692). So the premise was never tested on a quiet server.

This probe tests it directly, and it is built to survive the two ways this
programme has been wrong before:

  1. **Gap order is randomised.** If gaps ran 2 s -> 120 s in order, any server
     drift over the session would masquerade as gap-dependence. Shuffled, drift
     lands on every gap equally.
  2. **A control rides alongside every datum.** `/System/Info` is probed
     immediately before each measured hit, so "the endpoint got slower" can be
     separated from "the box got slower". This is the check JELA-685 did not
     have, and it is why its numbers had to be thrown away.

It also records the response body hash. A response cache must return identical
bytes; if the bytes differ, whatever `CacheTimeoutSeconds` governs, it is not
the response.

Reads x-response-time-ms only — the server's own handling cost, never wall
time, which swings 25 ms -> 4.2 s on this container's TLS handshake (JELA-685).

Usage:
    JELLYFIN_URL=... JELLYFIN_API_KEY=... \
      tooling/perf/hss-decay-probe.py --user <userId> --out results.json

Run tooling/perf/preflight.sh FIRST. This script refuses to interpret its own
numbers; it emits raw rows and leaves the verdict to a human.
"""

import argparse
import hashlib
import json
import os
import random
import ssl
import sys
import time
import urllib.request

GAPS = [2, 5, 10, 20, 30, 45, 60, 120]
REPS = 2


def _req(url, key, timeout=90):
    """One GET. Returns (x_response_time_ms, body_sha12, nbytes, wall_ms)."""
    r = urllib.request.Request(url, headers={
        "Authorization": 'MediaBrowser Token="%s"' % key,
        "Accept": "application/json",
    })
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    t0 = time.time()
    with urllib.request.urlopen(r, timeout=timeout, context=ctx) as resp:
        body = resp.read()
        xrt = resp.headers.get("x-response-time-ms")
    wall = (time.time() - t0) * 1000.0
    return (
        float(xrt) if xrt else None,
        hashlib.sha256(body).hexdigest()[:12],
        len(body),
        round(wall, 1),
    )


def control(base, key, n=3):
    """Median server-side cost of a trivial request, taken right now."""
    vals = []
    for _ in range(n):
        try:
            xrt, _, _, _ = _req(base + "/System/Info", key, timeout=30)
            if xrt is not None:
                vals.append(xrt)
        except Exception:
            pass
    if not vals:
        return None
    vals.sort()
    return vals[len(vals) // 2]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--reps", type=int, default=REPS)
    ap.add_argument("--seed", type=int, default=693)
    args = ap.parse_args()

    base = os.environ["JELLYFIN_URL"].rstrip("/")
    key = os.environ["JELLYFIN_API_KEY"]
    url = "%s/HomeScreen/Sections?UserId=%s" % (base, args.user)

    plan = [g for g in GAPS for _ in range(args.reps)]
    random.Random(args.seed).shuffle(plan)

    rows = []
    print("plan (shuffled): %s" % plan, flush=True)

    for i, gap in enumerate(plan, 1):
        row = {"i": i, "gap_s": gap, "t_start": time.time()}
        try:
            # prime: put an entry in whatever cache exists
            row["prime"] = _req(url, key)
            # immediate re-hit: with a working response cache this is a hit
            row["immediate"] = _req(url, key)
            time.sleep(gap)
            # control rides right next to the datum
            row["control_ms"] = control(base, key)
            # the datum
            row["measured"] = _req(url, key)
        except Exception as e:
            row["error"] = "%s: %s" % (type(e).__name__, e)
        rows.append(row)
        p = row.get("prime") or [None]
        m = row.get("immediate") or [None]
        d = row.get("measured") or [None]
        print("%2d/%d gap=%3ds prime=%9s immediate=%9s after_gap=%9s ctrl=%s %s"
              % (i, len(plan), gap, p[0], m[0], d[0], row.get("control_ms"),
                 row.get("error", "")), flush=True)
        with open(args.out, "w") as f:
            json.dump(rows, f, indent=1)

    print("DONE -> %s" % args.out, flush=True)


if __name__ == "__main__":
    sys.exit(main())
