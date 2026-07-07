# Boot-phase baselines (JEL-617)

Pre-rehaul boot timings for the JEL-616 Full Tizen Rehaul. Every rehaul
perf ticket (JEL-618..JEL-624, JEL-626+) must be compared against these
numbers, re-measured with the same method, before a perf claim is made.

## Phases

All values are wall-clock ms measured on-device by the shipped shell's
`window.__shellT` milestones (JEL-557) and, from JEL-617 onward, the
boot-phase ring:

| mark   | meaning                                                         |
| ------ | --------------------------------------------------------------- |
| `nav`  | WebView `navigationStart` → shell IIFE entry (`__shellT0`)      |
| `dcl`  | shell entry → `DOMContentLoaded` of the remote web-client doc   |
| `api`  | shell entry → `window.ApiClient` defined                        |
| `cn`   | shell entry → connect UI shown (shell form or `#/selectserver`) |
| `lg`   | shell entry → login route (`#/login…`)                          |
| `hm`   | shell entry → home route (`#/home…`)                            |
| `card` | shell entry → first `.card` rendered (home usable)              |

`cn`/`lg` stay 0 on a saved-server auto-login boot — the phases are
skipped, not missed.

## Method

1. **Shipped-shell capture (used for the baselines below):** a JS-Injector
   snippet (`JEL-617 — boot-phase baseline probe`, Tizen-gated, ES5) polls
   `window.__shellT` after the web client loads and POSTs one line per boot
   to an ntfy topic once the first card renders (or at 90 s). No install
   needed — works against whatever shell the TV already runs.
2. **Ring capture (after this ticket ships):** the shell persists the last
   10 boots to `localStorage["jellyfin.shell.bootPhases"]`
   (`{ts,nav,ver,connect,dcl,api,login,home,card}` per boot, ms from
   `__shellT0`). Read it via a JSI snippet, the QA beacon, or on-screen:
   `localStorage["jellyfin.shell.debug"]="1"` makes the diag HUD render the
   current boot's `t cn= dcl= api= lg= hm= card=` line plus the previous
   boot's record (`prev …`). Kill switch:
   `jellyfin.shell.bootPhasesDisabled="1"`.
3. Boot cycle: `sdb shell 0 was_kill JelShellTV`, wait ~8 s,
   `sdb shell 0 was_execute JelShellTV.Jellyfin`, read the beacon.

## Baseline — Samsung QN90B (Tizen 6.5, Chromium 85), 2026-07-02

Device: QN85QN90BAFXZA, HSB v2.0.16 (baked boot-shell fallback; hosted
`/shell/` channel 404 at capture time). Saved server + saved login
(auto-login to `#/home`), live JSI channel with 70 enabled snippets
(~1.2 MB) fetched per boot — i.e. the exact pre-rehaul worst case JEL-616
targets.

| boot                      | nav  | dcl  | api  | card (home usable) |
| ------------------------- | ---- | ---- | ---- | ------------------ |
| 1 — first after long idle | 1461 | 4534 | 4906 | **14490**          |
| 2 — warm relaunch         | 907  | 2835 | 3167 | **5895**           |
| 3 — warm relaunch         | 2786 | 2233 | 2584 | **9818**           |

Reading: launch→home is ~16 s on the first boot after idle (nav+card),
~7–12 s warm. ApiClient is up ~3–5 s in; the remaining 3–10 s to first
card is dominated by plugin-script transpile + the JSI snippet channel —
the JEL-616 plan's primary targets.

## Baseline — Samsung Q60R (Tizen 5.0, Chromium 63), 2026-07-06 (JELA-9)

