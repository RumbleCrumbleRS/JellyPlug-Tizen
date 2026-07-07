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

## Rules

- Re-measure with the same TV, same server, same snippet-channel size when
  claiming a perf win; note any config drift alongside the numbers.
- Compare like with like: first-boot-after-idle vs cold, warm vs warm.
- One boot is not a baseline — capture at least 3 and quote the range.
