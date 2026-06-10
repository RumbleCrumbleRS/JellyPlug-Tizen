# Hosted Shell Bootstrap v2.0.8 — JEL-118 JellyPlug rename (signed)

`JellyPlugBootstrap_v2.0.8.wgt` — 582,719 bytes, sha256
`1b1dfef33cb6b9a965ac99faa7655cef0853b83d15751b11f108757995a6220c`.

**Signed (author + distributor).** Produced by the `bootstrap-sign` GitHub
Actions workflow from tag `bootstrap-v2.0.8` (run `27302996426`, commit
`5705ac6`) and verified by `tooling/ci/verify-wgt-signed.sh` (embeds
`author-signature.xml` + `signature1.xml`). Installable on a retail Tizen TV
via Samsung Device Manager.

## What this build adds (JEL-118, on top of retail v2.0.7)

- **JEL-118** — the Samsung launcher splash renders `<name> Loading...`
  from the installed widget's `config.xml`, so the TV showed
  "JellyfinShell Loading". This cut renames every user-visible surface to
  **JellyPlug**: `config.xml` `<name>` (the splash text), the bootloader
  `index.html` `<title>`, and the artifact filename convention
  (`JellyPlugBootstrap_v<ver>.wgt`). The widget id
  (`http://jellyfin.org/JellyfinShell`), `tizen:application` package
  (`JelShellTV`) and `jellyfin.shell.*` localStorage keys are deliberately
  unchanged so this installs as an in-place upgrade with stored state
  intact (PR #39).

## Byte identity

- Embedded `index.html` sha256
  `ffe6121c9be13efe5f22f5f94aa278f2d1ec0e48c79403697124e296adc7037e` —
  byte-identical to `packages/shell-tizen-bootstrap/src/index.html` at
  `5705ac6`.
- Embedded `boot-shell.min.js` sha256
  `6cf13a49590de1f6a247b296ec846ebf050b9bb3a361a7b6a13a73f52ad84919` —
  byte-identical to merged `main` (unchanged since v2.0.6; this cut only
  changes `config.xml` and the bootloader `index.html`).

## Install

In-place upgrade or fresh install via Samsung Device Manager GUI; no sdb
shell required. Functionally identical to v2.0.7 — only user-visible
naming changes.
