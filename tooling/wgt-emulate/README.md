# wgt-emulate — how to emulate and test our WGT

> JEL-3. Four tiers for exercising the Tizen WGT, fastest → highest-fidelity.
> Pick the lowest tier that can catch the class of bug you're chasing.

The WGT we ship is the **Hosted Shell Bootstrap (HSB)** — a near-immutable
580 KB widget whose `index.html` runs a small bootloader that fetches the real
`shell.min.js` from `${server}/shell/` at launch, with a baked
`boot-shell.min.js` fallback. See the repo root `README.md` for the full HSB
story.

The key fact that makes most testing easy: **the bootstrap itself uses no Tizen
native APIs.** It is plain web — `localStorage`, `XMLHttpRequest`, the DOM. Only
the _hosted_ shell that loads afterwards touches `window.tizen` / `webapis`.
That means the whole HSB flow runs in an ordinary desktop browser, and most
regressions never need a TV at all.

| Tier | Tool                             | Needs                | Catches                                                       | Speed   |
| ---- | -------------------------------- | -------------------- | ------------------------------------------------------------- | ------- |
| 1    | `selftest.cjs` (existing)        | Node                 | bootloader branch logic                                       | instant |
| 2    | **`wgt-emulate` (this dir)**     | Python 3 + a browser | full HSB flow, connect form, manifest/shell/fallback, visuals | seconds |
| 3    | Tizen TV Emulator                | Tizen Studio         | Tizen runtime, remote keys, real WebView quirks               | minutes |
| 4    | Real TV via `sdb` + `tv-inspect` | TV in dev mode       | true on-device behaviour                                      | minutes |

---

## Tier 1 — bootloader logic unit test (already in repo)

Pure headless assertion of the four bootloader branches (no-server / manifest-ok
/ script-error-fallback / manifest-neterr). Runs in a Node `vm` sandbox.

```bash
node packages/shell-tizen-bootstrap/scripts/selftest.cjs
# or: pnpm --filter @jellyfin-tv/shell-tizen-bootstrap test
```

Use this as the fast guard in CI and after editing `index.html`'s bootloader.

---

## Tier 2 — browser emulation (this tool)

Runs the actual WGT payload (`index.html` + bootloader) in a desktop Chromium
and **also stands in for the Jellyfin `${server}/shell/` drop folder**, so the
real boot flow — connect form → `manifest.json` fetch → hosted `shell.min.js`
load → baked fallback — happens end to end against one local server.

### Run

```bash
cd tooling/wgt-emulate
python3 serve.py                 # serves bootstrap src/ + a mock /shell/
```

Then:

1. Open `http://localhost:8088/` in desktop Chrome/Chromium.
2. Type `http://localhost:8088` into the connect form and press **Connect**.
3. The page reloads, the bootloader fetches `/shell/manifest.json`, loads
   `/shell/shell.min.js`, and you see the green **EMULATED SHELL LOADED**
   screen plus the on-screen `HSB … / shell-loaded` diagnostic overlay.

> Chromium is the right browser: on-device Tizen is a Chromium WebView, so the
> desktop Chromium engine matches far better than Firefox/Safari. For old-TV
> fidelity you can launch Chrome with an old UA, but engine quirks only the
> emulator/TV reproduce belong in Tier 3/4.

To reset between runs, clear the site's `localStorage` (DevTools → Application →
Local Storage) or open an Incognito window.

### Exercise the fallback branches visually

```bash
python3 serve.py --fail-manifest   # manifest 503 -> bootloader uses shell.min.js?t=
python3 serve.py --fail-shell      # shell 503    -> baked boot-shell.min.js fallback renders
```

### Test a REAL built shell instead of the stub

```bash
pnpm --filter @jellyfin-tv/shell-tizen build
python3 serve.py --real-shell ../../packages/shell-tizen/dist/shell.min.js
```

The harness injects `tizen-stub.js` (a shim for `window.tizen` / `webapis` /
`NativeShell`) ahead of the bootloader so a real shell gets far enough to
render in the browser. The stub is a surface shim, **not** an emulator —
playback (`avplay`), `productinfo`, and real remote-key delivery are no-ops.
For that, use Tier 3. Pass `--no-tizen-stub` to serve the WGT untouched.

### Point the harness at a different WGT payload

```bash
python3 serve.py --root ../../packages/shell-tizen-bootstrap/src   # default
```

### Headless self-check (CI-friendly, no browser)

Starts the server, asserts the WGT index, injected stub, and a
`manifest.json` whose `sha256` matches the served `shell.min.js`, then exits
0/1:

```bash
python3 serve.py --self-test
# or: pnpm --filter @jellyfin-tv/wgt-emulate test
```

### Headless end-to-end check (DOM engine, no GUI browser)

`--self-test` only asserts the **HTTP endpoint shape** — it never runs the
bootloader. `e2e.cjs` closes that gap: it drives the **actual HSB boot flow**
(`index.html` bootloader) inside a DOM engine (jsdom) against a live `serve.py`,
so localStorage, the connect form, the manifest XHR, the hosted-shell `<script>`
load, and both fallback branches all execute for real — headless, CI-friendly,
no GUI browser.

jsdom is intentionally **not** a committed dependency (Tier 2's default is
"Python 3 + a browser"); this deeper check is opt-in and self-skips (exit 0) if
jsdom isn't installed:

```bash
cd tooling/wgt-emulate
npm install jsdom        # one-time, local (not committed to the workspace)
node e2e.cjs             # or: npm run test:e2e
# point at an existing copy instead: JSDOM_PATH=/path/to/jsdom node e2e.cjs
```