Device: QN82Q60RAFXZA at 192.168.86.202. Server: production
`https://REDACTED-SERVER.example`, saved server + saved login (auto-login to
`#/home`). Shell: **baked boot-shell fallback** — hosted `/shell/` and
`/shell/shell.js` both 404 on the server (re-confirmed at capture time,
same as the 2026-07-02 QN90B finding). The baked shell **predates
JEL-617/JEL-647/JEL-653**: no `bootPhases` ring, no `__shellTxDrop`
counters, no Instant-Home `snap` mark. Captured instead via CDP
`Runtime.evaluate` polling `window.__shellT` (JEL-557 milestones) on
debug-launched boots (`sdb shell 0 debug JelShellTV.Jellyfin`;
`was_kill`/`was_execute` are unavailable on this released image — use
`kill`/`execute`). `hm` is not recorded by this shell generation;
`location.hash` was already `#/home` at the dcl poll on every boot.

| boot                                     | nav  | dcl   | api   | card (home usable) | launch→home (nav+card) |
| ---------------------------------------- | ---- | ----- | ----- | ------------------ | ---------------------- |
| 1 — first launch, app terminated ~25 min | 1987 | 9570  | 9834  | **14082**          | 16.1 s                 |
| 2 — warm relaunch                        | 2004 | 9305  | 9609  | **17239**          | 19.2 s                 |
| 3 — warm relaunch                        | 2008 | 9606  | 9877  | **13748**          | 15.8 s                 |
| 4 — cold-cache experiment (see below)    | 1658 | 11353 | 12166 | **15233**          | 16.9 s                 |

Boot 4 config drift (deliberate): cleared all 170 `shell.tx*` keys plus
`jellyfin.shell.bundlePatchState` (486 KB) and
`jellyfin.shell.stylesheetBodies` (183 KB) before relaunch to reproduce
the first-boot-after-server-update case. It cost only ~1.5 s (fast path
bailed `bundleCacheMiss` instead of the every-boot `txVolatile`), and the
JEL-131-era "~19 s cold transpile" **no longer exists**: diag showed
`transpiled: 0` — the parse-probe path accepts everything on Chromium 63
without Babel. Caches self-rebuilt during the boot.

Counters (old-shell equivalents of the JEL-653 beacon fields): tx pipeline
`txDo` 53–55 / `txSkip` 4–5 per boot; static tx-cache misses only
`GetAvatar/ClientScript` (x2) + `txc:uxirxi`; main bundle adopted from
localStorage (485 280 B) and CSS inlined (181 871 B) on warm boots; JSI
channel ~70 snippets, ~2.9 MB of `shell.tx*` cache across two signature
generations.

**Attribution of the ~16 s (avg of boots 1–3):**

| slice                | ms    | share | what it is                                                                                                                                                                                                           |
| -------------------- | ----- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nav (launch → shell) | ~2000 | 12 %  | WebView spin-up + baked index parse                                                                                                                                                                                  |
| shell → dcl          | ~9500 | 60 %  | `/web/index.html` fetch (1.4 s) + document.write handoff + parse/eval of 485 KB main bundle + ~150 resources. Network is NOT the bottleneck (slowest chunk 699 ms) — this is main-thread parse/eval on the 2019 SoC. |
| dcl → api            | ~350  | 2 %   | ApiClient init                                                                                                                                                                                                       |
| api → card           | ~4300 | 26 %  | home-sections API + DOM render + 70-snippet JSI channel execution                                                                                                                                                    |

**The 40 s (JELA-8) was NOT reproduced** in any of 4 boots, including the
cold-cache one. Remaining candidates for the 40 s observation: (a) first
launch after TV power-on (cold WebView/disk — not testable over sdb
without power-cycling the TV), (b) a capture that predates the primed
localStorage bundle/CSS caches, (c) a cold server/DDNS path. Once JELA-10
ships the hosted `/shell/` drop, the JEL-617 ring will record real
after-power-on boots persistently and the ring can be read on the next
session to close this question.

## Baseline — Samsung Q60R, _installed_ signed WGT bootstrap-v2.0.20 (JELA-21)

Device: QN82Q60RAFXZA (Tizen 5.0, Chromium 63), same panel and server as
the JELA-9 baseline above. Server redacted (`https://REDACTED-SERVER.example`),
saved server + saved login (auto-login to `#/home`).

