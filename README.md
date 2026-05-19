# JellyPlug-Tizen / jellyfin-tv-shell

Thin browser-shell apps for Jellyfin on TV. Each platform shell loads the
**live** Jellyfin web client from `${server}/web/` so server-installed plugins
work 1:1 on TV — same code, same plugins, every platform.

The Tizen path uses the **Hosted Shell Bootstrap (HSB)**: a near-immutable
580 KB WGT installed once on the TV, which then fetches `shell.min.js` from
`${server}/shell/` at launch. Every shell update afterwards is a server-side
file swap — no `sdb shell`, no `pkgcmd`, no re-signing the WGT per release.

---

## Quick Start — install on a Samsung Tizen TV

You need:

- Tizen Studio installed.
- `tizen` CLI on `PATH` (the installer adds `C:\tizen-studio\tools\ide\bin\`).
- `sdb` CLI on `PATH` — **the installer does NOT add this by default**.
  Append `C:\tizen-studio\tools\` to `PATH` so `sdb` resolves directly. One-line PowerShell:
  ```powershell
  [Environment]::SetEnvironmentVariable("Path", "$([Environment]::GetEnvironmentVariable('Path','User'));C:\tizen-studio\tools", "User")
  ```
  Close + reopen the terminal afterwards.
- A signed TV certificate profile in **Tizen Studio → Certificate Manager**.
  Same profile used to sign any other `.wgt` you've put on this TV.
- TV in **Developer Mode** with the host IP set, and reachable via `sdb connect`.
- TV target name (e.g. `QN82Q60RAFXZA`) — `sdb devices` will list it.

If `tizen install` fails with `Can not transfer ... package` and `sdb devices` is not on PATH, that means `sdb`'s connection state is bad — but you also can't diagnose it without the binary. Add it to PATH first.

### Build + install — one copy-paste block

Replace `<tv-target>` with your TV name (`sdb devices` will list it, e.g. `QN82Q60RAFXZA`):

```powershell
git clone https://github.com/RumbleCrumbleRS/JellyPlug-Tizen.git
cd JellyPlug-Tizen\packages\shell-tizen-bootstrap\src
if (Test-Path JellyfinShell.wgt) { Remove-Item JellyfinShell.wgt }
tizen package -t wgt -- .
tizen install -n JellyfinShell.wgt -t <tv-target>
```

Run all five lines from start to finish — **do not `cd` back to the repo root between package and install**. The output WGT is `JellyfinShell.wgt` (~580 KB) and lives in the same `src\` dir, so the install command must run from there too.

**The `Remove-Item JellyfinShell.wgt` line matters on rebuilds.** `tizen package -t wgt -- .` packages every file in the CWD, so any prior build's `JellyfinShell.wgt` left sitting in `src\` will get bundled inside the new WGT. The TV signature verifier then fails at `installing[17]` and aborts the install. Delete the stale file before each repackage.

If you're **upgrading an already-installed bootstrap** and the install still aborts at `installing[17]` even after the clean repackage, the on-device upgrade check is rejecting the new author signature. Uninstall first, then install fresh:

```powershell
tizen uninstall -p JelShellTV.Jellyfin -t <tv-target>
tizen install -n JellyfinShell.wgt -t <tv-target>
```

Filename is literally `JellyfinShell.wgt` — one word, capital `J` and `S`, no space, no period before `Shell`. If you type `Jellyfin.wgt` you'll get `There is no package with named Jellyfin.wgt.`

### Alternative — Device Manager GUI

```powershell
git clone https://github.com/RumbleCrumbleRS/JellyPlug-Tizen.git
cd JellyPlug-Tizen\packages\shell-tizen-bootstrap\src
tizen package -t wgt -- .
```

Then **Tizen Studio → Device Manager → right-click TV → Install Application → pick `JellyfinShell.wgt`** from `packages\shell-tizen-bootstrap\src\`.

### Alternative — skip build, use prebuilt unsigned WGT

```
release-artifacts\bootstrap\v2.0.0\JellyfinShellBootstrap_v2.0.0.wgt
```

Sign it via **Tizen Studio → Certificate Manager → right-click profile → re-sign WGT**, then `tizen install -n <signed-path> -t <tv-target>`.

### Expected install output

The TV may report `Failed to install Tizen application.` from the CLI while
the app icon **still appears on the launcher**. That's a known spurious
CLI-tool failure — `pkgcmd` actually registers the app on-device, only the
CLI's post-install handshake returns non-zero. Check the launcher.

### Verify it's the right WGT

After install, the platform log line should look like:

```
app_id[JelShellTV.Jellyfin] install start
```

The package prefix is **`JelShellTV`**, not `AprZAARz4r` (the legacy
thin-shell prefix). If you see `AprZAARz4r`, you installed the legacy WGT,
not the bootstrap — repackage from `packages\shell-tizen-bootstrap\src`.

### First launch

Open **JellyfinShell** on the TV. You should see one of:

- A connect form (if no `serverUrl` is set in `localStorage`).
- The Jellyfin web client (if the server has a populated `${server}/shell/`
  drop folder — see below).
- The baked last-known-good v80 shell (if `${server}/shell/` is missing or
  the manifest fetch fails).

Bootloader exposes two debug globals on the page: `window.__hsbShellUrl` (the
URL it loaded) and `window.__hsbFallback` (`true` if it fell back to baked
boot-shell). Useful if you have DevTools access.

---

## Updating the shell — no `sdb` after the bootstrap is installed

Once the bootstrap is on the TV, every shell change is just a file swap on
your Jellyfin server. Drop the new `shell.min.js` + refreshed `manifest.json`
into the server's `/shell/` directory and relaunch the TV app.

### Server-side `/shell/` layout

```
${server-webroot}/shell/
├── shell.min.js          # current shell bundle
├── babel.min.js          # (optional) preload babel polyfill for legacy Tizen
├── manifest.json         # sha256s + version metadata (built by emit_manifest.py)
└── boot-shell-x.y.z.wgt  # (optional) advertised bootstrap for fresh-pull installs
```

Hosting notes (nginx, Kestrel) and the manifest schema are in
[`packages/server-shell-drop/README.md`](./packages/server-shell-drop/README.md).

Rebuild `manifest.json` after every shell drop:

```bash
python3 packages/server-shell-drop/scripts/emit_manifest.py /path/to/server/shell
```

### Build a new `shell.min.js`

The shell that runs inside the bootstrap is `packages/shell-tizen/src/shell.js`.
Edit, rebuild, drop it into `${server}/shell/`, relaunch the TV app:

```bash
pnpm install
pnpm --filter @jellyfin-tv/shell-tizen build
# build output appears in packages/shell-tizen/dist/
cp packages/shell-tizen/dist/shell.min.js /path/to/server/shell/
python3 packages/server-shell-drop/scripts/emit_manifest.py /path/to/server/shell
```

No `sdb`, no Device Manager, no signing involved in this loop. That's the
whole point of HSB.

---

## Repo layout

```
packages/
  shell-core/                # shared TS: connect screen, NativeShell types,
                             # key maps, server validation
  shell-tizen/               # Samsung Tizen shell.min.js source — what runs
                             # inside the bootstrap, swappable via ${server}/shell/
  shell-tizen-bootstrap/     # Hosted Shell Bootstrap WGT — installed once,
                             # fetches shell.min.js at launch
  server-shell-drop/         # Server-side ${server}/shell/ layout + manifest emitter
  shell-webos/               # LG webOS .ipk (scaffold)
  shell-android/             # Android TV .apk (scaffold)
tooling/
  eslint-config/             # shared eslint preset
  tsconfig-base/             # shared tsconfig
  ci/                        # shared GHA helpers
release-artifacts/
  bootstrap/v2.0.0/          # unsigned prebuilt bootstrap WGT
  v1.0.x/                    # historical shell-tizen WGTs (pre-HSB)
.github/workflows/
  ci.yml                     # lint + typecheck + per-platform build matrix
  release-tizen.yml          # tag tizen-v* -> signed .wgt
  release-webos.yml          # tag webos-v* -> .ipk
  release-android.yml        # tag android-v* -> signed .apk
```

## Local development

```bash
pnpm install
pnpm run lint
pnpm run typecheck
pnpm run build
```

Per-package:

```bash
pnpm --filter @jellyfin-tv/shell-tizen build
pnpm --filter @jellyfin-tv/shell-tizen-bootstrap build
pnpm --filter @jellyfin-tv/shell-tizen-bootstrap test
pnpm --filter @jellyfin-tv/server-shell-drop emit-manifest -- /path/to/server/shell
```

## Legacy thin-shell branch

The pre-monorepo legacy thin-shell code (the old root-level `Jellyfin.wgt`
build) is preserved at the tag `legacy-thin-shell-pre-jel2040`. Don't build
from there — it's superseded by the HSB workflow above. If you ever need to
reference it:

```bash
git show legacy-thin-shell-pre-jel2040:README.md
```

## License

GPL-2.0-only, matching the rest of the Jellyfin org.
