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
├── shell.min.js        # full shell logic (rebuilt from _jel*_v80_src/shell.js)
├── babel.min.js        # @babel/standalone, lazy-loaded for legacy Tizen 5.0/5.5
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
# 1. rebuild shell.min.js from the v80 src as usual
python3 _jel1963_v80_src/build_shell_min.py

# 2. drop into the server /shell/ host
cp _jel1963_v80_src/shell.min.js   /var/www/jellyfin/shell/shell.min.js
cp _jel1963_v80_src/babel.min.js   /var/www/jellyfin/shell/babel.min.js
python3 emit_manifest.py /var/www/jellyfin/shell/

# 3. TVs pick it up on next launch (or window.location.reload from QA console).
```

No TV-side install required. `intershell_support` can be `disabled` for years.

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
in `../_jel2040_bootstrap_src/INSTALL.md` — Samsung Device Manager GUI is the
primary path (no `sdb shell`).
