# JellyPlug Shell — Jellyfin server plugin (JELA-15)

Installable Jellyfin plugin that serves the **Hosted Shell Bootstrap drop**
(`/shell/`) so no server admin ever needs SSH + filesystem + cron to keep
JellyPlug TVs fast. A fresh Jellyfin admin makes every JellyPlug TV fast with
two dashboard clicks: add the plugin repository, install the plugin.

## What it serves

Root-level routes (same URLs every fielded bootstrap WGT already polls —
precedent for root-level plugin routes on 10.11: JellyfinEnhanced,
PluginPages):

| Route                     | Body                                                             |
| ------------------------- | ---------------------------------------------------------------- |
| `/shell/manifest.json`    | version + sha256 of the embedded shell (emit_manifest.py schema) |
| `/shell/shell.min.js`     | the repo-built shell, embedded at plugin build                   |
| `/shell/babel.min.js`     | the vendored slim chrome56 Babel, for legacy TVs                 |
| `/shell/tx-manifest.json` | pre-lowered transpile drop index (JEL-621)                       |
| `/shell/tx/<hash>.js`     | pre-lowered ES5 bodies, fnv1a(source)-keyed                      |

All anonymous, like `/web/` statics — the TV fetches them before any login.

## In-process tx-drop rebuild

The scheduled task **"Rebuild JellyPlug tx-drop"** (startup + every 6 h)
replaces the JEL-653 `regen-tx-drop.sh` cron with zero server-side setup. It
collects the exact source set `build-tx-drop.mjs` would — every non-bundle
`<script src>` on the served `/web/index.html`, the snippet channel
(`JsiChannelPath`, default `/JavaScriptInjector/public.js`), plus configured
`ExtraSourceUrls` — and pre-lowers them in-process:

- Transform engine: [Jint](https://github.com/sebastienros/jint) running the
  **official `@babel/standalone` UMD pinned to the exact version the vendored
  slim build was cut from** (7.29.7 — see the shell-tizen `babel.min.js`
  header). The slim chrome56 esbuild bundle itself needs native generators
  and stalls under Jint; the UMD build is ES5-compiled and runs. Correctness
  does not depend on byte-identical output: the device gates are the
  lockstep `babelOptsKey` + the strict fully-lowered oracle, both enforced
  here at publish time too (a failing source is skipped → hash miss → the TV
  transpiles on-device: safe, just slow).
- Same `fnv1a` content addressing as the shells (`scripts/lockstep.test.cjs`
  guards all lockstep constants against `build-tx-drop.mjs`).
- `--merge` semantics + atomic manifest publish (write + rename), so a TV
  fetching mid-rebuild never reads a torn manifest and a partially-failing
  run never un-publishes valid entries.
- Drop lives in `<DataDir>/jellyplug-shell/` — survives plugin updates.

## Build + package

```sh
dotnet build packages/server-plugin/Jellyfin.Plugin.JellyPlugShell -c Release
packages/server-plugin/scripts/package-plugin.sh   # → dist/jellyplug-shell_<ver>.zip + repo manifest entry
```

The build embeds `../shell-tizen/src/shell.min.js` + `babel.min.js` (single
source of truth — rebuild those first for a shell release) and downloads the
pinned `@babel/standalone` (sha256-verified, never committed).

## Distribution

`plugin-repo/manifest.json` at the repo root is the plugin-repository
manifest any admin can add under **Dashboard → Plugins → Repositories**:

```
https://raw.githubusercontent.com/RumbleCrumbleRS/JellyPlug-Tizen/main/plugin-repo/manifest.json
```

Release flow: `package-plugin.sh` → create GitHub release
`server-plugin-v<ver>` with the zip asset → splice
`dist/manifest-version-entry.json` into `plugin-repo/manifest.json` → merge.

**CI release (no local dotnet needed, JELA-26):** bump `<Version>` in the
`.csproj`, then run the **release-server-plugin** workflow from the Actions tab
(`workflow_dispatch`, `confirm_version` must match the `.csproj` version). It
runs the exact recipe above on an ubuntu runner and pushes the manifest bump to
`main`, so a subscribed server autoUpdates. Dispatch-only; re-running a
published version is a no-op.

**Ship / verify / roll back:** the full reversible runbook — forward path,
rollback (before _and_ after a server auto-updates), and the automated
post-publish sha-match propagation probe (`tooling/ci/verify-shell-deploy.sh`) —
lives in [`docs/deploy-runbook.md`](../../docs/deploy-runbook.md) (JELA-31).
