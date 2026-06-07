# Bootstrap install procedure — JEL-2040 HSB

This is the **once-per-TV** install of the Hosted Shell Bootstrap WGT. After this
lands on a TV, every subsequent shell update is a server-side file swap; no TV
reinstall, no `sdb shell`.

## Getting a signed WGT from CI (recommended) — JEL-10

The `.github/workflows/bootstrap-sign.yml` workflow produces the signed
`.wgt` so you don't need a Tizen signing profile on your own host:

1. Ensure the 4 Tizen signing secrets are set on the repo (JEL-9, Option 1):
   `TIZEN_AUTHOR_P12_BASE64`, `TIZEN_AUTHOR_PASSWORD`,
   `TIZEN_DISTRIBUTOR_P12_BASE64`, `TIZEN_DISTRIBUTOR_PASSWORD`.
2. Run it one of two ways:
   - **On demand:** Actions tab → **bootstrap-sign** → _Run workflow_. The
     signed `.wgt` (+ `manifest.bootstrap.json`) is attached to the run as the
     `jellyfin-shell-bootstrap-<sha>` artifact.
   - **Tagged release:** push a `bootstrap-v*` tag (e.g. `git tag bootstrap-v2.0.1
&& git push origin bootstrap-v2.0.1`). The same signed `.wgt` is published
     as a GitHub Release for the tag.
3. The workflow runs inside the Tizen Studio CLI image and chains the three
   scripts from commit `4370dec`:
   - `tooling/ci/configure-tizen-signing.sh` builds the `jellyfin` security
     profile from the 4 secrets.
   - `build_bootstrap.py --sign-profile jellyfin --out dist/` signs the package.
   - `tooling/ci/verify-wgt-signed.sh dist/*.wgt` fails the run if the output
     is missing `author-signature.xml` / `signature1.xml`, so an unsigned
     package can never be published.

Download the artifact (or release asset) and skip to step 2 of the Device
Manager flow below. To build the signed `.wgt` locally instead, follow step 1.

## Primary path — Samsung Device Manager GUI (B1)

**Works while `intershell_support:disabled`** because Device Manager talks to
the TV over Samsung's WS API (`ws://<tv>:8001/api/v2/applications`), not the
sdbd `shell:` channel.

### Steps

1. Pre-flight on the Windows host:
   - Tizen Studio with the TV Extension installed.
   - The TV in Dev Mode, Host PC IP authorized, IP visible in Smart Hub Dev menu.
   - Build a **signed** bootstrap WGT (requires a Tizen signing profile on the
     host — same TV profile as v80 builds):
     `python3 packages/shell-tizen-bootstrap/scripts/build_bootstrap.py --sign-profile <profile>`.
     Output: `packages/shell-tizen-bootstrap/dist/JellyfinShellBootstrap_v<ver>.wgt`.
     Running the script **without** `--sign-profile` produces a raw, UNSIGNED
     zip that a TV will refuse to install — that mode is for the wgt-emulate
     Tier-2 harness only (JEL-8).
   - Confirm the package is signed before installing:
     `tooling/ci/verify-wgt-signed.sh packages/shell-tizen-bootstrap/dist/JellyfinShellBootstrap_v<ver>.wgt`
     (must print `OK ... signed (author + distributor)`; it checks for
     `author-signature.xml` + `signature1.xml`). In CI the release pipeline
     configures the profile via `tooling/ci/configure-tizen-signing.sh` and
     runs this same guard before publishing.
2. Launch **Tizen Studio → Device Manager** (or `tizen-studio/tools/device-manager/bin/device-manager.exe`).
3. Confirm TV row shows the right IP and `Connected` state.
   - If listed as `Disconnected`, click **Remote Device Manager** in the
     toolbar and re-add via IP. `intershell_support:disabled` does **not**
     block this — connection only needs the sync/forward channels.
4. Right-click the TV row → **Install Application**.
5. Browse to `JellyfinShellBootstrap_v<ver>.wgt`. Click OK.
6. Watch the bottom log pane. A clean install ends with:
   ```
   ... Successfully installed JelShellTV.Jellyfin
   ```
   No `pkgcmd ... over sdb shell ... closed` errors should appear because
   Device Manager dispatches install over a different service channel.

### Verification

Launch the app on the TV (remote → Apps → JellyfinShell).

Expected (server reachable):

- HUD/log eventually reports `__hsbShellUrl=https://<server>/shell/shell.min.js?v=<sha>`.
- App renders the Jellyfin web client identically to today's v80 build.

Expected (server unreachable):

- `[hsb] falling back to baked shell: timeout`.
- App renders via WGT-baked `boot-shell.min.js` (same code as v80, just with
  no /shell/ pull). TV is **never stranded**.

Snapshot `window.__hsbShellUrl` (set when the hosted shell loads) or
`window.__hsbFallback` (set on fallback) into the QA beacon to confirm the
chosen path each boot.

## Fallback B2 — `sdb install` direct (investigation)

If Device Manager refuses for a particular firmware:

```
sdb -s 192.168.0.10:26101 install C:/path/JellyfinShellBootstrap_v<ver>.wgt
```

This uses sdbd's `install:` service which **may** be independent of
`intershell_support`. Outcome on consumer Tizen 5.0 = unknown until tested.
Probe this during the next confirmed `intershell_support:disabled` window
and capture the verbatim output in the JEL-2040E investigation comment.

## Fallback B3 — USB sideload

1. Copy the signed `.wgt` onto a FAT32 USB stick (root or `/apps/`).
2. Insert into TV. Smart Hub → Apps → Settings → Install from USB.
   - Availability depends on firmware. On Q60/Tizen 5.0, this menu exists in
     Dev Mode on most builds.
3. Confirm the prompt to install `JelShellTV`.

Use only when B1 and B2 both fail. Documented as a true last resort because
it requires physical access to the TV.

## What if `intershell_support:disabled` blocks B1 too?

That would be a much rarer firmware regression. If observed:

- Capture the Device Manager log pane (it surfaces the failed channel).
- File a follow-up under JEL-2040 referencing the channel name.
- Use B2 or B3 to land the bootstrap WGT.

For the post-install update path, **none of B1/B2/B3 is needed** — TVs pull
shell updates from `${server}/shell/` directly. The post-bootstrap state is
the durable win.
