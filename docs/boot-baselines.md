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

## Baseline — Samsung Q60R (Tizen 5.0, Chromium 63)

**PENDING — TV was powered off / unreachable on 2026-07-02.** The probe
snippet stays enabled in the JS-Injector config, so the next time the TV
is powered on and JellyPlug is launched the beacon posts its boot line
automatically; append the numbers here (3 boots: 1 cold + 2 warm) and only
then remove the probe snippet. Expected shape from JEL-131 history:
~19 s cold / ~3 s primed for the transpile slice alone.

## Rules

- Re-measure with the same TV, same server, same snippet-channel size when
  claiming a perf win; note any config drift alongside the numbers.
- Compare like with like: first-boot-after-idle vs cold, warm vs warm.
- One boot is not a baseline — capture at least 3 and quote the range.
