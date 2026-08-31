# JELA-833 — coalesce the discovered tx hashes; stop unioning the manifest

Follow-up to **JELA-824**, split out of its QA acceptance FAIL.

## What JELA-824 shipped, and why it was wrong

`ceTxdState` POSTed `Object.keys(e)` — the entire 192-entry tx manifest — because
the needed set is discovered lazily (each script hashes its own fetched source),
and unioning was the only way to know the id set up front.

A cold boot only ever needs the 65–68 bodies whose source hashes actually turn
up, and those are the _small_ ones. The manifest also holds three ~838 KB
bodies. QA measured, on live prod against served shell `f3fdc2df` (n=2,
byte-identical):

|                       |      baseline (per-body) |             JELA-824 bundle |
| --------------------- | -----------------------: | --------------------------: |
| requests              |                    65–68 |                           1 |
| **wire bytes**        |    **193,738 – 223,419** |              **18,820,722** |
| bytes to `JSON.parse` |                      n/a |                  83,718,900 |
| server time           |          165–328 ms/body |                    5,542 ms |
| cache policy          | `immutable` (once, ever) | `no-store` (**every boot**) |

The cache asymmetry is what turned a 85–97x byte ratio into an unbounded cost:
the per-body route is content-addressed and `immutable`, so a real panel fetches
those bodies **once, ever**. The bundle is correctly `no-store`, so it was
re-paid on **every boot**.

## The measurement that decided the design

The obvious worry with "batch instead of union" is that lazy discovery might be
_serial_ — the JEL-621 primer's `drain()` is explicitly one-hash-at-a-time
behind a 120 ms macrotask — in which case a debounce window would coalesce
nothing and produce 68 single-id POSTs, which is strictly worse than 68
`immutable` GETs.

So the arrival pattern was measured before anything was written. JELA-112 rig,
cold boot, `txBundleDisabled=1` (per-body baseline), served shell `f3fdc2df`:

```
68 /shell/tx/*.js   223,329 B
median inter-arrival   2 ms
p90 inter-arrival      8 ms
distinct 100 ms buckets  7      (max 42 per bucket)
arrival clusters: 650 | 5990, 6052 | 6600-6899 (62 of the 68) | 10100-10199 (3)
```

Discovery is lazy but **bursty**, because the SPA splices its script tags in
bursts. On that boot `__shellTxPrime.st === "auth"` — the primer never ran at
all, so every one of the 68 came from the `txDropResolve` splice path. Batching
what was actually discovered was therefore viable, and the issue's proposed
shape was the right one.

## The design

`txBundleAttach(d, serverUrl)` installs a coalescer on `window.__shellTxDrop`
and exposes one method, `d.want(hash) -> Promise<string|null>`. Both consumers
— the widget-side `txDropResolve` and the inline seed's `__txDropGet` — go
through it, so they share **one** queue rather than running two.

- **One POST in flight at a time.** Hashes discovered while a POST is out ride
  the next one for free, so a slow round trip widens batches instead of
  multiplying them.
- **The debounce window doubles per batch**, `TXB_W0 = 60 ms` → `TXB_WMAX =
1000 ms`. This bounds the batch count by the _log of the discovery span_
  rather than linearly in the hash count — the property that makes AC1
  robust to a boot whose bursts are spread differently than the one measured.
- **`TXB_MIN = 2`: a lone hash is not a bundle POST.** One `no-store` POST and
  one `immutable` GET cost the same round trip, and only the GET is still there
  on the next boot. This is also what keeps the primer's serial-drain shape on
  the cacheable path if it ever does run.
- **`TXB_MAX = 64` ids per POST**, bounding a single response. The server's
  `ClientBatchMax` is pinned to the same number by a test.
- **No global barrier.** JELA-824 had `txDropResolve` await a single
  `d.bulkReady`, serialising the entire slow-path transpile behind one
  all-or-nothing download. Each hash now awaits only its own batch.
- **Every failure resolves `null`**, meaning "use the per-body GET": a non-ok
  response, a rejected fetch, malformed JSON, or a hash the server omitted from
  an otherwise-good map. The bundle can never be worse than the fallback.

`d.want` is left **undefined** when `jellyfin.shell.txBundleDisabled === "1"`,
and that absence is exactly what routes both consumers to the per-body path —
so the kill switch is one branch, in the same boot, on both call sites.

QA counters on `window.__shellTxDrop`: `bulkBatches`, `bulkWanted`, `bulkSolo`,
`bulkBodies`.

## Server: the cap

`MaxIds = 200` was a literal against a manifest already at 192 — 96% of it — and
past the cap the handler did `ids = ids[..MaxIds]` and answered **200 OK with a
short map**. That is undetectable on the client, because a hash missing from the
map is exactly how the server says "I don't have that body": the client would
have quietly fallen back to per-body GETs forever and nobody would have seen the
cap bind.

The cap is now derived from the drop itself (`ShellDropService.TxBodyCount()`,
mtime-cached against the tx directory, failing closed to 0), floored at
`ClientBatchMax`, and an over-cap request returns an explicit **413**.

