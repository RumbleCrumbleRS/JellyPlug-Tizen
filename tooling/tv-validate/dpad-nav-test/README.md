# D-pad navigation + body-focus rescue test (JEL-33)

Automated, reproducible verification that arrow-key (D-pad) navigation works
across the main Jellyfin UI pages and that **the shell's body-focus rescue
mechanism fires and succeeds**.

## What it checks

On **Home, Library, Search, Settings, and Details**, against a live Jellyfin
server, with the deployed rescue IIFE injected:

1. **Rescue fires** — an `ArrowDown` keydown while `document.activeElement` is
   `<body>` increments `window.__shellBodyFocusRescueAttempts`.
2. **Rescue succeeds** — `window.__shellBodyFocusRescues` increments and focus
   leaves `<body>` onto a real, visible focusable element.
3. **Focus is not stuck** — subsequent arrow/Tab events reach multiple distinct
   focus targets.

## Why this also covers the TV

The rescue IIFE under test is read at runtime from
`packages/shell-tizen-bootstrap/src/boot-shell.src.js`. That block is
**byte-identical (3497 bytes)** to the one in `packages/shell-tizen/src/shell.js`
(the hosted-shell path), so the same code runs on the Tizen set. It is pure ES5
(`var`, `function`, `try/catch`, `querySelectorAll`, `getBoundingClientRect`,
`offsetParent`, `focus()`) — every primitive is in the M63 feature matrix
(verified TRUE in JEL-17/18). The only difference between platforms is the JS
engine (M63 vs V8). On-device telemetry confirmation is tracked separately
(see the parent comparison issue JEL-28).

## Run it

```bash
# 1) bootstrap a headless Chrome-for-Testing + launch CDP on :9222
./bootstrap-chromium.sh

# 2) export the libs the launcher printed, then run the test
export JELLYFIN_URL=... JELLYFIN_USER=... JELLYFIN_PASS=...
node dpad-test.mjs        # prints a JSON report, exits non-zero on any FAIL
```

`bootstrap-chromium.sh` works in a no-root sandbox: it downloads
Chrome-for-Testing directly and resolves its shared-library closure into a local
sysroot via a user-prefix `apt-get` (no system install). Everything lands under
`/tmp/dpadval` (throwaway).

## Files

- `bootstrap-chromium.sh` — sandbox headless-Chromium bring-up + CDP launch.
- `cdp.mjs` — tiny dependency-free CDP client over the Node built-in WebSocket.
- `dpad-test.mjs` — the login + 5-page walk + rescue/not-stuck assertions.

Captured run output (evidence) is not kept in the repo — it goes to the
Paperclip issue (JEL-33). See `../EVIDENCE-POLICY.md`.
