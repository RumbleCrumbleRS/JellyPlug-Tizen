# JEL-45 — NativeShell.AppHost API values: TV vs browser

**Question:** do all `NativeShell.AppHost` properties return correct values, and
are they consistent on the Tizen TV vs a desktop browser?

JEL-45 names five properties:

1. `appName()` should return `"Jellyfin for Tizen"`
2. `deviceId()` should return a stable id persisted in `localStorage`
3. `deviceName()` should return the TV model from `tizen.systeminfo`, else `"Tizen TV"`
4. `getDefaultLayout()` should return `"tv"`
5. `appVersion` should be intentionally **absent** (jellyfin-web falls back to its
   bundled web-client version — see [JEL-12](/JEL/issues/JEL-12))

**Verdict: TV-vs-browser parity is exact; three of five properties match the
spec; two diverge and need a product decision (not a silent code change).**

## TV vs browser: identical by construction

The shell defines `window.NativeShell.AppHost` the same way on every platform.
`appName`, `deviceName`, and `getDefaultLayout` are constants, and `deviceId` is
a `localStorage` value — **none branch on `tizen`**. So the four return
**identical values on the TV and in a desktop browser** running the same shell.
The only AppHost member that legitimately differs by platform is `screen()`:

| Property            | TV (Tizen)                                  | Browser (no `tizen`)        | Differs? |
| ------------------- | ------------------------------------------- | --------------------------- | -------- |
| `appName()`         | `AppInfo.appName` (constant)                | same                        | no       |
| `deviceId()`        | `localStorage["_deviceId2"]`                | same mechanism              | no\*     |
| `deviceName()`      | `AppInfo.deviceName` (constant)             | same                        | no       |
| `getDefaultLayout()`| `"tv"`                                       | `"tv"`                      | no       |
| `appVersion`        | absent                                       | absent                      | no       |
| `screen()`          | real panel res via `tizen.systeminfo DISPLAY`| `1920x1080` fallback        | **yes**  |

\* `deviceId` is per-install (the value is generated once and stored), so two
different devices get different ids — but a single device returns the same id on
TV and in a browser session sharing that `localStorage`.

## Two shells, one contract

The retail artifact that boots on the TV is the **bootstrap**
(`boot-shell.src.js` / `.min.js`); the full shell (`shell.js` / `.min.js`)
carries its own copy of the same NativeShell. The test confirms the two
source-of-record files **agree** on every identity value and that each deployed
minified blob mirrors its source. (Today both carry the same values.)

## Property-by-property

| # | Property            | Spec (JEL-45)                                   | Shipped code                                                        | Status        |
| - | ------------------- | ----------------------------------------------- | ------------------------------------------------------------------- | ------------- |
| 1 | `appName()`         | `"Jellyfin for Tizen"`                          | `"Jellyfin Shell for Tizen"`                                        | **DIVERGES**  |
| 2 | `deviceId()`        | stable id persisted in `localStorage`           | stable `btoa(userAgent\|Date.now()\|Math.random())` in `_deviceId2` | matches intent\*\* |
| 3 | `deviceName()`      | TV model from `tizen.systeminfo`, else `"Tizen TV"` | hardcoded `"Samsung Smart TV"`; never reads a model                 | **DIVERGES**  |
| 4 | `getDefaultLayout()`| `"tv"`                                          | `"tv"`                                                              | matches       |
| 5 | `appVersion`        | absent                                          | absent (explicit comment in `shell.js`)                            | matches       |

\*\* The shipped `deviceId` is stable and persisted (the spec's intent), but it
is a base64 token, **not** RFC-4122 UUID format. If the spec strictly requires
UUID formatting that is a small, low-risk change; functionally the current value
already satisfies "stable id persisted in localStorage".

## The two divergences (product/identity decision required)

Both touch **server-reported identity** on a **deployed retail build**, so they
are deliberately escalated rather than silently "fixed":

### 1. `appName()` — `"Jellyfin Shell for Tizen"` vs spec `"Jellyfin for Tizen"`

This string is the client name the server records in **Dashboard → Devices /
Active Sessions**. Changing it alters how every TV identifies itself to the
server going forward. It is a one-line string change in two source files
(`shell.js`, `boot-shell.src.js`) plus a rebuild of both `.min` blobs. Low
technical risk; it is a **branding decision**, which is why it is not changed
unilaterally.

### 2. `deviceName()` — hardcoded `"Samsung Smart TV"` vs spec model-from-systeminfo

The spec wants the actual TV model (so multiple TVs are distinguishable in the
Jellyfin dashboard) with a `"Tizen TV"` fallback. The shipped code returns the
same constant for **every** device. Implementing the spec means:

- read the model synchronously at `AppInfo` init (e.g.
  `tizen.systeminfo.getCapability("http://tizen.org/system/model_name")`, or the
  `model` field from the `BUILD` property), wrapped in `try/catch` with a
  `"Tizen TV"` fallback for browsers / failures;
- apply it in both `shell.js` and `boot-shell.src.js` and rebuild both `.min`.

**Migration note:** existing installs would re-appear in the dashboard under a
new device name after the update (the server keys sessions by device name +
id). That user-visible churn is the reason this is a product call.

**Recommendation:** adopt the spec values (they match upstream jellyfin-tizen
and are strictly more informative), in a single small follow-up that edits both
shells and rebuilds the minified blobs, OR — if "Jellyfin Shell for Tizen" /
"Samsung Smart TV" are intentional JellyPlug choices — amend the JEL-45 spec and
the test will lock the current values as the contract. Either way the decision
is the CEO's; the verification harness is ready to pin whichever is chosen.

## Evidence

### Deterministic contract test (no network, runs in CI)

`packages/shell-tizen/scripts/nativeshell-apphost.test.cjs`, wired into
`pnpm --filter @jellyfin-tv/shell-tizen test`.

- **Part A (contract — fails the build on regression):** `getDefaultLayout()`
  is `"tv"`; `appVersion` is absent from AppHost in all four files; `deviceId`
  reads/persists `localStorage["_deviceId2"]` and returns the cached value
  (stable); the deployed blobs carry the key; `getSystemInfo()` reads
  `tizen.systeminfo DISPLAY` on TV and falls back to `1920x1080` in a browser;
  the two shells agree on identity values and the `.min` blobs mirror their
  source; `appName()`/`deviceName()` are platform-independent constants.
- **Part B (spec comparison — informational, never fails CI):** prints
  `MATCH`/`DIVERGENCE` for each of the five spec items, surfacing the two
  divergences above while keeping the contract guard green.

Result: **all Part A contract checks pass; 2 Part B divergences reported.**

```
$ node packages/shell-tizen/scripts/nativeshell-apphost.test.cjs
...
DIVERGENCE: appName()  — spec="Jellyfin for Tizen" actual="Jellyfin Shell for Tizen"
DIVERGENCE: deviceName()  — spec=model-from-tizen.systeminfo (fallback "Tizen TV") actual=hardcoded "Samsung Smart TV"; ...
All NativeShell.AppHost contract checks passed.
```

### Source references

- `packages/shell-tizen/src/shell.js` — `getDeviceId()`, `getSystemInfo()`,
  `AppInfo`, `window.NativeShell.AppHost` (the unminified source of record).
- `packages/shell-tizen-bootstrap/src/boot-shell.src.js` — identical NativeShell
  in the deployed retail bootstrap.
- `appVersion` omission rationale: see the contract comment block in `shell.js`
  above `generateDeviceId()` and [JEL-12](/JEL/issues/JEL-12).