## Acceptance — measured

JELA-112 rig, cold boot, fresh profile per arm, local shell `2f5d35c0` served to
the rig via a proxy that passes every other `/shell/*` path through to live prod
(JELA-681 pattern), so **the shell body is the only variable**. `/shell/tx`,
`/shell/tx-bundle`, the manifest and the API all still hit prod.

| AC  | gate                                                               | measured                             | verdict  |
| --- | ------------------------------------------------------------------ | ------------------------------------ | -------- |
| 1   | `/shell/tx` + `/shell/tx-bundle` requests ≤ 8                      | **6** (3 GET + 2 POST + 1 preflight) | **PASS** |
| 2   | total wire bytes at or under 193,738–223,419 B                     | **193,659 B**                        | **PASS** |
| 3   | `no-store` + `Vary: Origin` on the bundle; `immutable` on per-body | both confirmed on the wire           | **PASS** |
| 4   | kill switch falls back to per-body in the same boot                | see the differential below           | **PASS** |

AC2 lands **below the floor of the baseline range** — 79 B under the low end, and
29,670 B under this box's own re-measured baseline of 223,329 B. One gzip stream
over 65 bodies compresses better than 65 independent ones, which more than pays
for the JSON escaping. Against the shipped JELA-824 bundle it is a **97.2x**
reduction.

Request timeline of the BUNDLE arm:

```
  808 ms  GET  /shell/tx/…  11,128 B   (solo -> per-body, TXB_MIN)
 7369 ms  GET  /shell/tx/…   7,511 B   (solo)
 7560 ms  GET  /shell/tx/…   2,753 B   (solo)
11361 ms  OPTIONS /shell/tx-bundle  125 B  204
11386 ms  POST /shell/tx-bundle  62 ids  142,637 B
11882 ms  POST /shell/tx-bundle   3 ids   29,505 B
```

Counters agree exactly: `wanted=68`, `bulkBodies=65`, `batches=2`, and
`68 − 65 = 3` solo fallbacks. `h=68, m=63, r=0, f=0` — every body still
resolved, zero oracle rejects, zero fetch failures, so the byte saving cost no
correctness.

### AC4 — the kill-switch differential

Two boots of the **same shell body** (`2f5d35c0`), fresh profile each, differing
by exactly one pre-nav localStorage key:

|                                | BUNDLE (key absent) | PERBODY (`txBundleDisabled=1`) |
| ------------------------------ | ------------------: | -----------------------------: |
| tx requests                    |               **6** |                         **68** |
| per-body GETs                  |                   3 |                             68 |
| bundle POSTs (incl. preflight) |                   3 |                          **0** |
| tx wire bytes                  |             193,659 |                        223,322 |
| `__shellTxDrop.bulkBodies`     |                  65 |                              0 |
| `__shellTxDrop.bulkBatches`    |                   2 |                    _undefined_ |
| `h / m / r / f`                |     68 / 63 / 0 / 0 |                68 / 63 / 0 / 0 |

`bulkBatches` being _undefined_ rather than 0 is the real proof: with the kill
switch set, `txBundleAttach` returns before installing any state at all, so
there is no coalescer to disable later in the boot.

Both arms resolve all 68 bodies with zero oracle rejects and zero fetch
failures. The PERBODY arm also independently reproduces the baseline measured
before any code was written (223,322 B / 68 requests here vs 223,329 B / 68
there — 7 B apart on different profiles), which is what makes the AC2
comparison a like-for-like one rather than a comparison against a number from
another box.

Response headers, on the wire:

```
/shell/tx-bundle   cache-control: no-store        vary: Origin
                   content-encoding: gzip         content-type: application/json
/shell/tx/*.js     cache-control: public, max-age=31536000, immutable
                   vary: Accept-Encoding, Origin
```

## Notes for whoever measures this next

- **Assert bytes, don't infer them.** JELA-824 passed every per-request test it
  had; what was wrong was the _size of the id set_, which no per-request test
  looks at. The first thing the unit test pins is now the negative — that
  `ceTxdState` issues no request at all and no batch contains a hash nobody
  asked for.
- **The primer did not run on the measured boots** (`__shellTxPrime.st ===
"auth"`, the JELA-749 logged-in-boot shape). A logged-out boot would exercise
  the serial-drain discovery path, where `TXB_MIN` is what keeps the requests on
  the `immutable` route. That path is covered by the unit test, not by a rig
  capture.
- **The tx work is post-paint on this rig** (firstCard 4.25 s, the bundle POSTs
  at 11.4 s), so `prePaint` counts are not the interesting number here — the
  AC1 gate is read against the totals. On a real panel with the JELA-824 census
  timings the same requests sit pre-paint.
- Wall-clock numbers in this capture are **not** usable: the box carried
  loadavg 2.2 → 5.3 during it. Request counts and `encodedDataLength` are
  load-independent, which is why the ACs are written against those.