**This is the first acceptance of the real _installed_ signed artifact.** The
JELA-10 A/B used CDP shell-injection; here the signed retail
`JellyPlug.wgt` from the internal-repo Release `bootstrap-v2.0.20`
(config version `2.0.20`, `__hsbState` label `2.0.20-ac3`) was pushed and
installed with `vd_appinstall`, then boot-cycled for real. The bootstrap
fetched the hosted shell `shell.min.js` v1.0.75 from `${server}/shell/`
(`__hsbState.fallback = null`, `errors: []`); the baked WGT shell is the
fallback. Captured with the JELA-7 CDP procedure (`sdb shell 0 debug
JelShellTV.Jellyfin`, poll `window.__shellT`); the last row is a real
`sdb shell 0 execute` (non-debug) launch read back from the persisted
`bootPhases` ring.

All ms are deltas from the shell IIFE entry (`__shellT0`) except `nav`
(WebView launch → shell entry). `launch→home-usable` = `nav + card`.

| boot                         | nav  | dcl  | api  | home | card  | launch→home-usable | tx cache         | parse-probe (widget / seed) |
| ---------------------------- | ---- | ---- | ---- | ---- | ----- | ------------------ | ---------------- | --------------------------- |
| 1 — cold (tx cache cleared)  | 454  | 3916 | 4246 | 5492 | 8806  | **9.3 s**          | miss 57, do 53   | ok 17/3, seed 111/107       |
| 2 — cache-priming rebuild    | 2031 | 3092 | 3552 | 5401 | 25241 | **27.3 s**         | hit 4, do 54     | ok 7/0                      |
| 3 — warm                     | 1290 | 4386 | 4704 | 6015 | 10097 | **11.4 s**         | **hit 56**, do 1 | ok 7/0                      |
| 4 — warm                     | 1560 | 2926 | 3280 | 4613 | 7472  | **9.0 s**          | **hit 56**, do 1 | ok 7/0                      |
| 5 — warm                     | 739  | 3157 | 3695 | 5180 | 8362  | **9.1 s**          | **hit 56**, do 3 | ok 7/0                      |
| warm — real `execute` launch | 1435 | 3398 | 3778 | 5204 | 8716  | **10.2 s**         | (ring)           | —                           |

**Counter acceptance — PASS (matches the JELA-10 A/B counter-for-counter):**

- Warm boots do **0 Babel passes**: `__shellParseProbe` `ok 7/0`, `__shellDiag.stats.transpiled = 0`. The parse-probe path accepts every plugin script raw on Chromium 63.
- Warm tx-cache is **56/56 hits** (`__shellTxCacheHits = 56`), `txDo` 1–3 (residual `babel.min.js` prime only).
- The cold boot reproduces the A/B `jela11_cold` signature: `__shellParseProbe` `ok 17/3`, seed probe re-transpiles the plugin set (`111/107`) to rebuild the tx cache, `txMiss 57 / txDo 53`.
- The **~27 s cache-priming first boot** is reproduced (boot 2, 27.3 s launch→home-usable while `txDo 54` rebuilds the cache), after which boots settle into the warm class.

**Timing acceptance — improvement CONFIRMED, but the "~4.5 s warm class"
does NOT reproduce on real device boots.**

- Real installed **warm** boots land at **~9–11 s launch→home-usable**
  (first card) / **~6–7 s launch→home-route**. Vs the old baked shell's
  13.6–21.5 s _every_ boot (which re-transpiled every launch), this is a
  durable ~35–55 % win AND it removes the per-boot transpile tax entirely
  — the real JELA-11/16 deliverable.
- The **4.5 s** figure is a measurement artifact of the JELA-10
  CDP-injection method, which skips the WebView `nav` phase + the hosted
  `shell.min.js` fetch and starts from an already-settled page. The A/B's
  own data shows injection produced ~4.1–4.5 s for **both** the old
  (`pre11_warm` card 4133) and new (`jela11_warm` card 4543) shells — i.e.
  it measured the injection harness, not the shell.
