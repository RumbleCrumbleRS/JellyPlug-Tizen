# JEL-82 — Compare: Tizen system info — device model and firmware version reported

**Verdict: the issue's premise is falsified by the shipped code. The shell does
NOT read the device model or firmware version. `getSystemInfo()` queries
`DISPLAY` only (screen resolution) and never `getPropertyValue('BUILD')`;
`deviceName()` returns a fixed `"Samsung Smart TV"` constant for every TV — there
is no model derivation and no `'Tizen TV'` fallback; and the QA diagnostics
expose no model/firmware field because nothing collects it. The server's Devices
dashboard therefore shows the static `"Samsung Smart TV"` for every Samsung TV
running this shell. This is by design (the JEL-89 identity decision), not a bug.
56/56 checks pass.**

```
node tooling/tv-validate/system-info/verify-system-info.mjs   # 56/56 PASS
```

## The three claims in the issue, each tested against the real code

| Issue claim                                                           | Reality                                                                                                                                                                                                    | Where proven |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `getSystemInfo()` reads device info via `getPropertyValue('BUILD')`   | **False.** It calls `getPropertyValue('DISPLAY', …)` and extracts only `resolutionWidth`/`resolutionHeight` (× a UD/8K panel ratio). `BUILD` is never requested.                                           | Part A       |
| `deviceName()` returns the model string (not a `'Tizen TV'` fallback) | **False.** `deviceName()` returns the constant `AppInfo.deviceName === "Samsung Smart TV"` on every path. There is no model lookup, and no `"Tizen TV"` string exists anywhere.                            | Part B       |
| The model is logged/exposed in QA diagnostics                         | **False.** `__shellDiag`/`__shellDiagInit` carry `errors`/`warns`/`stats` (a UA slice + transpile counters + player-manager roster). No model/firmware/BUILD field — nothing reads it, so nothing logs it. | Part C       |

## What `getSystemInfo()` actually does

```js
function getSystemInfo() {
  if (systeminfo) return Promise.resolve(systeminfo);
  if (!hasTizen || !tizen.systeminfo) {
    systeminfo = { resolutionWidth: 1920, resolutionHeight: 1080 };
    return Promise.resolve(systeminfo);
  }
  return new Promise(function (resolve) {
    tizen.systeminfo.getPropertyValue(
      "DISPLAY",                       // <-- resolution, NOT "BUILD"
      function (result) {
        var ratio = 1;                 // UD → ×2, 8K → ×4 (webapis.productinfo)
        ...
        systeminfo = {
          resolutionWidth: Math.floor(result.resolutionWidth * ratio),
          resolutionHeight: Math.floor(result.resolutionHeight * ratio),
        };
        resolve(systeminfo);
      },
      function () {                    // DISPLAY error → 1080p fallback
        systeminfo = { resolutionWidth: 1920, resolutionHeight: 1080 };
        resolve(systeminfo);
      },
    );
  });
}
```

Its sole job is to size the screen for `AppHost.screen()`. The panel-ratio probes
(`webapis.productinfo.isUdPanelSupported` / `is8KPanelSupported`) are boolean
capability checks — they do not expose the model either. No code path in either
shell ever calls `getPropertyValue('BUILD')`, `'MODEL_NAME'`, or any firmware
property.

## What the server's Devices dashboard sees

jellyfin-web builds the `Device` field of its `X-Emby-Authorization` header (which
becomes the **Name** column in **Dashboard → Devices**) from
`NativeShell.AppHost.deviceName()`. That getter returns the hard-coded constant:

```js
var AppInfo = {
  deviceId: getDeviceId(),
  deviceName: "Samsung Smart TV",     // fixed; same on every model + firmware
  appName: "Jellyfin Shell for Tizen",
};
...
deviceName: function () { return AppInfo.deviceName; },
```

So the dashboard shows **`Samsung Smart TV`** for every TV — a 65" QN90, a 43"
AU8000, and an emulator all report the identical name. Devices are still told
apart by `deviceId` (a per-install persisted token; see
`device-id-stability/results-JEL-67.md`), and the **AppName**/version columns come
from jellyfin-web's own `__PACKAGE_JSON_VERSION__` (JEL-12), not from the widget.

This is the same identity contract the CEO locked in **JEL-89** and that the
JEL-45 contract test (`packages/shell-tizen/scripts/nativeshell-apphost.test.cjs`)
guards at the source level. JEL-82 adds the **runtime** proof that no model or
firmware string ever enters the pipeline in the first place.

### Live-server compare — attempted, egress-blocked this run

I tried to confirm the dashboard value directly against the test server
(`$JELLYFIN_URL` → `/Devices`), but the sandbox had no network egress to it this
run (`curl` exit 7 / HTTP 000 on `/System/Info/Public`). The value is fully
determined by the apphost contract above regardless; when egress is available,
`GET /Devices` with an admin token will list the shell's session under
`Name: "Samsung Smart TV"`. The probe is a one-liner re-run, not a blocker for the
verification conclusion.

## How it's proven hermetically (no TV, no server, no network)

`getSystemInfo()` is extracted **verbatim** from both shells and executed in a
Node `vm` realm wired to a `tizen.systeminfo` double that **records every
property key requested**. The double's `BUILD` branch is primed to hand back a
real model (`QN65Q80AAFXZA` / `T-KTM2LAKUC-1320.5`) — proving the model never
flows anywhere because the code never asks for it. Four scenarios × two shells ×
two UAs (legacy-TV Chromium 63 and modern Chromium):

1. **Happy path** — asks `DISPLAY` exactly once, never `BUILD`; result has only
   `resolutionWidth`/`resolutionHeight`; the primed model never appears.
2. **UD panel** — resolution upscales to 3840×2160, still `BUILD`-free.
3. **DISPLAY error** — falls back to 1920×1080, never probes `BUILD`.
4. **No-tizen host** (browser/emulator) — returns 1920×1080 without calling
   `getPropertyValue` at all.

`deviceName()`'s constant, the absence of a `"Tizen TV"` fallback, and the
QA-diag schema (no model/firmware field) are pinned by source-contract guards
across both shells **and** the deployed minified blobs
(`shell.min.js`, `boot-shell.min.js`).

## If the product DOES want the real model on the dashboard (follow-up, not this ticket)

The shell would need to (a) `getPropertyValue('BUILD')` for the firmware string
and a model source (e.g. `webapis.productinfo.getModel()` / `getModelCode()`),
(b) fold it into `AppInfo.deviceName` (or a new field), and (c) optionally surface
it in `__shellDiag` for QA. That changes the device identity reported to the
server and reopens the JEL-89 decision, so it belongs on a **separate ticket with
CEO sign-off**, not silently inside this compare. Flagged in the JEL-82 thread.
