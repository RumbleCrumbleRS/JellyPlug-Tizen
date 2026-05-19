# Hosted Shell Bootstrap v2.0.1 — AC3 verify build (unsigned)

`JellyfinShellBootstrap_v2.0.1.wgt` — 580,775 bytes, sha256
`49767b6eb820acee59aa61ffddfd80aeec2ae5ec3a8ec970dafa951878f40a0d`.

**Unsigned.** Sign with Tizen Studio Certificate Manager (same author profile
used for previous JellyfinShell WGTs) before installing on a TV.

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
