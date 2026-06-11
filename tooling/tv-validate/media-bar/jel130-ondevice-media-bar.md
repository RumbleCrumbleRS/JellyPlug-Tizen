# JEL-130 — v2.0.10 on-device confirm: media bar (EditorsChoice) renders on M63

2026-06-11, physical M63 (QN82Q60RAFXZA, Tizen 5.0 / Chromium M63 silicon).
Verifies the JEL-129 late `window.onload` rescue (main `562889c`) shipped in
bootstrap v2.0.10 (tag `bootstrap-v2.0.10`, signed retail wgt sha256
`9cd83a11…a201`, manifest commit `b936371`).

## Why this capture exists

The EditorsChoice "media bar" (home spotlight) arms everything inside
`window.onload = fn`. In the shell's rewritten document on Chromium 56 the
load event fires before the jQuery-gated plugin body runs, so the handler was
silently dead — no MutationObserver, no Splide, no hero (JEL-88 telemetry:
`tx` executed, `ecAdded=0`). The JEL-129 shim takes over `window.onload`
dispatch on legacy Chromium and invokes late-registered load handlers once,
async. Counters: `__shellLateOnloadAssigns` / `__shellLateOnloadRuns`.

## Method

- QA capture build = `qa/jel130-capture` @ `02c359a` (sign run 27378671521),
  base `main@b936371` (retail v2.0.10): baked qa-beacon armed via index.html
  seed, probe extended with `p.loA/p.loR` (late-onload counters), `p.hsc`
  (`.homeSectionsContainer` count), `p.ec` (`.editorsChoiceItemBanner`
  slides), `p.splide` (`typeof Splide`), `p.ecRect/ecVis/ecBg/ecLogo`
  (hero DOM self-capture, JEL-7 method). Beacons over
  `ntfy.envs.net/jel130-cap-c4362d3432e4` (raw: `jel130-ntfy-raw.jsonl`).
- Single QA boot, installed over the user's live retail state
  (stop-before-install; app was not running). The JEL-127 v2 credential
  rescue was baked but **stayed a no-op** — the TV was already signed in
  (`qcState=loggedIn` from the first tick), so the user's own credentials and
  storage were never touched.
- New for this capture: a cfg-topic **farewell command** baked into the
  beacon (poll `jellyfin.qa.cfgUrl` every 10 s; on `{"cmd":"farewell"}` clear
  `jellyfin.qa.*` + any harness-seeded creds, post a confirmation beacon,
  exit the app). This removed the need for a separate farewell build + extra
  TV boot (JEL-114/127 restore pattern compressed to zero extra cycles).

## Results (25 beacons, t0 = first tick at #/home)

Every tick from t+0 through t+96 s, steady:

| field      | value                             | meaning                                |
| ---------- | --------------------------------- | -------------------------------------- |
| `url`      | `…/index.html#/home`              | home route reached                     |
| `qcState`  | `loggedIn`                        | user's own session, no reseed          |
| `cards`    | 359 → 391 (stable)                | home rows fully data-bound             |
| `p.loA`    | **1**                             | plugin's late `window.onload` caught   |
| `p.loR`    | **1** (from t+4 s)                | rescued handler ran exactly once       |
| `p.hsc`    | **1**                             | `.homeSectionsContainer` exists on TV  |
| `p.ec`     | **9**                             | nine EditorsChoice slides injected     |
| `p.splide` | **`function`**                    | Splide library loaded + executed       |
| `p.ecVis`  | **1**                             | hero visible (non-zero box, displayed) |
| `p.ecRect` | `{x:0, y:123, w:1910, h:540}`     | full-width hero band on screen         |
| `p.ecLogo` | `…/Items/2e29ff53…/Images/Logo/0` | slide logo resolves from the server    |
| `errors`   | none, all 25 ticks                | zero JS errors                         |

`p.loA=1` on the very first tick with `p.loR=0`, flipping to `loR=1` by the
next tick — the assignment landed after the real load event and the shim ran
it asynchronously exactly once. `p.ecBg` read `null` because the
background-image sits on the slide div probed only for the first banner's
computed style at a moment Splide had cloned/transformed slides; the rect +
visibility + logo URL + 9 slides are the load-bearing visibility evidence.

**Verdict: PASS.** The media bar renders on the TV home on v2.0.10 —
`ecAdded ≥ 1` (9 slides), `typeof Splide === 'function'`, late-onload
counters fired, hero visibly laid out at 1910×540. JEL-129's root-cause fix
is confirmed on-device.

## Restore / end state

- Farewell confirm beacon: removed `jellyfin.qa.beaconSerial`, `.beaconUrl`,
  `.cfgUrl`, `.overlay` (no `credsSeeded` — user creds untouched); app
  self-exited.
- Retail `JellyPlugBootstrap_v2.0.10.wgt` (the exact bootstrap-v2.0.10
  release asset, sha256 `9cd83a1139600113fb02008d55a0567ef324a3999fffbdaba59f403bcf4a9201`)
  installed over it (`cmd_ret:0`), one clean verification launch (running,
  visible, **zero** beacons since farewell → QA flags really gone), then
  stopped — TV left as found (app not running, user still signed in, no
  re-login required).
- Samsung REST `version` field still reads `2.0.9` — the JEL-114 stale
  vd_applist cache (it never refreshed this session). Byte-identity of the
  pushed release asset + the QA boot exercising the same v2.0.10 base is the
  install verification, per the JEL-25 precedent.
- Test-account device entry `JEL130-QA` (deviceId `jel130-qa`) exists
  server-side only (was never stored on the TV); Test can't self-revoke
  (403, admin-gated) — revoke via Jellyfin dashboard → Devices alongside
  `JEL127-QA` if desired.
- `qa/jel130-capture` branch deleted after capture; origin is main-only.
