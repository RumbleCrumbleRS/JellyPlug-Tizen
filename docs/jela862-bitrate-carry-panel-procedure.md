# JELA-862 — panel procedure: does the bitrate cache actually carry across a boot?

`/Playback/BitrateTest` is 5.77 MB per boot — the single largest thing the TV
downloads. JELA-686/817 built a localStorage cache for it and JELA-823 deferred it
past settle. The **read** path is proven (seed a valid entry, boot, get
`hits:1` and zero ladder requests). The **wiring** is not: nobody has shown that
the value written at ~13 s into boot N is still in the store at the start of
boot N+1 on real hardware.

The JELA-112 virtual rig structurally cannot answer this. Probe keys planted
through the page's own `localStorage` at fixed times carry to the next boot when
written at 2,500 ms and are **lost** at 13,000 ms and 20,000 ms — the rig commits
localStorage only at renderer teardown, and `about:blank` + 1.2 s is not enough
slack for a late write (JELA-817, JELA-862). The bitrate value is written at
~13 s, so on that rig every lineage reads as a defect whether or not one exists.

Budget ~20 minutes of panel time.

## Read this before you run anything

### The lineage is THREE boots, not two

The fielded shell (`/shell/shell.min.js`, sha `d73fd58f…`) gates the cache module
on the flag being exactly `"1"`:

```js
if (localStorage.getItem("jellyfin.shell.bitrateCache") !== "1") return;
```

The JSI channel seeds that flag (`jp817seed`, verified live in the served
`public.js`), but the shell reads the key **before** the channel executes. So on a
panel that has not booted since the JELA-817 flip:

| boot | flag at read time | module   | result                      |
| ---- | ----------------- | -------- | --------------------------- |
| 1    | absent            | **dead** | pays 5.77 MB, saves nothing |
| 2    | `"1"`             | live     | pays 5.77 MB, **saves**     |
| 3    | `"1"`             | live     | should **hit**, 0 bytes     |

A two-boot run on such a panel reports a false FAIL. The driver runs three by
default and picks the proof pair as "first boot that saved" → "the boot after it".
If boot 1 already shows the flag as `"1"`, the 1→2 pair is the proof and boot 3 is
spare. (JELA-834 flips this gate to opt-OUT; it is merged and unpublished, so the
boot-1-dead step is still live in the field.)

### Two failure modes only hardware can produce

Both look identical to "the value did not carry" if you only read the hit counter,
so capture the underlying record either way:

- **id mismatch.** `rd()` requires `j.id === serverId() + "|" + serverAddress()`.
  A seeded-cache test computes both sides in the same page and can never catch a
  drift; a real panel that reconnects to a differently-spelled address (trailing
  slash, http vs https, IP vs hostname) will carry the value and still miss.
- **clock rollback.** `rd()` computes `g = Date.now() - j.t` and rejects `g < 0`.
  A TV that resyncs NTP across a power cycle can move its clock backwards and
  invalidate a perfectly good entry. The rig's clock never moves.

The driver reports the stored `id` next to the live one, and the age in ms
(negative age ⇒ clock rollback), so a miss is always diagnosable.

### `lsWriteBehind` is not in this path

JELA-862's suggested-work item 2 flags `jellyfin.shell.lsWriteBehind` as sitting
between `wr()` and the store. Read from the served bytes, it does not:

```js
holds = function (k, v) {
  return (
    v.length >= 4096 &&
    (k.lastIndexOf("shell.tx", 0) === 0 ||
      k === "jellyfin.shell.bundlePatchState")
  );
};
```

The bitrate record is ~103 chars and its key matches neither prefix, so
`proto.setItem` falls straight through to the real `setItem`. The served shell
also contains **no** `localStorage.clear()` and no `removeItem` that can reach
`jellyfin.shell.bitrate` (every `removeItem` site is `shell.tx*`, the tx LRU, the
web/branding group invalidations, the server URL, or the lite defaults). If the
carry fails on device, write-behind is not the suspect — capture
`window.__shellLsWB` anyway to keep the ruling-out on the record.

### Instrument choice

| signal                                      | on this engine                                                                       | verdict                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------- |
| `performance.getEntriesByType('resource')`  | `transferSize` 0 from a `file://` origin; CORS preflight is its own entry (JELA-684) | request list only, no bytes |
| `Network.loadingFinished.encodedDataLength` | real byte counts, `OPTIONS` and `GET` separable                                      | **use this for bytes**      |

