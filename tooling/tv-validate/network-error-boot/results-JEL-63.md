# JEL-63 — Compare: Network error handling — server unreachable at boot

**Scenario:** a server URL is already saved (warm boot), but the host is now
unreachable. Verify on **TV** and **browser** that (1) the `/web/index.html`
fetch times out gracefully, (2) an error message is shown, (3) the connect
screen reappears for re-entry, (4) the saved URL is **not** cleared, and (5) the
error text is identical on both platforms.

## Verdict

**PASS — after a fix.** Verification surfaced two genuine gaps against the spec;
both are now fixed in the **same code path on both shells**, so all five
requirements hold and are parity-equal by construction.

Harness: `tooling/tv-validate/network-error-boot/verify-network-error-boot.mjs`
— **32/32 checks pass** (source guards + real-shell.js runtime under a modern
browser navigator and a legacy Tizen navigator, for both an eternal-hang fetch
and an immediate-reject fetch).

## What was found (pre-fix)

The boot-failure path lives in `bootstrap()`, which is duplicated **identically**
in both shells — `packages/shell-tizen/src/shell.js` (TV) and
`packages/shell-tizen-bootstrap/src/boot-shell.src.js` (hosted/browser). There is
no per-UA branch, so reqs (2), (3) and (5) already held on both platforms. But:

| Req                          | Behaviour before                                                                                                                                                                                                                                           | Status |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| (1) graceful timeout         | `fetch(baseUrl+"index.html")` had **no timeout** → on an unreachable-but-routable host (SYN dropped) boot hung for the platform's default TCP connect timeout, which **differs** between Tizen Chromium and desktop Chrome. Not bounded, not parity-equal. | ❌     |
| (2) error shown              | `showError("Saved server is unreachable. Enter a new address.")`                                                                                                                                                                                           | ✅     |
| (3) connect reappears        | `attachConnectForm()` reveals `#boot-root`                                                                                                                                                                                                                 | ✅     |
| (4) URL not cleared          | `clearServerUrl()` was called in the catch → the saved URL **was wiped**, forcing a full retype.                                                                                                                                                           | ❌     |
| (5) same text both platforms | single UA-independent literal                                                                                                                                                                                                                              | ✅     |

## The fix (both shells, in lockstep)

1. **Bounded, parity-equal timeout** — added `withBootTimeout(p, label)`, a
   `Promise.race`-style 15 s timer (`BOOT_FETCH_TIMEOUT_MS`). 15 s sits far above
   any healthy `/web/` RTT (200–500 ms typical) yet well below the platform TCP
   default, so it never fires on a reachable server but recovers an unreachable
   one to the connect screen at the **same** moment on TV and browser. It is
   `setTimeout`-based on purpose — **safe on Chromium 56**, which predates
   `AbortController`. Applied to both the `index.html` and `config.json` boot
   fetches (covers the fresh-fetch and adopted-prefetch sources).
2. **Do not clear the saved URL** — dropped `clearServerUrl()` from the
   boot-failure catch. The host is often only _temporarily_ unreachable (TV woke
   from standby, router rebooting, Wi-Fi reassociating).
3. **One-press retry** — `attachConnectForm()` now pre-fills `#server-input` with
   the saved URL, so the user presses Connect once to retry the same host.
4. **Error text** — unified to `"Could not reach saved server. Check your network
and try again."`, emitted from the single UA-independent catch → byte-identical
   on both platforms.

Files: `packages/shell-tizen/src/shell.js`,
`packages/shell-tizen-bootstrap/src/boot-shell.src.js` (+ regenerated
`boot-shell.min.js` via `build_boot_shell.py --promote`; the JEL-24 equivalence
guard passes: `src ≡ min`).

## Verification

- `node tooling/tv-validate/network-error-boot/verify-network-error-boot.mjs` →
  **32/32**. Runs the **real shell.js** bootstrap end-to-end in a vm under both a
  browser and a Tizen-legacy navigator, with a saved URL and a fetch that (a)
  hangs forever and (b) rejects immediately. Asserts on each platform: bounded
  recovery (the 15 s bound is the value the production code actually requests),
  error displayed, connect screen revealed, **URL preserved**, input pre-filled,
  and identical error text across platforms.
- `node packages/shell-tizen/scripts/server-url-persistence.test.cjs` → all pass.
  Updated its boot-failure wiring contract (both shells) from "clears key" to
  "preserves key + pre-fills + network error".
- `python3 packages/shell-tizen-bootstrap/scripts/verify_boot_shell_src.py` →
  `OK: boot-shell.src.js ≡ boot-shell.min.js`.
- `node packages/shell-tizen-bootstrap/scripts/selftest.cjs` → ALL SCENARIOS PASS.
- Prettier clean; JEL-58 prefetch structural guards still pass (its only failure
  is the live test server returning 502, unrelated to this change).

## Why a Node/vm harness and not a TV pixel capture

The failure handling is a pure browser-side boot mechanism (bounded timer +
`localStorage` + connect-form DOM) with **no per-UA branch** — its correctness is
structural and runtime-deterministic and does not depend on the Tizen WebView's
rendering. The harness executes the exact `shell.js` bytes under both navigators,
which proves the parity directly.

## Release gate (action for CEO)

This changes the **deployed bootstrap bytes** (`boot-shell.min.js`). Per
`build_boot_shell.py` and memory `tv-webview-wedge-on-reinstall`, promoting the
bootstrap requires fresh **on-device validation** before the next bootstrap
release cut. Repro on a physical TV: save a reachable server, confirm normal
boot; then point the saved URL at an unreachable host (e.g. power off the server
or set an unroutable address), reboot the app, and confirm — within ~15 s — the
connect screen returns with the address pre-filled and the message _"Could not
reach saved server. Check your network and try again."_, and that pressing
Connect retries the same host. No `.wgt` was cut or installed in this change.
