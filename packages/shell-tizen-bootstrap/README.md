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
   shell shipped inside this WGT; source of record in `boot-shell.src.js`).

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

- `dist/JellyPlugBootstrap_v<ver>.wgt` — unsigned WGT, sign with Tizen
  Studio Certificate Manager before pushing to a TV.
- `manifest.bootstrap.json` — sha256 + size, for advertising in
  `${server}/shell/` bootstrap-install flows.

### Baked-in shell source (JEL-24)

The baked-in `src/boot-shell.min.js` is the deployed, on-device-validated
bootstrap shell. Its **maintainable source of record** is `src/boot-shell.src.js`
(a de-minified, prettier-formatted copy — mangle is OFF so it reads cleanly).
The two are kept in lock-step by a CI guard:

```bash
# Prove src == deployed (both canonicalized through the same esbuild):
python3 scripts/verify_boot_shell_src.py

# Regenerate boot-shell.min.js from source (esbuild minify + JEL manifest):
python3 scripts/build_boot_shell.py            # -> dist/ (review), runs the guard
python3 scripts/build_boot_shell.py --promote  # overwrite src/boot-shell.min.js
```

Edit `boot-shell.src.js`, not the minified blob. The CI `verify-shell-source`
job fails if the two diverge. Promoting a rebuild changes the bytes shipped to a
locked TV, so validate on-device before release.

> Historical note: the old `--shell-src ../_jel*_v80_src` flow is dead — that
> shell source tree was never committed and is lost. JEL-24 recovered the source
> by de-minifying the deployed artifact.

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
│   ├── build_boot_shell.py      # Rebuilds boot-shell.min.js from .src.js (JEL-24)
│   ├── verify_boot_shell_src.py # CI guard: .src.js ≡ .min.js (JEL-24)
│   └── selftest.cjs             # Bootloader scenario tests
└── src/
    ├── babel.min.js             # Lazy fallback transpiler (legacy Chromium)
    ├── boot-shell.min.js        # Baked deployed shell (validated artifact)
    ├── boot-shell.src.js        # Source of record for boot-shell.min.js (JEL-24)
    ├── boot-shell.manifest.txt  # JEL-history manifest prefix (JEL-929 passthrough)
    ├── config.xml               # Tizen widget manifest (version source of truth)
    ├── icon.png
    └── index.html               # Bootloader (inline <script>)
```

## Related

- Source: [JEL-2040](../../README.md) — HSB delivery.
- Verification: [JEL-2046](../../README.md) — AC3 install on Q60 via
  Device Manager with `intershell_support:disabled`.
- Architecture: see [[hsb-architecture]] in the engineer wiki.
