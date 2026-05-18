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

- Tizen Studio installed (Tizen CLI on `PATH`).
- A signed TV certificate profile in **Tizen Studio → Certificate Manager**.
  Same profile used to sign any other `.wgt` you've put on this TV.
- TV in **Developer Mode** with the host IP set, and reachable via `sdb connect`.
- TV target name (e.g. `QN82Q60RAFXZA`) — `sdb devices` will list it.

### Build the bootstrap WGT

```powershell
git clone https://github.com/RumbleCrumbleRS/JellyPlug-Tizen.git
cd JellyPlug-Tizen
cd packages\shell-tizen-bootstrap\src
tizen package -t wgt -- .
```

That produces `JellyfinShell.wgt` (~580 KB) in the same directory, signed with
your default certificate profile.

Don't want to build? An unsigned prebuilt WGT lives in the repo at:

```
release-artifacts\bootstrap\v2.0.0\JellyfinShellBootstrap_v2.0.0.wgt
```

You still need to sign it before installing (Tizen Studio → Certificate
Manager → right-click profile → re-sign WGT), but you skip the package step.

### Install on the TV

```powershell
sdb connect <tv-ip>:26101
sdb devices                                           # confirm TV is listed
tizen install -n JellyfinShell.wgt -t <tv-target>     # e.g. -t QN82Q60RAFXZA
```

Or use the GUI: **Tizen Studio → Device Manager → right-click TV →
Install Application → pick the WGT**.

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
