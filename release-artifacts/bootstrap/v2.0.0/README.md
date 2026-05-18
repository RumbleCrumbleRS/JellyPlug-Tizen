# Hosted Shell Bootstrap v2.0.0 (unsigned)

`JellyfinShellBootstrap_v2.0.0.wgt` — 579,500 bytes, sha256
`62d738c4b89aef5ecc09f75282dffcc782186678bc195d41c1ef84392094de1f`.

**Unsigned.** Sign with Tizen Studio Certificate Manager (same author profile
used for previous JellyfinShell WGTs) before installing on a TV. The bootstrap
itself is near-immutable; once installed it updates the shell via
`${server}/shell/` swap with no further `sdb shell` / `pkgcmd` operations.

Source: `packages/shell-tizen-bootstrap/`.
Install procedure: `packages/shell-tizen-bootstrap/INSTALL.md`.

Reproducible rebuild:

```bash
pnpm --filter @jellyfin-tv/shell-tizen-bootstrap build
```

JEL-2040 delivery. JEL-2046 tracks AC3 verification on Q60 with
`intershell_support:disabled`.
