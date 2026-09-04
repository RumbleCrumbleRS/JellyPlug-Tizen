# The bootstrap release channel

**The bootstrap `.wgt` is the only vehicle in this project that is not
auto-updatable.** Everything else the TV runs — `shell.min.js`, `lite.min.js`,
`babel.min.js`, the webfonts, the transpile drop — is served by the server
plugin and refreshes itself. The `.wgt` does not. It changes only when a human
signs a new one and sideloads it onto a specific TV.

This page is the answer to "my bootstrap change merged, CI went green, the
ticket closed — is it on a TV?" Written for JELA-880.

## Why there is no over-the-air path

`ShellDropService.cs` advertises `bootstrapWgt: null`, and both
`/shell/index.html` and `/shell/boot-shell.min.js` return **404** on live prod.
No component in the fleet ever fetches a `.wgt`. There is no auto-update, no
staged rollout, and no kill switch. A bootstrap change reaches a TV by hand or
not at all.

## Where releases are cut — and why not here

`RumbleCrumbleRS/JellyPlug-Tizen` (this repo) is **source-only**. It holds no
`TIZEN_*` signing secrets, and `bootstrap-sign.yml` / `release-tizen.yml` both
open with a policy gate (JEL-173) that fails the run immediately when the
author cert is absent. That is deliberate: without the certs the job would emit
an _unsigned_ `.wgt`, and a retail Tizen TV refuses to install one. Failing loud
beats shipping an uninstallable package.

Releases are cut from **`RumbleCrumbleRS/JellyPlug-Tizen-internal`** (private),
which holds all four secrets — `TIZEN_AUTHOR_P12_BASE64`,
`TIZEN_AUTHOR_PASSWORD`, `TIZEN_DISTRIBUTOR_P12_BASE64`,
`TIZEN_DISTRIBUTOR_PASSWORD` — per JEL-162 Decision 2 ("bless-internal"). See
`RELEASE.md` for the full signing policy.

> A `bootstrap-sign` **failure** in this repo is not a broken signer. It is the
> policy gate redirecting you. Check `-internal` before diagnosing anything:
> `gh run list -R RumbleCrumbleRS/JellyPlug-Tizen-internal --workflow bootstrap-sign.yml`

## The failure mode this channel actually has

Not signing — **syncing**. `-internal` is a full-tree mirror of public `main`,
advanced by a single `chore: sync internal main to public <sha>` commit whose
tree is byte-identical to the public commit's tree. Nothing does this
automatically.

It stalled at public `c8b7fb0` (2026-07-13, `bootstrap-v2.0.25`) for 53 days.
During that window three bootstrap-payload commits merged to public `main` and
could not be built, because the only repo that can build them had never seen
them:

| commit    | date       | ticket                                             |
| --------- | ---------- | -------------------------------------------------- |
| `255aa34` | 2026-07-28 | JELA-226 — `webPrefetchSkip` read site             |
| `f12cc66` | 2026-09-01 | JELA-841 — babel pinned to its absolute widget URL |
| `92eddee` | 2026-09-01 | JELA-857 — arm the babel prime on first paint      |

JELA-853 then approved a fleet flag flip whose read site is `255aa34`. It would
have written a dead key to every TV. Nothing in CI said so.

## What is in the payload

`build_bootstrap.py` packages exactly five files from
`packages/shell-tizen-bootstrap/src/`:

| file                | stranded if not shipped?                                                                |
| ------------------- | --------------------------------------------------------------------------------------- |
| `config.xml`        | **yes** — WGT-only                                                                      |
| `index.html`        | **yes** — WGT-only                                                                      |
| `icon.png`          | **yes** — WGT-only                                                                      |
| `boot-shell.min.js` | no — baked _fallback_; the live path is the LS byte cache or the server (JELA-66)       |
| `babel.min.js`      | no — baked _fallback_; the live path is `<script src>` at the `/shell/` drop (JELA-848) |

`tooling/ci/check-bootstrap-version-bump.sh` splits on exactly this line: it
**fails** a PR that changes a WGT-only file without bumping
`<widget version>`, and **warns** when a baked fallback changes. The warn tier
exists because the baked files are regenerated on most shell commits — a
blocking gate there would fire dozens of times a quarter and get switched off.

Bumping the version matters because the widget version is the _only_ thing a TV
can report about which bootstrap it is running. `255aa34` changed behaviour
under an already-released `2.0.25`, so two different builds claim `2.0.25` and
no telemetry can separate them.

## Shipping a bootstrap release

1. Bump `<widget version>` in
   `packages/shell-tizen-bootstrap/src/config.xml`; merge to public `main`.
2. Sync `-internal` to that commit. Pin the public SHA — `origin/main` moves
   under you:

   ```bash
   git clone https://github.com/RumbleCrumbleRS/JellyPlug-Tizen-internal.git
   cd JellyPlug-Tizen-internal
   git remote add public https://github.com/RumbleCrumbleRS/JellyPlug-Tizen.git
   git fetch public <public-sha>
   git read-tree -u --reset FETCH_HEAD
   git commit -m "chore(JELA-nnn): sync internal main to public <public-sha> (bootstrap vX.Y.Z)"
   ```

   Verify before pushing — the trees must match exactly:

   ```bash
   git rev-parse HEAD^{tree}                    # internal
   git -C ../JellyPlug-Tizen rev-parse <public-sha>^{tree}
   ```

3. Push `main`, then push the tag. `bootstrap-v*` triggers `bootstrap-sign.yml`,
   which signs both variants and publishes a GitHub Release on `-internal`:

   ```bash
   git push origin main
   git tag -a bootstrap-vX.Y.Z -m "..." && git push origin bootstrap-vX.Y.Z
   ```

   A `workflow_dispatch` run signs and uploads the artifact but publishes no
   Release — use it to prove green before committing to a tag.

4. The release carries two artifacts. `JellyPlug.wgt` is retail (diagnostic
   overlays off); `JellyPlug-Debug.wgt` forces both on-screen overlays on for
   every boot, for troubleshooting only.

## Installing on a TV

Hand sideload only, proven in JELA-21:

```bash
sdb connect <tv-ip>:26101
sdb push JellyPlug.wgt /home/owner/share/tmp/
sdb shell 0 vd_appinstall JelShellTV /home/owner/share/tmp/JellyPlug.wgt
```

`sdb` dies between calls on the Q60R — reconnect per command, and sweep for the
port rather than hardcoding it. See the Q60R QA notes.

Because this is per-TV and manual, **a signed release is not a shipped
release.** Confirm arrival, don't assume it: JELA-879 reports the installed
bootstrap version in the diag ring, which is what tells you a build actually
landed and how much of the fleet is behind.

## Release history

Releases live on `-internal`, tagged `bootstrap-v*` and titled `JellyPlug-v*`.
`bootstrap-v2.0.16` through `bootstrap-v2.0.25` (2026-06-18 … 2026-07-13), then
`bootstrap-v2.0.26` (2026-09-04, JELA-880) carrying the three commits above.

The newest bootstrap known _installed_ anywhere is **2.0.20** (Q60R, hand-signed,
JELA-21, 2026-07-07) — five releases behind what is built and signed. That gap
is the manual-sideload cost, not a pipeline defect.
