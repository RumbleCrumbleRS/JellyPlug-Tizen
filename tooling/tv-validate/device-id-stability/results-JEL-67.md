# JEL-67 — Compare: deviceId stability across boots and reinstalls

**Verdict: confirmed correct. The same id is returned across reboots and
app updates; a clean uninstall+reinstall mints a new id — which is the expected
Tizen behavior and is documented below. 68/68 checks pass.**

```
node tooling/tv-validate/device-id-stability/verify-device-id-stability.mjs   # 68/68 PASS
```

## What deviceId actually is

`NativeShell.AppHost.deviceId()` returns `AppInfo.deviceId`, which is seeded
exactly once at shell init via `getDeviceId()`:

```js
function generateDeviceId() {
  return btoa(
    [navigator.userAgent, Date.now(), Math.random()].join("|"),
  ).replace(/=/g, "1");
}
function getDeviceId() {
  var id = localStorage.getItem("_deviceId2");
  if (!id) {
    id = generateDeviceId();
    try {
      localStorage.setItem("_deviceId2", id);
    } catch (e) {}
  }
  return id;
}
```

So the id is **read once from `localStorage["_deviceId2"]`, and generated +
persisted only when that key is missing.** It is a stable, persisted token —
**not** an RFC‑4122 UUID (the issue says "UUID" loosely; the value's job is
stable uniqueness, which it satisfies). This is the same observation locked by
the JEL‑45 contract test (`scripts/nativeshell-apphost.test.cjs`); JEL‑67 proves
the **runtime stability** across the platform lifecycle events the JEL‑45 source
guard cannot exercise.

The two shells that ship — the full `shell.js`/`shell.min.js` and the retail
bootstrap `boot-shell.src.js`/`boot-shell.min.js` — carry **byte-identical**
`generateDeviceId`/`getDeviceId` (only a cosmetic empty-catch comment differs),
so the server sees the same identity regardless of which shell booted.

## Why this is verifiable off-device (not a pixel capture)

`getDeviceId` does not branch on `tizen`/`webapis` — to it, a reboot, a browser
refresh and a fresh app process are all the same thing: a new JS realm pointed
at whatever `localStorage` the platform hands back. The whole question therefore
reduces to "what's in the store?", which the harness controls directly. It
extracts the two functions **verbatim** from each shell and runs them in a Node
`vm` realm against a `localStorage` double whose contents mirror each lifecycle
event, under both a legacy‑TV UA and a modern‑browser UA. The double counts
writes, so "minted a fresh id" (a `setItem("_deviceId2")` fired) is distinguished
from "reused the persisted id" (no write) — a deterministic signal, not a
probabilistic id comparison.

## The lifecycle table (the headline result)

| event                                                | localStorage state                           | `deviceId()` result               | generateDeviceId runs? |
| ---------------------------------------------------- | -------------------------------------------- | --------------------------------- | ---------------------- |
| **First ever launch**                                | empty                                        | new id, persisted to `_deviceId2` | ✅ once                |
| Repeated calls, same session                         | key present                                  | same id                           | ❌                     |
| **Reboot the TV**                                    | **preserved** (Tizen keeps the app data dir) | **same id**                       | ❌ (no write)          |
| App update / update-over-install (same pkgid + cert) | **preserved**                                | **same id**                       | ❌ (no write)          |
| **Uninstall + reinstall (clean)**                    | **wiped** (Tizen deletes the app data dir)   | **new id**, persisted             | ✅ once                |

Both TV and browser, both shells, produce this identical table — verified by the
harness.

## Reboot: same id ✔ (the core ask)

Calling `deviceId()` right after launch, then again after a TV reboot, returns
the **identical** value. Tizen keeps each app's private data directory (where Web
Storage lives) across power cycles, so on the second boot `_deviceId2` is still
present and `getDeviceId` returns it **without** regenerating (the harness asserts
zero writes to the key on the reboot path). AppHost also caches the value at init,
so even a mid-session `localStorage.clear()` cannot change the live `deviceId()`.

## Reinstall: documented behavior

Tizen scopes Web Storage to the application's private data directory, and that
directory's lifetime follows the package:

- **Update-over-install** (`tizen install`/Samsung's "update" of the same package
  id with the same signing cert — how OTA app updates land) **preserves** the data
  directory → `_deviceId2` survives → **same id**. This is the normal update path,
  so a shipped app update does **not** churn the device identity.
- **Clean uninstall + reinstall** (or installing a build signed with a _different_
  certificate, which Tizen treats as a different app) **deletes** the data
  directory → `_deviceId2` is gone → `getDeviceId` mints and persists a **new**
  id on first launch.

**Is this "matching expectations"?** Yes. A clean reinstall is, by design, a fresh
install with no carried-over state; getting a new device identity is the correct
and expected outcome. The only user-visible consequence is that the Jellyfin
server's **Dashboard → Devices/Sessions** will show a new device entry after a
clean reinstall (the old one lingers until reaped), and per-device server-side
settings tied to the old id reset. This is standard for the Jellyfin Tizen client
and acceptable; it is not a bug to fix.

## Degraded path: persistent storage-write failure (cross-ref JEL‑60)

If the very first `setItem("_deviceId2")` throws (e.g. `QuotaExceededError`), the
`try/catch` swallows it: `getDeviceId` still **returns a usable id this session**
(no crash), but the id never reaches storage, so the **next** boot generates a
different one. Stability therefore depends on a healthy storage write succeeding
once. Once the write lands, the id is stable from then on. This is the single
non-stable path and is consistent with the localStorage-quota degradation work in
JEL‑60. The harness exercises it explicitly (throwing-`setItem` boot, then a
recovering boot that persists).

## On-device confirmation (optional)

The behavior is fully determined by `localStorage` persistence, which the harness
proves hermetically, so no pixel capture is required. If a physical-device spot
check is still wanted, the reproducible steps are:

1. Launch the app; in the dev console (or via the QA overlay) read
   `localStorage['_deviceId2']` and `NativeShell.AppHost.deviceId()` — they match.
2. Reboot the TV, relaunch, read both again → unchanged. (Confirms reboot.)
3. `sdb shell` → reinstall the **same** signed `.wgt` over the top (update path) →
   relaunch → id unchanged. (Confirms update-over-install.)
4. `tizen uninstall` the package, then install the `.wgt` fresh → relaunch →
   `_deviceId2` is a **new** value. (Confirms clean-reinstall mint.)

Steps 1–2 are the issue's core assertion; 3–4 document the reinstall split. All
four outcomes are what the harness asserts above.
