# Hosted Shell Bootstrap v2.0.1 — AC3 verify build (signed)

`JellyfinShellBootstrap_v2.0.1.wgt` — 580,197 bytes, sha256
`8d6297d44eaae09b82ad89e5aad0cdc7f511415aa6bec52f2c40cdbaaeee5ebb`.

**Signed (author + distributor).** Produced by the `bootstrap-sign` GitHub
Actions workflow from `main` (`configure-tizen-signing.sh` → `build_bootstrap.py
--sign-profile jellyfin` → `tizen package -t wgt -s jellyfin`) and verified by
`tooling/ci/verify-wgt-signed.sh` (embeds `author-signature.xml` +
`signature1.xml`). Installable on a retail Tizen TV via Samsung Device Manager —
no manual Certificate Manager step required (JEL-8).

## What this build adds

JEL-2046 found that the Q60 sdbd advertises `intershell_support:disabled` AND
`appcmd_support:disabled`, both of which are required for Tizen Studio debug-launch
(`tizen run --debug` / Device Manager Web App Inspector). With no Web Inspector
available we can't read `window.__hsbShellUrl` / `window.__hsbFallback` directly.

v2.0.1 bakes a visible diagnostic overlay into the bootstrap that renders the
HSB state on screen at the bottom of the TV, color-coded:

- green — happy path, hosted shell loaded from `${server}/shell/`
- yellow — fell back to baked `boot-shell.min.js` (with reason)
- red — fatal load error

The overlay disappears the moment the hosted shell calls `document.write(...)`
to mount the real Jellyfin web client — its disappearance is itself the
"shell loaded" signal.

Disable post-AC3:

```js
localStorage.setItem('jellyfin.shell.hsbDebug', '0');
```

## Source

`packages/shell-tizen-bootstrap/`.
Reproducible rebuild:

```bash
pnpm --filter @jellyfin-tv/shell-tizen-bootstrap build
```

JEL-2040 architecture. JEL-2046 AC3 verification.
