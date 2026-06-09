# Hosted Shell Bootstrap v2.0.2 — M63 spotlight-hero render fix (signed)

`JellyfinShellBootstrap_v2.0.2.wgt` — 581,309 bytes, sha256
`4a3382890f1f054c2be3dd06d4ed2578cebf1a0804c93eb46b7e65cc44603bf9`.

**Signed (author + distributor).** Produced by the `bootstrap-sign` GitHub
Actions workflow from tag `bootstrap-v2.0.2` and verified by
`tooling/ci/verify-wgt-signed.sh` (embeds `author-signature.xml` +
`signature1.xml`). Installable on a retail Tizen TV via Samsung Device Manager.

## What this build adds (JEL-25, promotes JEL-17)

The baked `boot-shell.min.js` carries the M63 EditorsChoice spotlight-hero render
fix. The custom babel was downleveling `for…of`/spread into a broken iterator
helper that threw "not iterable" on Chromium-63, breaking Splide (EditorsChoice's
carousel). Five changes fix it:

1. babel preset-env `targets:{chrome:"63"}` (was 56 — M63 runs for-of natively)
2. `loose:true`
3. `assumptions:{iterableIsArray:true, arrayLikeIsIterable:true}`
4. `MODERN_SYNTAX_RE` BigInt false-positive fix so Splide transpiles cleanly
5. warm `shell.txLru` transpile cache (no per-boot cold re-transpile)

The embedded `boot-shell.min.js` is **byte-identical** (sha256
`eb77feb1a925f8a31f8a47e245e9802f07787518abbe0e4c9b80215ad2c9d0df`) to the build
proven to render the spotlight hero on the physical M63 TV in JEL-17.

vs v2.0.1, this build also ships the AC3 diagnostic overlay **OFF by default**
(JEL-22 — opt in with `localStorage.setItem('jellyfin.shell.hsbDebug','1')`) and
drops all JEL-7/17 debug telemetry scaffolding.

## Verification

Installed and version-confirmed on the physical M63 set (`QN82Q60RAFXZA`,
2026-06-09): `vd_appinstall` ran clean (`install completed`, `cmd_ret:0`) as a
same-cert upgrade over v2.0.1, and both the firstscreen REST API and `vd_applist`
read back `app_version=2.0.2`. On-screen pixel capture is not possible on this
locked Tizen 5.0 device (sdbd allowlists only `vd_appinstall`/`vd_applist`;
`screencap`/framebuffer/CDP all blocked), so render verification rests on the
byte-identical-to-JEL-17 shell hash.

## Source

`packages/shell-tizen-bootstrap/`. JEL-2040 architecture; JEL-25 release of the
JEL-17 fix.
