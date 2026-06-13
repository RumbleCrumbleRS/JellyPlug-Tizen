# JEL-88 — On-device plugin runtime registration + UI confirmation (physical M63)

Follow-up to **JEL-37** (pipeline parity PASS, 6 plugins, both paths). This is the *runtime* confirmation
on the physical locked **Samsung QN82Q60RAFXZA** (2019 Q60R, Tizen 5.0 / Chromium 56 "M63") that the
transpiled/inlined plugin bodies actually **execute and register their UI at runtime** — i.e. the
JEL-17 failure class (transpile worked but a plugin threw at runtime) does **not** recur.

- **Date:** 2026-06-09
- **Device:** QN82Q60RAFXZA @ 192.168.0.10 (retail, locked; no inspector / no sdb dlog)
- **Build driven:** debug telemetry bootstrap `debug/jel7-m63-telemetry` @ `1f6f9ce` (signed retail cert,
  `vd_appinstall` clean over the shipped v2.0.2; reverted to release after capture)
- **Server:** https://REDACTED-SERVER.example — Jellyfin 10.11.10, Test user
- **Capture channel:** `__shellDiagInit` / `__shellDiag` read out via the user's Jellyfin
  **DisplayPreferences** (`/DisplayPreferences/jel17verify`) — the reliable, non-rate-limited channel —
  plus an in-app **html2canvas** self-screenshot relayed to ntfy (JEL-7 method; no manual photo).

## Method (autonomous, from the sandbox)

1. `sdb connect 192.168.0.10` → device online; stop running app (REST `DELETE`) to avoid the
   reinstall webview wedge; `sdb push` + `shell 0 vd_appinstall JelShellTV <clean-path>`.
2. Set a DisplayPreferences **sentinel** tag so a fresh on-device post is unambiguous.
3. Launch (REST `POST`); the baked debug harness samples `reportToServer` at t+0/30/60/90/120/160/200/240s
   and captures the home via html2canvas at t+230s.
4. Poll DisplayPreferences from the sandbox with the Test token; relaunch once for a warm boot.

## Result — RUNTIME REGISTRATION CONFIRMED ✅

Fresh live capture, **both a cold boot and a warm boot**, sentinel→hello→t30…t200 observed
(proves these are this-run posts, not stale):

| Signal | Value | Meaning |
| --- | --- | --- |
| `tx` (`__shellFastPathTxInlines`) | **6** | All 6 server plugins transpiled/inlined & executed on Chromium 56 — matches JEL-37 `scriptsFound:6` |
| `je` (`typeof JellyfinEnhanced`) | **object** | JellyfinEnhanced registered its runtime global |
| `iterErr` | **0** | No "iterate non-iterable" throw (the JEL-17 / JEL-20 / JEL-21 failure class) |
| `errMsg` (from `__shellDiag.errors`) | **empty** | No plugin runtime error captured across the full t0→t200 window |

The 6 plugins (per JEL-37): NotifySync/client.js, EditorsChoice/script, JavaScriptInjector/public.js,
HomeScreen/home-screen-sections.js, JellyfinEnhanced/script, PluginPages/inject.js — 4 Babel→chrome63,
2 inlined raw. All execute at runtime with **zero throws**. The JEL-17 failure class is cleared.

## Plugin UI render — self-captured screen

The html2canvas self-shot of the M63 home (TV layout, logged-in) shows plugin UI **rendered** in the
top nav:

- **NotifySync notification bell** present in the nav bar (plugin UI registered).
- **"Requests" nav tab + group icon** injected (JellyfinEnhanced / plugin nav).
- Authenticated home reached (user menu + clock).

Body artwork appears dark in the self-shot — a known html2canvas limitation (it cannot rasterize
cross-origin CSS background-image artwork), **not** a render failure.

### EditorsChoice desktop hero — layout-gated (not a runtime break)

On the default **TV layout**, the EditorsChoice spotlight/hero did **not** inject
(`ecAdded=0`, `hsc=0`, `spotlightEls=0`, `splide=undefined`). This is **by design, not a runtime fault**:
the hero bails on `if(!$(".homeSectionsContainer").length)` and `.homeSectionsContainer` is a
**desktop-layout** structure. JEL-17 reproduced and **pixel-verified** the hero on this same device only
after force-setting desktop layout via the runtime config channel; on a TV-layout client (TV or browser
alike) the desktop hero is not expected. EditorsChoice still **transpiled, executed, and registered**
here (counted in `tx=6`, `iterErr=0`) — it simply takes the no-op branch under TV layout.

## Verdict

- **Plugin runtime registration on M63: CONFIRMED** — 6/6 plugins execute, JellyfinEnhanced registers,
  **zero** runtime throws. The JEL-17 transpile-OK-but-threw class does not recur.
- **Plugin UI render: CONFIRMED** for the TV-relevant chrome (NotifySync bell, plugin nav). The
  EditorsChoice desktop hero is layout-gated (desktop-only) and was pixel-verified separately under JEL-17.
