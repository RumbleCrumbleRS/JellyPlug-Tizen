# Bootstrap install procedure — JEL-2040 HSB

This is the **once-per-TV** install of the Hosted Shell Bootstrap WGT. After this
lands on a TV, every subsequent shell update is a server-side file swap; no TV
reinstall, no `sdb shell`.

## Primary path — Samsung Device Manager GUI (B1)

**Works while `intershell_support:disabled`** because Device Manager talks to
the TV over Samsung's WS API (`ws://<tv>:8001/api/v2/applications`), not the
sdbd `shell:` channel.

### Steps

1. Pre-flight on the Windows host:
   - Tizen Studio with the TV Extension installed.
   - The TV in Dev Mode, Host PC IP authorized, IP visible in Smart Hub Dev menu.
   - Build the bootstrap WGT: `python3 _jel2040_bootstrap_src/build_bootstrap.py`.
     Output: `JellyfinShellBootstrap_v<ver>.wgt` at the tree root.
   - Sign the WGT (Tizen Studio Certificate Manager → use the same TV profile
     as v80 builds). Confirm `author-signature.xml` and `signature1.xml` are
     embedded.
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

Launch the app on the TV (remote → Apps → Jellyfin Shell).

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
