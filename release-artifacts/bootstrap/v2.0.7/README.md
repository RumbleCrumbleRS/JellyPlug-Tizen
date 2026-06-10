# Hosted Shell Bootstrap v2.0.7 — JEL-115 first-connect fix (signed)

`JellyfinShellBootstrap_v2.0.7.wgt` — 582,715 bytes, sha256
`0efb2d46148fb5b52a7b6e6d96ac5e0cf66abd93f9772cd6ca554104a4920415`.

**Signed (author + distributor).** Produced by the `bootstrap-sign` GitHub
Actions workflow from tag `bootstrap-v2.0.7` (run `27297804321`, commit
`c94d6a2`) and verified by `tooling/ci/verify-wgt-signed.sh` (embeds
`author-signature.xml` + `signature1.xml`). Installable on a retail Tizen TV
via Samsung Device Manager.

## What this build adds (JEL-115, on top of retail v2.0.6)

- **JEL-115** — fresh-install black screen after entering the server URL.
  On a fresh install the HSB bootloader showed its own connect form whose
  submit handler saved the raw input and called `location.reload()` — the
  only boot step unique to a fresh install (every on-device QA boot
  pre-seeded `jellyfin.shell.serverUrl`, so the reload path was never
  exercised on hardware) and it black-screened the Tizen 5.0 / Chromium 63
  webview. An app restart then took the stored-URL path and worked, matching
  the user report. The submit handler now normalizes the URL (bare hosts →
  `http://`, trailing slashes stripped — parity with boot-shell
  `normalizeServerUrl`), saves it, and calls `loadHostedShell()` **in
  place**, so first-connect follows the exact stored-URL boot path that
  restarts use. A `__hsbConnectStarted` re-entry guard prevents a second
  submit from double-loading the shell, and the form is `novalidate` so bare
  `host:port` input reaches the JS normalizer instead of being silently
  swallowed by `type=url` validation. Guarded by `selftest.cjs` scenarios
  5–7 (PR #38).

## Byte identity

- Embedded `index.html` sha256
  `0dd6d0b4de732f88c24d57da083c1781130013785b2d5cbd0bde1b5702bbf41a` —
  byte-identical to `packages/shell-tizen-bootstrap/src/index.html` at
  `c94d6a2`.
- Embedded `boot-shell.min.js` sha256
  `6cf13a49590de1f6a247b296ec846ebf050b9bb3a361a7b6a13a73f52ad84919` —
  byte-identical to merged `main` (unchanged since v2.0.6; this cut only
  changes the bootloader `index.html` and `config.xml` version).

## Install

Fresh TV: install via Samsung Device Manager GUI; no sdb shell required.
Upgrading a TV that already has a stored server URL does not exercise the
fixed path (the bug only affected the very first connect after install).
