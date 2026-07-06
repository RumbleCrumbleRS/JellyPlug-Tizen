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
`https://puntneyflix.ddns.net`, saved server + saved login (auto-login to
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

| slice                | ms     | share | what it is                                                                                         |
| -------------------- | ------ | ----- | -------------------------------------------------------------------------------------------------- |
| nav (launch → shell) | ~2000  | 12 %  | WebView spin-up + baked index parse                                                                 |
| shell → dcl          | ~9500  | 60 %  | `/web/index.html` fetch (1.4 s) + document.write handoff + parse/eval of 485 KB main bundle + ~150 resources. Network is NOT the bottleneck (slowest chunk 699 ms) — this is main-thread parse/eval on the 2019 SoC. |
| dcl → api            | ~350   | 2 %   | ApiClient init                                                                                      |
| api → card           | ~4300  | 26 %  | home-sections API + DOM render + 70-snippet JSI channel execution                                   |

**The 40 s (JELA-8) was NOT reproduced** in any of 4 boots, including the
cold-cache one. Remaining candidates for the 40 s observation: (a) first
launch after TV power-on (cold WebView/disk — not testable over sdb
without power-cycling the TV), (b) a capture that predates the primed
localStorage bundle/CSS caches, (c) a cold server/DDNS path. Once JELA-10
ships the hosted `/shell/` drop, the JEL-617 ring will record real
after-power-on boots persistently and the ring can be read on the next
session to close this question.

## Rules

- Re-measure with the same TV, same server, same snippet-channel size when
  claiming a perf win; note any config drift alongside the numbers.
- Compare like with like: first-boot-after-idle vs cold, warm vs warm.
- One boot is not a baseline — capture at least 3 and quote the range.
