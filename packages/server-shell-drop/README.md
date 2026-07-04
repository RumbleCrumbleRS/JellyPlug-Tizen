# Hosted Shell Drop — JEL-2040

This directory is the canonical layout for the **server-side `/shell/` drop** used by
the Hosted Shell Bootstrap (HSB). After the bootstrap WGT is installed on a TV,
this directory is the **only** path used to roll shell updates onto the TV. No
`sdb`, no `pkgcmd`, no `intershell_support` — just static files served over
HTTPS.

## Layout

```
${server}/shell/
├── manifest.json       # version + sha256 of shell.min.js (TVs read this first)
├── shell.min.js        # full shell logic (rebuilt from packages/shell-tizen/src/shell.js)
├── babel.min.js        # @babel/standalone, lazy-loaded for legacy Tizen 5.0/5.5
├── tx-manifest.json    # (optional) pre-lowered transpile drop index (JEL-621)
├── tx/<hash>.js        # (optional) pre-lowered ES5 bodies, fnv1a(source)-keyed
└── (optional) JellyfinShellBootstrap_v<ver>.wgt
                        # advertised in manifest for Device Manager pull installs
```

## How TVs consume the drop

The bootstrap WGT's `index.html` runs this flow at every cold boot:

1. Read `localStorage['jellyfin.shell.serverUrl']`.
2. `GET ${server}/shell/manifest.json` with a 1.5 s timeout.
   - On 2xx + valid JSON → cache `version` + `sha256` in localStorage,
     then `<script src="${manifest.shellUrl||shell.min.js}?v=${sha256}">`.
   - On error/timeout → `<script src="shell.min.js?t=${now}">` (cache-bust).
3. If the chosen `<script>` errors out, fall back to the WGT-baked
   `boot-shell.min.js` so the TV is **never stranded**.

That means an update is just:

```
# 1. rebuild shell.min.js from the shell-tizen package (run from repo root)
python3 packages/shell-tizen/scripts/build_shell_min.py

# 2. drop into the server /shell/ host
cp packages/shell-tizen/src/shell.min.js   /var/www/jellyfin/shell/shell.min.js
cp packages/shell-tizen/src/babel.min.js   /var/www/jellyfin/shell/babel.min.js
python3 packages/server-shell-drop/scripts/emit_manifest.py /var/www/jellyfin/shell/

# 3. TVs pick it up on next launch (or window.location.reload from QA console).
```

No TV-side install required. `intershell_support` can be `disabled` for years.

## Pre-lowered transpile drop (JEL-621)

THE dominant cold-boot cost on Tizen 5.0 is Babel: the shell serially
transforms ~1.9 MB of plugin JS on the TV main thread (21-42 s measured).
`scripts/build-tx-drop.mjs` runs the exact same transform offline — it loads
the repo's vendored `babel.min.js` with the byte-identical option literal
from the shells — and publishes:

```
${server}/shell/tx/<fnv1a-of-source>.js   pre-lowered ES5 body per input
${server}/shell/tx-manifest.json          { format, babelOptsKey, entries }
```

At boot the shells fetch `tx-manifest.json` in parallel with the `/web/`
RTT; every transpile slow path hashes its fetched source and, on a manifest
hit, downloads the pre-lowered body instead of loading Babel. Content
addressing keeps it correct across plugin config changes: new content, new
hash, manifest miss, on-device Babel fallback. On-device gates: manifest
`babelOptsKey` must match the shell's `BABEL_OPTS_KEY`, and every body must
pass the strict fully-lowered oracle before it is inlined. Kill switch:
`localStorage["jellyfin.shell.txDropDisabled"]="1"`.

Regenerate whenever plugins / snippet-channel config change (the tool names
no plugin — point it at what your server serves):

```
node scripts/build-tx-drop.mjs /var/www/jellyfin/shell \
  --url "https://server/<your-snippet-channel>/public.js" \
  --web-index https://server \
  --url-list tv-plugin-urls.txt        # e.g. the TV's recorded
                                       # jellyfin.shell.pluginUrls list
```