It validates four scenarios end to end and exits 0/1:

| Scenario        | Asserts                                                              |
| --------------- | ------------------------------------------------------------------- |
| connect-form    | no serverUrl → form renders; submit trims `/`, saves, reloads       |
| happy-path      | manifest 200 → hosted shell (`?v=<sha>`) → EMULATED SHELL LOADED     |
| `--fail-manifest` | manifest 503 → shell still loads via `?t=` cache-buster            |
| `--fail-shell`  | shell 503 → `<script>` onerror → baked `boot-shell.min.js` fallback  |

### Flags

| Flag                | Effect                                                       |
| ------------------- | ------------------------------------------------------------ |
| `--port N`          | listen port (default 8088)                                   |
| `--root DIR`        | WGT payload dir to serve (default: bootstrap `src/`)         |
| `--real-shell PATH` | serve a real `shell.min.js` instead of the stub              |
| `--shell-version S` | version string reported in `manifest.json`                   |
| `--shell-url URL`   | explicit `shellUrl` in the manifest (default null → derived) |
| `--fail-manifest`   | serve `manifest.json` as 503                                 |
| `--fail-shell`      | serve `shell.min.js` as 503                                  |
| `--no-tizen-stub`   | don't inject the Tizen API shim                              |
| `--self-test`       | headless assert, exit 0/1                                    |

### What Tier 2 does NOT cover

- The real Tizen WebView engine version (on-device Chromium can be old; that's
  why the repo carries Chromium-56 polyfills and a babel preload).
- Real remote-key codes / focus model, productinfo, app lifecycle, `avplay`.
- WGT **packaging/signing** correctness (the `installing[17]` signature class of
  failures). That's a packaging step, not a runtime one — see Tier 3/4.

---

## Tier 3 — Tizen TV Emulator (closest to a TV, no hardware)

The Tizen Studio TV emulator is a QEMU-based Samsung TV image. It runs the real
Tizen runtime and WebView, so it catches native-API and engine issues Tier 2
can't, and it accepts a `.wgt` exactly like a TV (including signature checks).

**One-time setup**

1. Install **Tizen Studio** + the **TV extension** (Package Manager → "Extension
   SDK" → Samsung TV / Smart Hub tools).
2. Open **Tizen Studio → Tools → Emulator Manager → Create** → choose a **TV**
   platform image (e.g. `tv-samsung-7.0` / `tv-6.5`) → finish.

**Each run**

```bash
# 1. Launch the emulator instance (or use the Emulator Manager "Launch" button)
emulator-manager     # GUI; or: tizen emulator launch -n <emulator-name>

# 2. It auto-registers with sdb as an emulator target:
sdb devices          # e.g. emulator-26101  device  <name>

# 3. Package + install + run, same CLI as a real TV:
cd packages/shell-tizen-bootstrap/src
rm -f JellyfinShell.wgt          # avoid bundling a stale wgt -> installing[17]
tizen package -t wgt -- .
tizen install -n JellyfinShell.wgt -t <emulator-name>
tizen run -p JelShellTV.Jellyfin -t <emulator-name>
```

**Debug the WebView on the emulator** (the emulator, unlike the locked-down Q60,
generally allows debug-launch):

```bash
tizen run --debug -p JelShellTV.Jellyfin -t <emulator-name>
# tizen prints an inspector port forwarded to localhost; open it in Chrome:
#   chrome://inspect  ->  the forwarded port, or http://localhost:<port>
```

Notes / gotchas:

- The emulator needs HW virtualization (Intel HAXM / KVM / Hyper-V). If launch
  hangs, that's almost always the accelerator.
- Same **signing** requirement as a TV: configure a certificate profile in
  **Certificate Manager** before `tizen package`. A Samsung _partner/distributor_
  cert is only needed for store/specific privileges; an author profile is enough
  to install on the emulator.
- The same `rm -f JellyfinShell.wgt` rule from the root README applies — a stale
  `.wgt` left in the package dir gets re-bundled and fails signature verify.

This is the tier to reach for when Tier 2 looks fine but the TV doesn't:
native-API breakage, old-Chromium engine quirks, packaging/signing failures.

> **Testing OLD TVs (Tizen 5.0 / 5.5 — 2019 / 2020 panels):** the Package
> Manager only offers the latest image (~Chromium M85+), which does not
> reproduce the M63 / M69 WebView those models run. To pin the emulator to an
> old engine, see [`LEGACY-EMULATOR.md`](./LEGACY-EMULATOR.md) (JEL-5) — which
> archived TV Extension carries each platform, how to side-load a legacy image,
> and the Chrome-63 / HW-virtualization gotchas.

---

## Tier 4 — real TV (`sdb` + `tv-inspect`)

Highest fidelity. Install over `sdb connect <ip>:26101` exactly as the root
README documents, then drive AC verification remotely with
[`tooling/tv-inspect`](../tv-inspect/README.md) — it launches the app in debug
mode, captures a WebView screenshot over CDP, and reads `window.__hsbShellUrl` /
`window.__hsbFallback` / `window.__hsbState`. Some retail panels (e.g. the Q60)
disable debug-launch, in which case the on-screen HSB diagnostic overlay baked
into `index.html` is the read-out instead.

---

## Recommended loop

1. Edit bootloader / `index.html` → **Tier 1** (`selftest.cjs`) for logic,
   **Tier 2** (`wgt-emulate`) for the live flow + visuals.
2. Edit / build a hosted `shell.min.js` → **Tier 2** with `--real-shell`.
3. Changed packaging, native APIs, or chasing a TV-only bug → **Tier 3**
   (emulator), then **Tier 4** (real TV) to confirm.
