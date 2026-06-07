# tv-inspect

Remote inspection of a Tizen TV web app via the Chrome DevTools Protocol (CDP).

Designed so the founding-engineer agent can drive AC3 verification of the
Hosted Shell Bootstrap (HSB) without a human standing in front of the TV:

- Launches the app in debug mode (`tizen run --debug`).
- Reads the inspector port `tizen` auto-forwards from the TV to localhost.
- Connects to CDP, captures a PNG screenshot of the live WebView.
- Evaluates `window.__hsbShellUrl`, `window.__hsbFallback`, `location.href`,
  body text, etc.
- Optionally uploads the screenshot + globals JSON to a Paperclip issue as
  attachments.

## One-time setup (on the board's Windows PC)

```powershell
pip install -r requirements.txt
```

Prereqs already covered in the repo root README:

- Tizen Studio installed.
- `tizen` and `sdb` on PATH (or at the canonical
  `C:\tizen-studio\tools\ide\bin\` and `C:\tizen-studio\tools\` — the script
  also tries those automatically).
- TV connected via `sdb connect <ip>:26101`.
- `JelShellTV.Jellyfin` already installed (see repo Quick Start).

## Run

The simplest invocation (writes to `./out/` only):

```powershell
python tv-inspect.py --target QN82Q60RAFXZA
```

With auto-upload to a Paperclip issue (set the env vars first, or run inside
a Paperclip heartbeat where they are auto-injected):

```powershell
$env:PAPERCLIP_API_URL = "http://127.0.0.1:3100"
$env:PAPERCLIP_API_KEY = "<run-jwt>"
$env:PAPERCLIP_COMPANY_ID = "1ad395da-8d25-4295-8b6b-b0e5ca0a5eb6"
python tv-inspect.py --target QN82Q60RAFXZA `
  --issue-id 4fbaf3bf-ed81-4a6d-8ad3-3b5c308dfe36
```

Or if the inspector is already up (you launched via Tizen Studio Device
Manager → Web App Inspector) skip the launch step:

```powershell
python tv-inspect.py --target QN82Q60RAFXZA --skip-launch --port 38231
```

## Output

In `./out/`:

- `tv-screenshot-<ts>.png` — PNG capture of the WebView at probe time.
- `tv-globals-<ts>.json` — JSON dict of probed JS globals.

When `--issue-id` is passed and PAPERCLIP\_\* env is present, both files are
uploaded as attachments on the issue.

## Exit codes

- `0` — ok
- `2` — usage / missing CLI
- `3` — `tizen run --debug` failed (TV not connected, shell channel blocked,
  app not installed, signing mismatch, etc.)
- `4` — CDP port never came up after the launch parse
- `5` — CDP evaluate / screenshot failed
- `6` — Paperclip attachment upload failed

## Why this exists

The Q60 lives on `intershell_support:disabled` (see [JEL-2040](../../README.md)
and the `tv_sdbd_intershell` doc). That breaks interactive `sdb shell` but does
**not** break `tizen install` or `tizen run --debug` — both go through the
WAS daemon, not the shell channel.

So we can still launch the app in debug mode and reach the CDP port. The TV
becomes scriptable from the founding-engineer agent's heartbeat with no human
in front of the screen.

## Caveat: signed vs unsigned WGT

`tizen run --debug` only works on a WGT signed with a _development_ profile.
A WGT signed with a _distributor_ profile launches but refuses to expose the
inspector. If you signed the v2.0.0 bootstrap with the same profile used for
v80 builds (which were developer-signed for sideload), you're fine.

If the inspector port never comes up, re-sign with the development profile:

```powershell
tizen security-profiles list
tizen package -t wgt -s <dev-profile-name> -- .
tizen install -n JellyfinShell.wgt -t <target>
```

then re-run `tv-inspect.py`.