A stale drop is safe (hash miss → on-device transpile), just slow: every
miss regresses that boot to the measured 21–42 s on-TV Babel class.

### Automated regeneration (JEL-653)

Do not run the builder by hand on a live host — schedule
`scripts/regen-tx-drop.sh`, the unattended entrypoint that wraps the
builder with single-flight locking, `--merge` semantics, atomic manifest
publish (write + rename, so a TV fetching mid-regen never reads a torn
manifest), optional pruning, and optional tooling self-update:

```
# crontab on the machine hosting /shell/ (every 15 min):
MAILTO=ops@example.com
*/15 * * * * TX_DROP_GIT_SYNC=1 TX_DROP_PRUNE_DAYS=14 \
  /opt/JellyPlug-Tizen/packages/server-shell-drop/scripts/regen-tx-drop.sh \
  /var/www/jellyfin/shell https://server
```

- **Server content change** (jellyfin-web update, plugin config edit, JSI
  snippet edit): the next tick re-fetches `--web-index` plus the snippet
  channel (`TX_DROP_JSI_PATH`, default `/JavaScriptInjector/public.js` —
  the shell's `jsiChannelPath()` default) and publishes fresh entries
  under the new source hashes. Staleness is bounded by the cron interval.
- **Release cut (JEL-213)**: a shell release can change `BABEL_OPTS_KEY`,
  the lockstep regexes, or the vendored `babel.min.js`, which stales the
  whole drop at once (opts-key mismatch → the TV ignores the manifest).
  `TX_DROP_GIT_SYNC=1` fast-forwards the repo checkout before each run, so
  a release is picked up within one interval with no extra human step; the
  release runbook may additionally trigger one immediate run.
- **Alerting**: a failed run exits non-zero (cron `MAILTO` / systemd
  `OnFailure` is the operator-side alert). The TV-side signal is the QA
  beacon: `probe.txDrop` in the beacon payload echoes the
  `window.__shellTxDrop {h,m,r,f}` counters and sets `stale: 1` for the
  sustained-miss signature (manifest loaded, zero hits, ≥5
  miss/reject/fetch-fail events in a boot) — the fingerprint of a drop
  the automation stopped refreshing.
- `TX_DROP_PRUNE_DAYS=N` bounds drop-dir growth: the builder rewrites
  every still-served body each run (mtime refreshes), so only entries
  whose source stopped being served keep aging and get reaped.

## manifest.json schema

```json
{
  "version": "1.2.3", // shell semver (from shell.min.js header)
  "sha256": "<sha256 of shell.min.js>", // cache-buster + integrity
  "shellUrl": null, // optional override, defaults to "shell.min.js"
  "babelSha256": "<sha256 of babel>", // optional, lets shell warm-cache key
  "minBootstrapVersion": "2.0.0", // refuse to drive bootstraps older than this
  "bootstrapWgt": {
    // optional, advertised to Device Manager
    "filename": "JellyfinShellBootstrap_v2.0.0.wgt",
    "sha256": "..."
  }
}
```

## Hosting

Any static file host works. Jellyfin server already ships nginx/kestrel-class
serving for `/web/`; reuse the same vhost:

### nginx snippet

```
location /shell/ {
    alias /var/jellyfin/shell/;
    add_header Cache-Control "public, max-age=60, must-revalidate";
    types {
        application/json manifest.json;
        application/javascript js;
    }
}
```

### Kestrel (Jellyfin's built-in) snippet

Drop the files in `<DataDir>/shell/` and add a static-file mapping in
`network.xml` `BaseUrl` extension; documented separately in the
Jellyfin-side companion ticket (server-plugin path).

## Bootstrap WGT pulls

When a new TV joins the fleet, the bootstrap WGT v(N) install path is documented
in `../shell-tizen-bootstrap/INSTALL.md` — Samsung Device Manager GUI is the
primary path (no `sdb shell`).
