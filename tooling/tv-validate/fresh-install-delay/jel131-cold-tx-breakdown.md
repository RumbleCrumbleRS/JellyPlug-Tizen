# JEL-131 — fresh-boot login→home breakdown (tx-cache cold) + priming lever

2026-06-11. Offline characterization against the user's live server
(`REDACTED-SERVER.example`, public `/web/` + plugin assets — same bytes the TV
fetches), cross-referenced with the JEL-127 on-device stream
(`jel127-ntfy-raw.jsonl`). On-device cold/warm/primed validation is the
follow-up capture (see "Proposed on-device validation" below).

## What actually happens between login and home on a fresh install

1. The server runs JellyfinEnhanced (JE) 11.11.0. Its main script
   (`/JellyfinEnhanced/script`, 34.5 KB) polls
   `ApiClient.getCurrentUserId()` every 300 ms and starts its module chain
   **only after login succeeds** — so none of this work overlaps the
   connect/login idle time today.
2. Contrary to the JEL-557 analysis comment in shell.js ("serial
   createElement→onload chain… re-pays RTT per script"), this JE version
   loads its sub-modules **in parallel**: `loadScripts()` does
   `scripts.map(...)` and fires all 53 `<script src>` elements at once
   (plus `translations.js` in stage 1 → 54 total). RTT is NOT the
   bottleneck — the shell's dynamic intercept fetches run concurrently and
   the server answers in ~6-150 ms.
3. The real cold-cache cost is **Babel CPU, serialized on the main
   thread**. Measured against the live server (2026-06-11):
   - 54 sub-module scripts, 1938 KB total source;
   - **53 of 54 trip `MODERN_SYNTAX_RE`** → full `Babel.transform` per
     script (only `enhanced/icons.js` rides the JEL-554 fast path);
   - sandbox Node (x86, this repo's `babel.min.js`, the shipping
     transform options): **2112 ms total** for the whole set (worst
     single file: `arr/calendar-page.js`, 95.8 KB → 154 ms).
4. M63 scaling: JEL-127 measured the jellyfin-web parse blackout at
   22-24 s on the TV for work a desktop Chromium does in ~1-2 s → the
   established M63 main-thread factor is **~10-20×**. Applied to the
   2.1 s sandbox Babel total: **~21-42 s of post-login main-thread Babel
   on a cold tx cache**, time-sliced against (and starving) jellyfin-web's
   home data fetch + row render.

## The breakdown of the user's ~30 s

| component                                 | cold (fresh install)        | warm (tx cache hit) |
| ----------------------------------------- | --------------------------- | ------------------- |
| home data fetch + render (user's account) | ~9 s (JEL-125/127 measured) | ~9 s                |
| JE 54-script fetch (parallel, LAN)        | <1 s                        | 0                   |
| JE Babel transpile (main thread, 1.9 MB)  | **~21-42 s, overlapping**   | 0 (54 cache hits)   |
| **observed login→home**                   | **~30 s (user report)**     | **~9-10 s**         |

The cold/warm delta IS the Babel storm. The JEL-557 localStorage tx cache
already eliminates it on every subsequent boot — which is why only fresh
installs (and TX_VER-bumping shell updates) show the 30 s.

Corroboration from the JEL-127 stream: boots 3-6 (warm, seeded creds)
went straight to #/home with the JE chain silent in the beacon (no
intercept storm), and the home span tracked card count (~9-26 s on the
300-card Test account). Boot 1 (fresh) never authenticated, so the JE
chain never fired pre-login — confirming the post-auth gating.

## Why the user's 10 s target is achievable

The login idle window — the user typing credentials on a TV remote — is
free main-thread time that today goes unused, and it ends exactly when
the storm starts. Pre-transpiling the 54 modules during that window makes
a fresh install hit the warm path: login→home ≈ **~9-10 s** (home
data+render only), meeting the target whenever typing time ≳ storm time,
and shaving proportionally otherwise. Typing two fields by d-pad
realistically takes 30-90 s; the storm is ~21-42 s of CPU → full or
near-full coverage expected.

## Priming lever (shipped behind kill switch, this ticket)

Implementation in both seeds (`shell.js` + `boot-shell.src.js` dynamic
interceptor IIFE):

1. **Dynamic URL persistence (JEL-1654 pattern, dynamic side)**: every
   intercepted dynamic `<script src>` URL is recorded to
   `localStorage["jellyfin.shell.dynPluginUrls"]` (absolute, capped 100,
   debounced). Covers every re-cold scenario after first boot (TX_VER
   bump on shell update, manual cache clear).
2. **First-boot scrape**: plugin bodies inlined by the static pass
   (`script[data-shell-transpiled-from]`) are scanned for quoted `.js`
   literals (relative names + absolute paths) and absolute dir literals.
   Verified against the real transpiled JE body: recovers all 53 relative
   names, both absolute paths, and `/JellyfinEnhanced/js` among 5 dir
   candidates. A **probe-then-commit** step (fetch first name across
   candidate dirs, commit to the dir that answers 200) avoids 404
   spray: ~4 probe misses instead of ~160 combo misses.
3. **Login-idle gating**: priming arms only when `window.ApiClient`
   exists (bundles executed — never competes with the 22 s parse
   blackout) and `getCurrentUserId()` is empty (logged out). It aborts
   the moment auth appears (the on-demand interceptor takes over;
   primed entries are already cache hits). Fetches run 4-wide; Babel
   transforms run one per 120 ms macrotask so the login form stays
   responsive.
4. Primed entries are written via the same `maybeTranspile` + jQuery-gate
   - `__txSet` path the interceptor uses → byte-identical cache bodies,
     same `TX_VER` prefix, same LRU.
5. Kill switch: `localStorage["jellyfin.shell.txPrimeDisabled"]="1"`.
   Counters: `window.__shellTxPrime = {q,f,t,e,st,done}` + `pr=` field on
   the diag HUD tx line and `TP:` line on the QA overlay HUD.

Known inherited caveat (pre-existing, not introduced here): `__txKey`
strips the query string (JEL-554 v35), so a server-side JE version bump
that only changes `?v=` serves stale cached bodies until TX_VER bumps.
Priming neither worsens nor fixes this.

## Proposed on-device validation (one TV window)

JEL-127 playbook (ntfy + seeded creds), 3 boots on a QA build with
`p.tx` probe mirroring `__shellTxCacheHits/Misses` + `__shellTxPrime`:

1. **cold, prime disabled** — fresh state, seed creds, login → expect
   login→home ~30 s, misses ≈ 54;
2. **warm** — relaunch → expect ~9-10 s, hits ≈ 54;
3. **cold, prime enabled** — clear tx keys only, sit at login form ~45 s
   before submitting → expect login→home ~10 s, `__shellTxPrime.t ≈ 53`,
   hits ≈ 54.

Restore retail v2.0.9 afterwards (farewell-clear → retail install).
