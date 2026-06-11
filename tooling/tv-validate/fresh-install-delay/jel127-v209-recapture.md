# JEL-127 — bootstrap v2.0.9 on-device fresh-install timing re-capture

2026-06-11, physical M63 (QN82Q60RAFXZA, Tizen 5.0 / Chromium M63 silicon),
board-approved idle window (confirmation card 4745a0b8 on JEL-127, accepted
15:08 UTC). QA capture build = `qa/jel127-capture` (sign runs 27357474254 v1 /
27357867916 v2), base `main@f1ac03b` (retail v2.0.9 + JEL-125 prefetch/babel
overlap `49cfbf2` + JEL-126 boot progress dots `11da356`). Beacons over
`ntfy.envs.net/jel127-cap-ba2b0f83` (raw stream: `jel127-ntfy-raw.jsonl`).

Method = JEL-116 fresh-state pattern, one deterministic schedule baked into the
build via a `jellyfin.qa.jel127Boot` counter (the TV had NO JelShellTV installed
at window start — the user had uninstalled it — so boot 1 was a true fresh
install, and the one-shot clear was a 0-key no-op):

| boot | state                   | fastPathDisabled | creds                  | endpoint reached  |
| ---- | ----------------------- | ---------------- | ---------------------- | ----------------- |
| 1    | fresh, auto-submit t+5s | 1 (script-src)   | none (by design)       | manual login form |
| 2    | warm                    | 1                | none (seed bug, fixed) | manual login form |
| 3    | warm                    | 1                | seeded t+1.96s         | #/home, 300 cards |
| 4    | warm                    | 0 (inline)       | present                | #/home, 301 cards |
| 5    | warm                    | 0                | present                | #/home, 268 cards |
| 6    | warm                    | 0                | present                | #/home, 236 cards |

`bp` = `window.__shellBootProgressClearedMs`, mirrored into the qa-beacon probe
(QA-only `p.bp` patch): ms from boot-progress-overlay injection (at
`document.write`) to first real jellyfin-web paint — i.e. the parse blackout
span. `write` = `tDocumentWrite` from the JEL-61 bootMarks IIFE (ported into
the QA bootstrap index.html).

## Results

