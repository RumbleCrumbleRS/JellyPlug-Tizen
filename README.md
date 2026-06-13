# Jellyfin for Tizen (JellyPlug)

A thin browser-shell app for running Jellyfin on Samsung Smart TVs. The shell
loads the **live** Jellyfin web client from `${server}/web/`, so every plugin
installed on your server works 1:1 on the TV — same code, same plugins.

The Tizen build uses a **Hosted Shell Bootstrap (HSB)**: a small (~580 KB) WGT
is installed on the TV once, and from then on it fetches `shell.min.js` from
your Jellyfin server at launch. Updating the shell after that is just a
server-side file swap — no re-signing or re-installing the WGT per release.

> Detailed guides (emulator setup, on-device debugging, server hosting) live in
> the per-package READMEs under [`packages/`](./packages) and
> [`tooling/`](./tooling).

## Prerequisites

- Tizen Studio 4.6+ with IDE or CLI. See [Installing TV SDK](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html).
- `tizen` and `sdb` CLIs on your `PATH`. The installer adds `tizen` but **not**
  `sdb` — append `C:\tizen-studio\tools\` to `PATH` so `sdb` resolves.
- Git
- Node.js 20+ and [pnpm](https://pnpm.io/)

## Getting Started

1. Install the prerequisites above.
2. Install Certificate Manager using the Tizen Studio Package Manager.
3. Set up a Tizen TV certificate in Certificate Manager (the same profile you
   use to sign any other `.wgt` for this TV).
4. Clone this repository.

   ```sh
   git clone https://github.com/RumbleCrumbleRS/JellyPlug-Tizen.git
   cd JellyPlug-Tizen
   ```

## Build the WGT

The bootstrap WGT is built from `packages/shell-tizen-bootstrap/src`:

```sh
cd packages/shell-tizen-bootstrap/src
tizen package -t wgt -- .
```

This produces `JellyfinShell.wgt` (~580 KB) in the same `src/` directory.

> **On rebuilds, delete the previous WGT first.** `tizen package` bundles every
> file in the directory, so a stale `JellyfinShell.wgt` left in `src/` gets
> packaged inside the new one and the TV rejects the signature. Remove it before
> repackaging:
>
> ```sh
> rm -f JellyfinShell.wgt && tizen package -t wgt -- .
> ```

## Deployment

### Deploy to Emulator

```sh
tizen install -n JellyfinShell.wgt -t T-samsung-5.5-x86
```

### Deploy to TV

1. Turn on the TV.
2. Activate Developer Mode on the TV and set the host IP.
3. Connect to the TV (replace with your TV's IP):

   ```sh
   sdb connect YOUR_TV_IP
   ```

4. If you are using a Samsung certificate, allow installs onto your TV:

   ```sh
   tizen install-permit -t <tv-target>
   ```

5. Install the package (`sdb devices` lists the target name, e.g. `QN82Q60RAFXZA`):

   ```sh
   tizen install -n JellyfinShell.wgt -t <tv-target>
   ```

> **Upgrading an existing install?** If the install aborts even after a clean
> repackage, uninstall first, then install fresh:
>
> ```sh
> tizen uninstall -p JelShellTV.Jellyfin -t <tv-target>
> tizen install -n JellyfinShell.wgt -t <tv-target>
> ```

> The CLI may print `Failed to install Tizen application.` while the app icon
> **still appears on the launcher**. This is a known spurious CLI failure —
> `pkgcmd` registers the app on-device; only the CLI's post-install handshake
> returns non-zero. Check the launcher.

### First launch

Open **JellyfinShell** on the TV. You should see either a connect form (if no
server is configured), or the Jellyfin web client served from your server.

## Updating the shell

Once the bootstrap is installed, every shell change is just a file swap on your
Jellyfin server — no `sdb`, no re-signing. Build a new `shell.min.js`, drop it
into the server's `/shell/` directory with a refreshed manifest, and relaunch
the TV app:

```sh
pnpm install
pnpm --filter @jellyfin-tv/shell-tizen build
cp packages/shell-tizen/dist/shell.min.js /path/to/server/shell/
python3 packages/server-shell-drop/scripts/emit_manifest.py /path/to/server/shell
```

Server hosting notes and the manifest schema are in
[`packages/server-shell-drop/README.md`](./packages/server-shell-drop/README.md).

## Development

```sh
pnpm install
pnpm run format:check
pnpm run test
pnpm run build
```

You do **not** need a TV to exercise the bootstrap logic — it is plain web:

```sh
# Bootloader logic, headless, instant
node packages/shell-tizen-bootstrap/scripts/selftest.cjs
```

### Repo layout

```
packages/
  shell-tizen/               Samsung shell.min.js source (swappable via server)
  shell-tizen-bootstrap/     Hosted Shell Bootstrap WGT (installed once)
  server-shell-drop/         server-side /shell/ layout + manifest emitter
tooling/
  ci/                        CI helpers (wgt signing checks, cert setup)
```

## Legacy thin-shell

The pre-monorepo legacy thin-shell code is preserved at the tag
`legacy-thin-shell-pre-jel2040`. Don't build from it — it's superseded by the
HSB workflow above.

## License

GPL-2.0-only, matching the rest of the Jellyfin org.
</content>
</invoke>
