# JELA-718 — panel warm-boot check: are `/web/*` bundles served from cache?

Acceptance #3 of JELA-714. Batched to the next Q60R panel session: the heartbeat
container cannot reach the TV (`No route to host` to `192.168.86.202:26101`,
docker-bridged vs LAN) and this **cannot** be faked on the JELA-112 rig, which keeps
no persistent HTTP cache across process restarts (measured in JELA-689: forcing
`--disk-cache-dir` wrote 0 files).

Budget ~15 minutes of panel time. The capture driver
(`jela718-web-cache-capture.mjs`, Node 24, no deps) is attached to the JELA-718
issue thread rather than committed — an on-device QA harness under `tooling/` is
exactly what the JEL-141 guard (`tooling/ci/check-no-debug-evidence.sh`) rejects,
and the JELA-112 harness follows the same convention. Download it into a local
workspace before the session.

## Read this before you interpret anything

Measured 2026-08-25 against the pinned Chromium 63.0.3239.0 rig (engine-class
identical to the Q60R webview). Two plausible instruments are both wrong:

| Signal                                     | On M63                                                                                            | Verdict                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `performance.getEntriesByType('resource')` | emits an entry for cache hits too; `transferSize`/`encodedBodySize` are 0 from a `file://` origin | unusable for both the request and the bytes question |
| `Network.requestServedFromCache`           | **never fires** — 0 events across a memory-cache hit _and_ a true network fetch                   | unusable                                             |
| `Network.responseReceived.fromDiskCache`   | `true` on a cache hit, `false` on a network fetch                                                 | **use this**                                         |

Concretely, what M63 reports for the same URL:

```
cache hit -> responseReceived status=200 fromDiskCache=true   encodedDataLength=0
network   -> responseReceived status=200 fromDiskCache=false  encodedDataLength>0
```

**This corrects the acceptance criterion as originally written.** JELA-718 says "a
plain `200` with a full body is a fail" — but a cache hit _is_ a plain 200, at the JS
layer (`fetch(...).status === 200`) and at the CDP layer. Judging on status alone
reports a false FAIL on a perfectly good result. The discriminator is
`fromDiskCache`. (M63 folds its memory cache into that flag; on this engine it means
"served by some HTTP cache rather than the network", which is exactly the question.)

## Procedure

```bash
export PANEL_IP=192.168.86.202 SDB=/path/to/sdb        # sdb 4.2.36, see tizen-cdp-boot-harness
cd <local workspace holding the driver from the JELA-718 thread>

# Pass 1 — prime. First boot after the 1.2.0.0 install; the TV has not yet stored
# any response carrying the new headers, so everything is expected to hit network.
node jela718-web-cache-capture.mjs --label prime --out prime.json

# Pass 2 — the measurement.
node jela718-web-cache-capture.mjs --label warm --out warm.json

node jela718-web-cache-capture.mjs --compare prime.json warm.json
```

The script closes the app, relaunches it under `shell 0 debug`, attaches CDP, and
only then drives the Lite→SPA handoff with a synthetic Back keydown (`keyCode` 10009) — so the whole bundle load happens inside the capture window and nothing
races the attach. Add `--no-handoff` if the panel is already sitting in the SPA.

**Pass:** every hashed bundle either makes no network request (`fromDiskCache: true`)
or comes back `304`. **Fail:** any bundle re-downloaded in full. Baseline to beat is
1,496 KiB across 81 `/web/*` files (JELA-706).

## If cards fail to render on the warm boot

Suspect the M63 CORS cache-mode collision first: M63 does not partition its HTTP
cache by request mode, so a no-cors `<script>` entry can be served to a later CORS
`fetch()` of the same URL and fail ACAO even though the header is correct in `curl`.
`Vary: Origin` ships as the mitigation and this is its first fielding on `/web/*`.

The capture records the `Origin` **request** header per bundle and prints the
distinct set. `Vary: Origin` can only partition the two load paths if they actually
differ in that header — **if the script reports a single distinct Origin value, the
mitigation is not engaged** and the collision is live. That is the diagnostic;
capture `originValues` from the JSON either way.

Rollback (verified 2026-08-25: 1.1.1.0 is retained in the dist manifest, downloads
at 8,234 bytes, md5 `c11f908f78afd5921ed1e015587abe78` matching the manifest):

```
POST /Packages/Installed/JellyPlug%20Cache%20Headers?assemblyGuid=c1d2e3f4a5b647c89d0e1f2a3b4c5d60&version=1.1.1.0
POST /System/Restart
```

## Server side is already verified — do not re-litigate it on the panel

Re-confirmed against live prod 2026-08-25 (plugin 1.2.0.0 Active, build hash
`4c3e5ec610f9c71cad1c`), 7/7 cases:

| Case                               | Result                                                                |
| ---------------------------------- | --------------------------------------------------------------------- |
| current-hash bundle, no Origin     | `public, max-age=604800, immutable` + `Vary: Accept-Encoding, Origin` |
| current-hash bundle, with Origin   | same + `access-control-allow-origin: *`                               |
| stale hash                         | degrades to `public, max-age=0, must-revalidate`                      |
| bare url, no query                 | falls through to core `no-cache` (never immutable)                    |
| conditional GET, our ETag          | `304` carrying full cache-control + vary                              |
| conditional GET, our ETag + Origin | `304` still carries ACAO                                              |
| conditional GET, core's ETag       | full `200` (the empty-buffer trap does not fire)                      |

Raw captures go to the Paperclip issue, not git — `tooling/tv-validate/EVIDENCE-POLICY.md`.
