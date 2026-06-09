# JEL-69 — Compare: selectServer flow (switch to a different Jellyfin server)

**Verdict: confirmed correct. A server switch clears _only_ the saved server
URL, drops the shell back to the connect screen, accepts a new server URL, and
reuses the same persisted device id throughout — identically on TV and browser.
60/60 checks pass.**

```
node tooling/tv-validate/select-server/verify-select-server.mjs   # 60/60 PASS
node packages/shell-tizen/scripts/select-server.test.cjs          # CI-wired contract guard
```

## What a server switch actually is

`NativeShell.selectServer()` is two lines:

```js
selectServer: function () {
  clearServerUrl();                       // removeItem("jellyfin.shell.serverUrl")
  window.location.replace("index.html");  // reload → re-enters bootstrap()
}
```

`clearServerUrl()` removes **only** the `jellyfin.shell.serverUrl` key. The
reload re-enters `bootstrap()`, which branches on `loadServerUrl()`:

- a stored URL → `loadRemoteWebClient(stored)` (auto-connect);
- an empty one → `attachConnectForm()` — **the connect screen**.

The connect form's submit handler runs `validateServer(url)` →
`saveServerUrl(url)` → `loadRemoteWebClient(url)`, so typing a new address and
pressing Connect persists the new URL and loads the new server. The device id
(`localStorage["_deviceId2"]`) is **never touched** by any of this — neither
`clearServerUrl` nor the connect path reads or writes it — so the same identity
is reported to both the old and the new server.

The "in-app server-change option" the issue mentions is jellyfin-web's own
**Select Server** menu item, which calls this same `NativeShell.selectServer()`;
there is no separate code path.

## The five requirements, each mapped to a proof

| #   | Requirement                              | How it holds                                                                                           | Proof in harness                                                                            |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 1   | Old server URL cleared from localStorage | `selectServer` → `clearServerUrl()` → `removeItem(SERVER_URL_KEY)`                                     | runs the real `selectServer` body; asserts the key is gone and was the **only** key removed |
| 2   | Connect screen reappears                 | reload → `bootstrap()` → `loadServerUrl() === ""` → `attachConnectForm()`                              | new realm over the cleared store returns `""`                                               |
| 3   | Entering a new URL + connecting works    | submit → `validateServer` → `saveServerUrl(new)` → `loadRemoteWebClient(new)`                          | persists `NEW_SERVER`; the next-boot realm auto-connects to it                              |
| 4   | Device id reused (same UUID)             | `_deviceId2` untouched by clear/connect; `getDeviceId` only mints when missing                         | id before == id after the whole switch; **zero** new `setItem("_deviceId2")`                |
| 5   | Identical on TV and browser              | none of this code branches on `tizen`/`webapis`; both shells share the keys + `selectServer` semantics | every assertion runs under both a legacy-TV UA and a modern-browser UA, on both shells      |

## Why this is verifiable off-device (not a pixel capture)

`clearServerUrl`, `loadServerUrl`, `saveServerUrl`, `getDeviceId` and the
`selectServer` body contain no `tizen`/`webapis` branch. To them a TV reload, a
browser refresh and a fresh app process are the same thing: a new JS realm over
whatever `localStorage` the platform persisted. So the entire switch reduces to
"what's in the store across a sequence of realms?", which the harness controls
directly.

The harness lifts the real functions (and the real `selectServer` method body)
**verbatim** from each shell and walks the exact platform sequence over **one**
shared `localStorage` double that holds **both** keys:

```
connected(old) + device id minted
   → selectServer()          → URL key removed, device id untouched, nav→index.html
   → reload (new realm)      → loadServerUrl() === ""  (connect screen)
   → type new URL + connect  → saveServerUrl(new)
   → reload (new realm)      → loadServerUrl() === new  (auto-connect), same device id
```

The double counts `setItem("_deviceId2")` calls and records `removeItem` keys,
so "reused the id" (no write) vs "minted a new id" (a write) and "cleared only
the URL" (one specific removal) are deterministic signals, not probabilistic id
comparisons.

## Device-id reuse — the subtle requirement

This is the part a naive "switch server" implementation gets wrong: wiping
storage wholesale (`localStorage.clear()`) on a server change would also wipe
`_deviceId2`, minting a brand-new device identity and littering the new server's
**Dashboard → Devices** with a fresh entry on every switch. The shipped code
avoids that by removing exactly one key. The harness asserts
`storage.calls.removed === ["jellyfin.shell.serverUrl"]` — a regression that
broadened the clear (or added a `localStorage.clear()`) would flip this check.

This dovetails with [JEL-67](/JEL/issues/JEL-67) (device-id stability across
boots/reinstalls): JEL-67 proved the id survives the platform lifecycle; JEL-69
proves it also survives an in-app **server switch**.

## TV vs browser parity

Both shipped shells — the full `shell.js`/`shell.min.js` and the retail
bootstrap `boot-shell.src.js`/`boot-shell.min.js` — use the identical keys
(`jellyfin.shell.serverUrl`, `_deviceId2`) and a semantically identical
`selectServer` body. The only difference is cosmetic: `shell.js` joins the two
calls as two `;` statements, the minifier-friendly bootstrap as a single
`(a, b)` comma sequence. The harness normalises whitespace + the separator and
asserts the bodies are otherwise byte-identical, and both deployed `.min.js`
blobs still carry both keys and a `selectServer`.

## On-device confirmation (optional)

The behavior is fully determined by `localStorage`, which the harness proves
hermetically, so no pixel capture is required. If a physical-device spot check
is still wanted, the reproducible steps are:

1. Connect to server A. In the QA overlay/console read
   `localStorage['jellyfin.shell.serverUrl']` (== A) and
   `localStorage['_deviceId2']` (note it).
2. Invoke **Select Server** (or call `NativeShell.selectServer()`). The app
   reloads to the connect screen; `jellyfin.shell.serverUrl` is now gone but
   `_deviceId2` is unchanged.
3. Enter server B and Connect. `jellyfin.shell.serverUrl` is now B; the app
   loads B's login UI.
4. Read `NativeShell.AppHost.deviceId()` / `localStorage['_deviceId2']` → the
   **same** value as step 1. Server B's Dashboard shows the device under that id.

All four outcomes are what the harness asserts above, for both TV and browser.