Also call `performance.setResourceTimingBufferSize(4000)` on every poll tick —
Chrome 63 defaults to 150 entries and the `document.write` handoff resets it, so a
capture reporting exactly 150 entries is a buffer ceiling, not a request count.

Total bytes are counted **from CDP attach onward**, not from navigationStart: the
app is launched by `0 debug` and the attach necessarily lands a beat later. That is
fine for this ticket — the ladder fires at settle (t≈16 s), far inside the window —
but quote the number as "from attach" and never compare it to a rig total.

## Procedure

The capture driver (`jela862-bitrate-carry.mjs`, Node ≥ 22, zero deps) is attached
to the JELA-862 issue thread rather than committed: an on-device QA harness under
`tooling/` is exactly what the JEL-141 guard rejects, and JELA-718 follows the same
convention. Download it into a local workspace first.

```bash
# sdb 4.2.36 — not preinstalled, and /tmp is wiped between sessions
curl -O http://download.tizen.org/sdk/tizenstudio/official/binary/sdb_4.2.36_ubuntu-64.zip
python3 -m zipfile -e sdb_4.2.36_ubuntu-64.zip ./sdbpkg/
export SDB=$PWD/sdbpkg/data/tools/sdb && chmod +x "$SDB"

node jela862-bitrate-carry.mjs --selftest              # verifies the verdict logic, no panel
node jela862-bitrate-carry.mjs --boots 3 --out jela862-run.json
node jela862-bitrate-carry.mjs --report jela862-run.json
```

Never hardcode the panel address — the Q60R is on DHCP and has already moved once
(`.202` → `.249`). The driver sweeps the /24 for port 8001 and confirms identity
with `curl :8001/api/v2/` (`modelName: QN82Q60RAFXZA`); `--panel <ip>` overrides.
A host that answers `:8001` is on; an EHOSTUNREACH/timeout to a stale address looks
exactly like the old "container cannot route to the LAN" blocker but means "wrong
address, or the panel is powered off".

Per boot the driver closes the app over the Samsung REST API
(`DELETE /api/v2/applications/<appid>`) before `shell 0 debug` — `0 debug` hangs
portless if the app is already running (JELA-52), and that is not the JELA-36
transport wedge. It then forwards the ephemeral inspector port, attaches CDP, reads
localStorage **before** anything this boot could have written, drives the Lite→SPA
handoff with a synthetic Back keydown (`keyCode` 10009), and holds until the
deferral gate has fired plus 8 s of save slack.

An app close + relaunch is the boot boundary this measures. That is the boundary
the cache exists to survive and the one a user hits many times a day. If you also
want the harder case, wall-unplug the panel for ≥ 60 s between boot 2 and boot 3
(the remote's power button is instant-on standby, not a cold boot) and re-run
`--boots 1` for the third leg — that is the run that can surface the clock-rollback
mode above.

## What to report

Into the JELA-862 thread, from the boot **after** the boot that saved:

1. the full `window.__shellBitrate` object (`hits >= 1` is the load-bearing signal —
   "0 requests" alone is equally consistent with a truncated capture, JELA-817);
2. the `/Playback/BitrateTest` request list and its byte total, plus the boot's
   total bytes, so the claim is shown as bytes and not just a counter;
3. whether `jellyfin.shell.bitrate` was present in localStorage at the **start** of
   that boot, quoted raw — that is the datum the rig cannot produce.

Raw capture JSON goes to the issue thread, not into git
(`tooling/ci/check-no-debug-evidence.sh`, `check-no-personal-endpoints.sh`).

## If it passes

The carry is real, and publishing JELA-834 (opt-in → opt-OUT, merged, unpublished)
removes the boot-1 spend as well: the module becomes live on the very first boot of
a fresh install, so the ladder runs once instead of at least twice. JELA-862 then
reduces to a rollout item.

## If it fails

The value is written by `wr()` inside the `detectBitrate` prototype wrap:

```js
function wr(a, v) {
  try {
    if (!(v > 0)) return;
    localStorage.setItem(
      K,
      JSON.stringify({ bps: v, t: new Date().getTime(), id: idOf(a) }),
    );
    G.saves++;
  } catch (_) {}
}
```

`G.saves` incrementing proves `setItem` was reached and did not throw. If the value
is nonetheless gone at the next boot, the loss is below the JS layer and the fix is
not "write earlier" — it is to stop depending on a late write: persist at the
`visibilitychange`/`pagehide` boundary as well, or have the shell re-save the cached
value early in the next boot so the entry is refreshed by a boot-time write rather
than a settle-time one.