| boot | write (ms) | bp = blackout (ms) | first render (s from parse) | to home cards (s) |
| ---- | ---------- | ------------------ | --------------------------- | ----------------- |
| 1    | 8828       | 23723              | ~33 (login form)            | n/a (unseeded)    |
| 2    | 2973       | 22388              | ~28 (login form)            | n/a               |
| 3    | 3537       | 22592              | ~26                         | ~52 (300 cards)   |
| 4    | 1904       | **3639**           | ~5                          | **~9** (301)      |
| 5    | 1428       | 22061              | ~25                         | ~27 (268)         |
| 6    | n/a        | 22547              | ~24 (#/home)                | ~35 (236)         |

(Boot 6's `tDocumentWrite` would only surface in a 7th boot's `priorBootMarks`
rotation; not worth another TV cycle. Boots 4-5 writing at 1.4-1.9s — vs 3.0-3.5s
on fp=1 boots — shows the inline fast path does skip the bundle fetch, yet the
blackout stays ~22s: execute-bound, not fetch-bound.)

Boot 1 detail (epochs, parse t0 = 1781191279): `no-server-url` form at t+0.4s →
auto-submit t+5.0s → manifest probe 404 (no hosted `/shell/`, expected) →
baked-shell-loaded t+8.4s → `document.write` t+8.8s → blackout 23.7s with the
JEL-126 dots animating → **manual login form rendered ~t+33s**. The server
(`REDACTED-SERVER.example`) exposes no public user picker, so the user-facing
first span is submit→login-form: **~28s** (was ~50s+ on v2.0.7 per the JEL-125
decomposition of the JEL-116 stream). Zero JS errors on every boot (one
transient first-tick error on boots 1-2; gone by the next tick; 0 thereafter).

## Findings

1. **v2.0.9 parse blackout ≈ 22-24s, down from ~40s on v2.0.7** (JEL-125
   decomposition). The JEL-125 prefetch/babel overlap moved the `/web` RTT pair
   and the babel kick out of the serialized pre-write path, and `write` now
   lands at ~3s warm / ~8.8s fresh-with-5s-submit-delay (was ~4s + ~9.4s).
2. **JEL-126 boot dots CONFIRMED on-device**: `bp` reported on all 6 boots —
   overlay injected at write, `-1` (on, animating) through every blackout tick,
   concrete cleared-ms at first real paint. The blackout is no longer a frozen
   splash.
3. **V8 code-cache question answered: the localStorage bundle-inlining fast
   path does NOT measurably defeat (or beat) the code cache.** Warm blackout
   with `<script src>` (fp=1, boots 2-3, code cache produce+consume): 22.4s /
   22.6s. With inline fast path (fp=0, boots 5-6): 22.1s / 22.5s. Within noise
   — the blackout is dominated by main-thread EXECUTE (custom-element
   registration storm), not by bundle re-parse, so JEL-1980 inlining stays
   net-positive (skips the bundle network fetch) and no change is warranted.
4. Boot 4 (fp=0) was an outlier at bp=3.6s / home in ~9s — not reproduced by
   boots 5-6 under identical flags. Most plausibly renderer/process reuse or a
   hot scheduling window; treated as anomaly, not as a fast-path win.
5. Home data+render after first paint: ~9-26s depending on row count (236-301
   cards on the Test account), server-side variance — consistent with JEL-125's
   "~9s home span" on the user's smaller account.

## Realistic user expectations (v2.0.9, this TV)

- Fresh install / first connect: **server submit → login screen ~25-30s**,
  with animated dots from ~9s in (previously a ~50s frozen splash).
- Sign-in → home: **~20-30s** (parse blackout again post-auth navigation is
  NOT re-paid — sign-in lands in the already-parsed app; home rows are
  data-bound in ~9-26s).
- Warm relaunch (stored server + signed in): **~25-35s to home cards**.
- The remaining ~22s blackout is jellyfin-web executing on 2019 TV silicon;
  no shell-side lever found (fast path on/off indistinguishable). Further cuts
  need jellyfin-web-side changes (bundle splitting / deferred element
  registration), out of shell scope.

## End state

- TV restored: farewell-clear build (sign run 27357510820) booted once →
  unconditional `localStorage.clear()`; retail
  `JellyPlugBootstrap_v2.0.9.wgt` (sha256 `9890d119…fa5ee`, release
  bootstrap-v2.0.9) installed over it, REST reads `name=JellyPlug
version=2.0.9`. User re-enters server + signs in once (as approved).
- QA branches deleted (`qa/jel127-capture`, `qa/jel127-restore`; also pruned
  stale merged `fix/jel119-security-pass`) — origin is main-only.
- Test-account token from the capture window remains valid server-side; it was
  only ever stored on the TV and was wiped by the farewell clear. Revoke via
  Jellyfin dashboard → Devices ("JEL127-QA") if desired.

## Harness gotchas (for the next capture)

- jellyfin-web writes `jellyfin_credentials` (server entry, NO token) at
  server-connect — gate login seeds on AccessToken absence, not key presence.
- On warm boots `document.write` lands ~3-4.5s in; a cfg-fetch + auth XHR chain
  loses that race. Post a READY credential object to the cfg topic and do a
  single XHR + synchronous `setItem` (v2 of this harness).
- ntfy.envs.net per-IP rate limit (HTTP 429) hits after heavy polling —
  poll sparingly, save the raw stream early; the cache serves ~12h.
- vd_applist `app_version` actually updated to 2.0.9 on this install —
  the stale-cache behaviour (JEL-114) is not universal.
