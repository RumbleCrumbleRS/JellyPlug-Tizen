# JELA-773 — fleet flip of `jellyfin.shell.deferJe`

Rollout half of **JELA-707** (implementation merged flag-dark in PR #199, squash
`76cff39a`). The shell defers JellyfinEnhanced's `<script>` tags out of the
pre-paint critical path and re-injects them after first card.

| flag                     | kill switch (per-TV)  | delay override             |
| ------------------------ | --------------------- | -------------------------- |
| `jellyfin.shell.deferJe` | same key set to `"0"` | `jellyfin.shell.deferJeMs` |

## AC1 — real-app confirmation ring (n=8)

Preflight-gated, quiet box, paired flag-flip on the real app. Three arms per
cycle with rotated order (`R0` control, `RJE` deferred, `RCAL` calibration).

- **firstCard −2,110 ms median**, 95 % CI `[−2,534, −303]`, p = 0.0078.
- **0 pre-paint JE requests** in all 8 `RJE` boots (`jePre=0`); control boots
  carry `jePre=201–202`.
- **JE functional after paint** in all 8: full `jeReqs=182` fan-out and
  `jeTags=153` — one _more_ tag than the control's 152, so nothing is dropped.
- Effect clears the JELA-699 real-app floor (±698 ms at n=8) by ~3×.

The **calibration arm did not obey its window**, and the cause is understood:
control boots vary 2–3 s, so a 1-second probe cannot resolve in that noise. It
does not bear on the primary endpoint, which is ~3× the arm-to-arm spread.

## AC2 — fleet default-ON deployed

Deployed via the JSI channel as entry `JellyPlug — deferJe default-ON
(JELA-773)`, appended under the `jsi-config-write-race` +
`jsi-config-save-off-by-one` discipline (fresh base fetched immediately before
the POST, structural gate, double-POST, deep-equal re-GET, served-bundle
byte-verify). Config went **104 → 105 entries**; both POSTs returned `204`;
re-GET was deep-equal to the patched shape (no concurrent clobber).

Served `/JavaScriptInjector/public.js` at a cache-busted `?v=`: **907,155 B**,
`jp773seed` ×1, `node:vm` parses.

### The gate is genuinely on prod

The JELA-807 trap is a seeder shipped against a shell that cannot read the key.
Grepping the **served** artifact — not the tree:

| served `${server}/shell/shell.min.js` |                                            |
| ------------------------------------- | ------------------------------------------ |
| sha1                                  | `1feebdcd74f2ecf29f9640125cf19c28a62daa36` |
| size                                  | 243,199 B                                  |
| `jellyfin.shell.deferJe` (boolean)    | 1                                          |
| `jellyfin.shell.deferJeMs` (delay)    | 1                                          |

`JellyPlug Shell` plugin reports **1.0.41.0**. The reader is:

```js
function stripJeScriptsForDefer(html){
  try{ if(localStorage.getItem("jellyfin.shell.deferJe")!=="1") return html }
  catch(_){ return html }
  ...
}
```

Note the gate is `!=="1"` — it fails **closed**, so only the exact string `"1"`
arms it. Counting `deferJe` occurrences alone would have been misleading here:
of the two hits, one is the unrelated `deferJeMs` delay key. Audit gates by
**key**, never by substring count (JELA-770).

### Polarity proven against the served bytes

The served entry was extracted from the live `public.js` and run in `node:vm`
against a mock `localStorage` — the JELA-806 rule of proving polarity by running
the **served** seeder, not the source:

| pre-existing value | post  | meaning                         |
| ------------------ | ----- | ------------------------------- |
| absent             | `"1"` | fleet default arms              |
| `"0"`              | `"0"` | per-TV kill switch is respected |
| `"1"`              | `"1"` | idempotent                      |

The shell reads the key **before** the channel executes, so each TV arms on its
**next** boot, not the boot that seeds it.

## A stale fail-closed gate, and why it was safe to repoint

`flip773.mjs` refused its first dry-run: sibling marker `genreIdCache` missing
from the base config. That is **not** corruption — **JELA-805 retired the jp682
idcache entry on 8-29**, after this script was written. Confirmed before writing
anything: `genreIdCache` / `jp682` / `idcache` all count 0, while `genreBulk`
and `deferscan` are intact and the entry count matches the post-jp807 state. The
gate was repointed at four currently-live seeders (`genreBulk`, `deferscan`,
`searchGate`, `udcGate`).

Lesson: a fail-closed sibling gate is an asset, but it **decays** as siblings
retire. Read a gate's failure as a question, not an answer.

## Rollback

`node flip773.mjs --rollback --execute` swaps the entry's `Script` for a
**remover**, which clears the key only where it is `"1"` and leaves explicit
per-TV `"0"` kill switches alone. Merely deleting the entry would strand every
TV latched ON — a delete is not a rollback for a seeded flag (JELA-789).

`flip773.mjs` lives in the agent workspace, which is **not durable**, so both
payloads are reproduced here. Deploy either by editing the `Script` of the
`JellyPlug — deferJe default-ON (JELA-773)` entry in the JSI plugin config,
POSTing **twice**, then byte-verifying the served `public.js`.

```js
// seeder — currently live (marker: jp773seed)
(function () {
  try {
    var k = "jellyfin.shell.deferJe";
    if (localStorage.getItem(k) !== "0") {
      localStorage.setItem(k, "1");
    }
  } catch (e) {}
})();

// remover — rollback payload (marker: jp773rollback)
(function () {
  try {
    var k = "jellyfin.shell.deferJe";
    if (localStorage.getItem(k) === "1") {
      localStorage.removeItem(k);
    }
  } catch (e) {}
})();
```

Only after the remover has settled fleet-wide may the entry itself be deleted.

## Not yet proven here

A served bundle does not prove a seeder end-to-end (JELA-790). The two-boot arm
proof — fresh profile, boot once to seed, boot again to observe the shell arm —
is tracked as a follow-up, mirroring JELA-807 → JELA-809.