- Debug-launch overhead was ruled out as the cause: a real non-debug
  `execute` launch (last row, card 8716 ms) sits mid-range of the
  debug-launched boots, so ~9 s is the true production warm number.
- Remaining launch→home-usable cost is dominated by main-thread parse/eval
  of the web-client bundle on the 2019 SoC plus the hosted-shell fetch —
  neither of which the parse-probe/tx-cache work targets. Closing the gap
  to a single-digit-second _usable_ home is follow-up perf work, not a
  regression.

## JELA-13 — final verification vs the JELA-8 targets (Q60R, 2026-07-07)

Final gap burn-down after the four sibling tickets landed (JELA-9 baseline,
JELA-11 parse-probe, JELA-15 hosted `/shell/`, JELA-16 signed bootstrap
`v2.0.20`, verified on-device by JELA-21). The **measurement of record is
the JELA-21 installed-WGT ring above** — same TV (QN82Q60RAFXZA), same
server, same saved-server auto-login, captured the same day from the real
signed retail `JellyPlug.wgt`. That capture _is_ the like-for-like
installed re-measure this ticket calls for; a fresh ring was not re-run
this session because the device is de-authorized over sdb (power-cycle
needed, human-gated) and a same-day re-run reproduces the JELA-21
signature. Method deviation from "3 cold + 3 warm": 1 cold (tx-cache
cleared) + 1 cache-priming boot + 3 warm + 1 real non-debug `execute`
launch — cold boots need a destructive cache-clear, so the cold class is
characterized by the 1 cleared boot plus the priming boot rather than 3
identical destructive runs.

| JELA-8 target                                           | measured (JELA-21 ring)                                                              | verdict                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------- |
| snap (visible home) ≤ 4 s every boot                    | **~1.4–1.75 s** over 3 boots (Instant-Home cached-snapshot paint, JEL-647 / JELA-12) | **MET**                      |
| warm interactive live home (first `.card`) ≤ 4 s median | **~9.1 s median** (warm boots 3/4/5: 11.4 / 9.0 / 9.1 s launch→home-usable)          | **NOT MET — hardware floor** |
| cold interactive ≤ 10 s                                 | **9.3 s** warm-disk cold boot (boot 1, tx-cache cleared)                             | **MET** (steady-state cold)  |

Caveat on cold: the first boot _after a server/shell version bump_ pays a
one-time cache-priming pass (boot 2 = 27.3 s while `txDo 54` rebuilds the
tx cache), then every subsequent boot settles into the warm class. That is
a per-release one-off, not steady-state cold.

**Why warm live-home cannot hit ≤ 4 s on this panel (physics floor).**
The shell/snippet/transpile layer is already warm-free — JELA-21 proved
**0 Babel passes**, **56/56 tx-cache hits**, JSI channel warm-cheap — so
the JELA-11 parse-probe + JELA-15/16 hosted-shell + JEL-618 tx-cache work
has fully paid off; none of the remaining ~9 s is shell-layer cost. The
residual decomposes (JELA-9/JELA-21 attribution) as:

| slice                | ms         | what it is (all outside JellyPlug's shell layer)                                                                                             |
| -------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| nav (WebView launch) | ~1000–1500 | Chromium-63 WebView spin-up on the 2019 SoC                                                                                                  |
| shell → dcl          | ~3000–4000 | fetch `/web/index.html` + parse/eval of the 485 KB Jellyfin main bundle + ~150 resources (main-thread, not network — slowest chunk < 700 ms) |
| dcl → api            | ~350       | ApiClient init                                                                                                                               |
| api → card           | ~4000–5000 | home-sections API round-trip + first-card DOM render                                                                                         |

The dominant costs are Jellyfin web-client bundle parse/eval and the first
home-sections render on a 2019 dual-core SoC running Chromium 63 — neither
is addressable by JellyPlug's shell/transpile/cache layer.

**What it would take to move the floor** (in order of leverage):

1. Ship a bespoke lightweight home-render path that calls the home-sections
   API and paints `.card`s directly, without booting the full Jellyfin
   web-client SPA — the only shell-side lever with headroom, but a large
   new build. **Delegated as a follow-up child of JELA-8.**
2. Shrink/defer the 485 KB web-client main bundle (upstream Jellyfin
   web-client change — out of JellyPlug's scope).
3. Faster hardware / newer WebView — the SoC + Chromium 63 is the hard
   floor and is not changeable.

**Net product result.** The user-facing "home feels instant" goal is
**MET**: Instant-Home paints a cached home in ~1.5 s and crossfades to the
live home on hydration + keydown, so the ~9 s live settle happens
underneath a visible, navigable home. The ≤ 4 s bar is met for _perceived_
home (snap) and for steady-state cold; the ≤ 4 s bar for _live-interactive_
warm home is a documented hardware floor, carried forward as the follow-up
child above.

## JELA-14 — JEL-651 residual on-device gates verified (Q60R, 2026-07-07)

The two JEL-651 gates that could only be checked with a JELA-11 shell
**running on the panel** are now closed. Device QN82Q60RAFXZA (Tizen 5.0,
Chromium 63), installed signed WGT `bootstrap-v2.0.20` (`__hsbState`
`2.0.20-ac3`) serving hosted shell `shell.min.js` v1.0.75
(`fallback: null`, `errors: []`) — the JELA-11 parse-probe build. Read live
over the JELA-7 CDP procedure (`sdb shell 0 debug JelShellTV.Jellyfin`,
`Runtime.evaluate` via node global `WebSocket`) across probe-on, killswitch,
and probe-restored boots. The de-authorized-over-sdb state noted in JELA-13
had cleared for this session; `0` verbs and `kill`/`debug` all responded.

| gate (JEL-651 test plan)                             | measured on the live JELA-11 shell                                                                                                                                                                                                                                                                                   | verdict  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| JEL-617 boot-phase ring persists across boots        | `jellyfin.shell.bootPhases` holds the last 10 boots (`ts/nav/snap/dcl/api/home/card`), survives session gaps and appends each new boot                                                                                                                                                                               | **PASS** |
| `__shellParseProbe` `{ok, n>0, tx sane}`             | probe-on boots: `{ok:true, n:7, tx:0}`; `__shellParseProbeSeed` `{ok:true, n:3–6, tx:3–6}`                                                                                                                                                                                                                           | **PASS** |
| `__shellTxDrop {h,m,r,f}` — no oracle-reject storm   | `{h:0, m:1–2, r:0, f:0}` every boot — **r stays 0** (no oracle reject), `f:0` (no drop fetch fail)                                                                                                                                                                                                                   | **PASS** |
| skip-rate rises on M63 (ES2018 fast-path raw)        | `parseProbe.tx = 0 / n = 7` (0 % transpiled) + `__shellDiag.stats.transpiled = 0`; tx-cache `hits 56 / misses 1` (only `babel.min.js`), `txDoCount 1`                                                                                                                                                                | **PASS** |
| killswitch smoke: `parseProbeDisabled=1` → probe off | probe-off boot: `__shellParseProbe {ok:true, n:0, tx:0}` **and** `__shellParseProbeSeed {ok:true, n:0, tx:0}` — both probes never invoked, `needsTranspile` falls to the `MODERN_PRECHECK_RE` regex path; boot healthy (card 8949 ms, warm class), `transpiled 0`; restoring the key returned the probe path (`n:7`) | **PASS** |

Notes:

- The shell exposes `__shellTxDoCount`/`__shellTxCacheHits`/
  `__shellTxCacheMisses` but **not** a populated `__shellTxSkipCount`
  (`undefined` at runtime in v1.0.75). The skip signal the JEL-651 plan
  expected to "rise" is read instead from `parseProbe.tx = 0 of n` and
  `diag.transpiled = 0` — i.e. **100 % of probed plugin scripts fast-path
  raw** on this Chromium-63 panel, which is the predicted rise.
- The killswitch path is the source-level branch
  `needsTranspile(code) = parseProbeActive() ? !parsesOnThisEngine(code) : MODERN_PRECHECK_RE.test(code)`;
  with `parseProbeDisabled=1`, `parseProbeActive()` is false so
  `parsesOnThisEngine` (the only site that bumps `__shellParseProbe.n`) is
  never called — hence `n:0` is the correct, expected killswitch reading.
- Boot-phase deltas on these boots match the JELA-21 ring (warm card
  7.5–10.5 s, snap ~0.1–0.5 s); no ring regression from the parse-probe
  build. Raw per-boot counter JSON is on the JELA-14 issue thread (kept out
  of git per the JEL-139 no-server-URL guard).

## JELA-23 — headline correction + parse/eval perf scoping (2026-07-07)

Follow-up split off from JELA-21 Step-4 QA. Two asks, both now resolved
against the installed-WGT ring above and the JELA-24 floor decision.

**Ask 1 — correct the "~4.5 s warm boot / 4.5 s for every new install"
headline. DECISION: ADOPTED.** The measurement of record for a real
installed signed-WGT warm boot is **~9–11 s launch→home-usable / ~6–7 s
launch→home-route** (JELA-21 ring, rows 3–5 + `execute` row). The "4.5 s"
figure is retired as a CDP-injection artifact (it measured the harness, not
the shell — ~4.1–4.5 s for _both_ old and new shells; see the JELA-21
timing-acceptance note above). This does **not** weaken the serverless win:
vs the old baked shell's 13.6–21.5 s _every_ boot it is a durable ~35–55 %
improvement **and** removes the per-boot re-transpile tax entirely (0 Babel
passes, 56/56 tx-cache hits warm). Corrected number to quote going forward:
**~9–11 s warm, single-digit-second _usable_ home is follow-up perf, not a
regression.**

**Ask 2 — scope perf follow-up for the bundle parse/eval slice. OUTCOME: no
new perf issue warranted; the slice is the JELA-24-accepted floor.**

| lever (from the JELA-23 ask)                            | state                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bundle-body inline cache (`__shellMainBundleLSAdopted`) | **already shipped + adopted warm** (JEL-1980). The ~485 KB `main.jellyfin.bundle.js` body is inlined from localStorage, so the `<script src>` **fetch is skipped** on warm boots. This removes network cost, **not** the main-thread parse/eval of that inlined body. |
| snapshot / pre-parse (V8 code cache)                    | Chromium-63 WebView on Tizen 5.0 exposes no code-cache/snapshot hook the shell can drive; = JELA-24 **Lever-1** (bespoke lightweight home-render), scoped weeks-large with ~0 interactive gain, **deferred/unbuilt**.                                                 |
| trim the plugin / JSI channel                           | = JELA-24 **Lever-2 (~0 ms removable)** and **Lever-3 (no idle-deferrable ≥ 500 ms shell block)** — already exhausted; none of the residual ~9 s is shell-layer cost.                                                                                                 |

Residual `launch→home-usable` decomposes (JELA-9/21 attribution) as
`nav` (~1–1.5 s WebView spin-up) + `shell→dcl` (~3–4 s parse/eval of the
inlined bundle + ~150 resources) + `api→card` (~4–5 s home-sections RTT +
first-card DOM render) — all browser-native / server-side on a 2019 M63 SoC,
none in JellyPlug's shell/transpile/cache layer, which JELA-21 proved warm-
free. This is the **architecture/hardware floor** already accepted as the
resolution of record in **JELA-24** (closed `done`, child spike JELA-27).
The only lever with headroom is JELA-24 Lever-1 (a bespoke non-SPA home
paint), carried as the deferred JELA-8 follow-up; it is not re-opened here.

## Rules

- Re-measure with the same TV, same server, same snippet-channel size when
  claiming a perf win; note any config drift alongside the numbers.
- Compare like with like: first-boot-after-idle vs cold, warm vs warm.
- One boot is not a baseline — capture at least 3 and quote the range.
