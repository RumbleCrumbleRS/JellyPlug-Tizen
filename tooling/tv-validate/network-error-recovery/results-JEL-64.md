# JEL-64 — Network error recovery (server unreachable mid-session): TV vs browser

**Scope:** After the web client is loaded and the user is browsing, the Jellyfin
server becomes unreachable. Verify (1) jellyfin-web shows its **own** network
error UI, (2) TV behaviour matches the browser, (3) the network restoring
recovers the session with **no full app restart**, and (4) the shell does not
interfere with jellyfin-web's own error handling.

**Verdict:** ✅ **Parity by construction.** Once the remote web client has booted
(`window.__jellyfinShellBootDone === true`) the shell is a transparent host: it
intercepts nothing that a failing API call touches, installs no competing
offline UI, intercepts no keys, and never resets session state on a network
condition. So jellyfin-web's own error handling and recovery run byte-for-byte
the same on the Tizen 5.0 (M63) WebView as in a desktop browser.

Automated proof: `packages/shell-tizen/scripts/network-error-recovery.test.cjs`
(wired into `pnpm --filter @jellyfin-tv/shell-tizen test`) — **all checks pass**
against both shipping shells (`shell.js`, `boot-shell.src.js`) and their deployed
minified blobs.

---

## Why "mid-session" reduces to a transparency proof

"Mid-session" = the user is already browsing, so the remote web client owns the
document. The shell can only affect jellyfin-web through five surfaces; each is
verified inert mid-session:

| # | Surface | Shell behaviour mid-session | Effect on jellyfin-web error handling |
|---|---------|------------------------------|----------------------------------------|
| a | **Network (XHR/fetch)** | The seed shim intercepts **only** `config.json` (`/(^\|/)config\.json(\?\|$)/`); every other URL defers to the native transport (`origFetch.call` / `origSend.apply`). | Data calls (`Items`, `PlaybackInfo`, `Sessions/Playing`, images, streams) fail **natively** when the server dies — exactly as in a browser — so jellyfin-web's own `.catch()`/`onerror` fires and draws its error toast / "connection lost" UI. |
| b | **Competing offline UI** | No `navigator.onLine` probe, no `online`/`offline` listener, no `navigator.connection`, no mid-session overlay. | Nothing is drawn over jellyfin-web's error UI. |
| c | **Input** | The shell's only key binding is BACK (10009), and it **early-returns** once `__jellyfinShellBootDone` is set. | Every key jellyfin-web's error UI needs (Back / retry / navigate) reaches it unmodified. |
| d | **Error events** | Global `error` / `unhandledrejection` listeners are **diagnostic-only**: they record into the HUD, then (for rejections) `preventDefault()` **after** recording. They never `stopImmediatePropagation`. | A rejection that jellyfin-web `.catch()`-es never becomes "unhandled", so the shell handler never sees it; on a genuinely unhandled rejection `preventDefault()` only suppresses the browser's default console log — it cannot cancel a `.catch()` that already ran. jellyfin-web's handling is untouched. |
| e | **Recovery / state** | Server-state teardown + the shell's own error message live **only** in the boot-time `loadRemoteWebClient(stored).catch`. Nothing wires them to a mid-session timer/event; the shell never calls `location.reload()` on a network condition. | When the network restores, jellyfin-web's next call/poll succeeds against the still-loaded client → **no restart**. |

### TV == browser by construction
The intercept decision (`matches()`) and the BACK gate reference **no**
`tizen`/`webapis` global — they use only `XMLHttpRequest`, `window.fetch`,
`Response`, a regex, and a `window` flag. So the intercept-or-passthrough
decision and the post-boot key behaviour are identical on TV and browser. The
test asserts the absence of any Tizen-only branch in the shim.

---

## What the automated test checks

`node packages/shell-tizen/scripts/network-error-recovery.test.cjs`

- **Part A (behavioural):** lifts the exact `matches(u)` predicate the shim
  ships and runs it against real Jellyfin endpoints. Every
  data/playback/auth/asset URL — plus adversarial near-misses
  (`config.jsonp`, `config.json/extra`, `myconfig_json`) — **passes through**;
  all `config.json` variants (`?cacheBust`, `/web/config.json`, bare) are
  intercepted.
- **Part B (source contract):** pass-through wiring (`origFetch.call` /
  `origSend.apply`); no `navigator.onLine` / `online` / `offline` /
  `navigator.connection` on any shell incl. minified; BACK yields to the web
  client post-boot; the unhandledrejection diag records before `preventDefault`
  and never `stopImmediatePropagation`; the shell's error UI is reachable only
  from the boot catch and never from a `setInterval`; no `location.reload` on a
  network condition; no Tizen-only branch in the shim; minified blobs carry the
  same config-only shim.
- **Part C (observations):** see below.

---

## Observations (informational)

1. **config.json is the only seeded resource.** If jellyfin-web re-fetches
   `config.json` *while the server is down mid-session*, the shim still resolves
   it `200` from the seeded body. This is **benign and parity-neutral**:
   `config.json` is static boot config with no liveness signal, browsers cache
   it too, and the error UI is driven by **data** calls (which the shim passes
   through to fail natively). It cannot mask the outage.

2. **Boot-time recovery divergence between the two shells (JEL-63 follow-up, not
   a mid-session issue).** Both shells keep their network-failure UI strictly in
   the boot catch, but they differ on what that catch does:
   - `shell.js` (full shell): JEL-63 applied — **keeps** the saved server URL and
     re-shows the connect form pre-filled, copy =
     _"Could not reach saved server. Check your network and try again."_ so a
     single Connect press retries the same server.
   - `boot-shell.src.js` (the **retail** bootstrap): still **clears** the saved
     URL, copy = _"Saved server is unreachable. Enter a new address."_

   Because the deployed artifact is the bootstrap, a **boot-time** outage on the
   TV currently wipes the saved URL and forces a retype. This does not affect the
   JEL-64 *mid-session* scenario, but porting JEL-63 to the bootstrap is the
   right follow-up. Filed as a note here for triage.

---

## On-device (Tizen 5.0 / M63) manual repro

Production Q60R retail TVs lock down `sdb dlog` and the Web Inspector, so
on-device evidence is read via the always-on diag HUD + QA beacon
(`error`/`unhandledrejection` capture). To reproduce on a paired TV:

1. Boot the app and log in; navigate to Home / a library (web client loaded).
2. Disable the Jellyfin server (stop the service or drop it off the LAN).
3. Browse to a new row / open an item. **Expect:** jellyfin-web's own error
   handling fires (toast / retry affordance) — identical to the browser. The
   shell draws **no** overlay and swallows **no** keys.
4. Restore the server. Navigate again (or let a poll fire). **Expect:** the
   session recovers **without** relaunching the app — no shell "connect form",
   no URL wipe, no reload.

Cross-check the same four steps in a desktop browser pointed at the same server;
behaviour matches step-for-step. The HUD's error log and the beacon payload
(`errors[]`, `qcState`, `url`) record the on-device sequence for screenshot
evidence.
