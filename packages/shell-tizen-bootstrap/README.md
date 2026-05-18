# @jellyfin-tv/shell-tizen-bootstrap

Hosted Shell Bootstrap (HSB) for Samsung Tizen TVs.

## What this is

A near-immutable sub-580 KB WGT that gets installed **once** on a TV via
Samsung Device Manager GUI. At launch it:

1. Reads `serverUrl` from `localStorage`.
2. If absent → renders the connect form (same UX as the old shell).
3. If present → fetches `${server}/shell/manifest.json` (1.5 s timeout) and
   `<script src>`-loads the advertised `shell.min.js?sha=<hash>`.
4. On any failure → falls back to the baked `boot-shell.min.js` (last-known-good
   v80 shell shipped inside this WGT).

After install, every shell update is a server-side file swap into
`${server}/shell/`. No `sdb shell`, no `pkgcmd`, no re-signing the WGT per
release.

See `INSTALL.md` for the install procedure and
`../server-shell-drop/README.md` for the canonical `${server}/shell/` layout.

## Build

```bash
pnpm --filter @jellyfin-tv/shell-tizen-bootstrap build
# or directly:
python3 scripts/build_bootstrap.py
```

Outputs:

- `dist/JellyfinShellBootstrap_v<ver>.wgt` — unsigned WGT, sign with Tizen
  Studio Certificate Manager before pushing to a TV.
- `manifest.bootstrap.json` — sha256 + size, for advertising in
  `${server}/shell/` bootstrap-install flows.

Re-bake the baked-in shell from a fresh v80 build:

```bash
python3 scripts/build_bootstrap.py --shell-src /path/to/v80_src
```

## Test

```bash
pnpm --filter @jellyfin-tv/shell-tizen-bootstrap test
# or directly:
node scripts/selftest.cjs
```

Covers four bootloader branches: no-server, manifest 200, script onerror
fallback, manifest network error.

## Layout

```
packages/shell-tizen-bootstrap/
├── INSTALL.md                   # Install procedure (Device Manager GUI primary)
├── README.md                    # This file
├── manifest.bootstrap.json      # sha256 + size of the most recent build
├── package.json
├── scripts/
│   ├── build_bootstrap.py       # Builds the WGT + emits manifest stub
│   └── selftest.cjs             # Bootloader scenario tests
└── src/
    ├── babel.min.js             # Lazy fallback transpiler (legacy Chromium)
    ├── boot-shell.min.js        # Baked last-known-good v80 shell
    ├── config.xml               # Tizen widget manifest (version source of truth)
    ├── icon.png
    └── index.html               # Bootloader (inline <script>)
```

## Related

- Source: [JEL-2040](../../README.md) — HSB delivery.
- Verification: [JEL-2046](../../README.md) — AC3 install on Q60 via
  Device Manager with `intershell_support:disabled`.
- Architecture: see [[hsb-architecture]] in the engineer wiki.
