# JELA-821 — `deferJe` armed one boot late: flip the read site to opt-OUT

**Date:** 2026-08-31 · **Parent:** JELA-773 (`deferJe` fleet flip) · **Found
by:** JELA-819 full Tizen 5.0 perf census · **Status: merged dark (`64e0bca`);
rig acceptance PASSED (both ACs). Fleet deploy pending CEO approval.**

## 1. The defect

`stripJeScriptsForDefer` (`packages/shell-tizen/src/shell.js`) read its gate
opt-in and fail-closed:

```js
if (localStorage.getItem("jellyfin.shell.deferJe") !== "1") return html;
```

The key is seeded by the jp773 JSI channel entry, and the JSI channel only runs
**after** the lite→SPA handoff (JELA-802). This read site runs on the boot
_before_ that. So the flag arms one boot late, and every boot that starts with
the key absent — a fresh install, a re-install, any localStorage eviction —
read `null !== "1"`, skipped the defer, and paid the whole JellyfinEnhanced
module storm on the critical path.

The gate worked perfectly everywhere it was ever measured, because every
measurement after the flip was a warm boot.

### Measured differential (2 independent lineages)

| boot                  | `deferJe` in LS at nav | `__shellJeDefer` diag       | JS modules PRE-paint |
| --------------------- | ---------------------- | --------------------------- | -------------------- |
| JELA-813 `BC-b1` COLD | absent                 | `null`                      | **152 / 152**        |
| JELA-819 `A-b1` COLD  | absent                 | `null`                      | **152 / 152**        |
| JELA-813 `BC-b2` WARM | present                | `{on:1,held:1,rel:1,inj:1}` | **0 / 152**          |

Stable at exactly 152 modules in 9/9 valid boots across both rigs. On a cold
boot `/JellyfinEnhanced/` costs 165 pre-paint requests / 711,406 B, of which
the module storm is 152 requests / 670,857 B — 36% of the boot's 425 real
requests, all of it ahead of first paint, contending for M63's 6-connection
budget. Boot latency tracks request COUNT, not bytes.

## 2. The fix

Read for the kill switch instead of the enable:

```js
if (localStorage.getItem("jellyfin.shell.deferJe") === "0") return html;
```

Mirrored byte-identically into
`packages/shell-tizen-bootstrap/src/boot-shell.src.js`; both `.min` blobs
regenerated (JEL-624 cross-shell parity passes: 110 shared functions).

This changes behaviour **only** on boots where the key is absent — exactly the
broken case. The fleet is already seeded `"1"` by jp773, and an explicit `"0"`
still opts a device out.

A **throwing** localStorage now defers as well (it previously passed through).
Unreadable storage is the same "the fleet default should apply" case, and this
matches the shape `stripDeadMediaBarJs` already uses for its kill switch two
functions down.

### Why the `flagDefaults` route does not work

The obvious alternative — add `jellyfin.shell.deferJe` to the `flagDefaults`
whitelist in `liteAdoptDefaults()` — does **not** fix this. `flagDefaults` is
itself cached one boot behind (`LITE_DEFAULTS_KEY` is stale-one-boot by
contract), so on a true first boot that map is absent too. It would repair
post-eviction boots and leave fresh installs broken.

## 3. Consequences for anyone testing this flag

**A key-absent arm is no longer an OFF arm.** The JELA-811 harness asserted
`deferJe === null` before navigating and never wrote the key in any arm; under
the old read site that made boot 1 an implicit OFF arm. After this change a
key-absent boot is an **ON** arm. Any OFF arm must now seed `"0"` explicitly
pre-nav.

**A rollback must be a SETTER, not a remover.** Removing the jp773 channel
entry no longer turns the lever off — it leaves the shell default ON. To
disable fleet-wide, seed `"0"`.

**The jp773 channel entry stays as-is.** Its guard is already
`if (getItem(k) !== "0") setItem(k, "1")`, so it never clobbers a device's kill
switch and remains a correct no-op after this ships.

**Audit the gate by the READ EXPRESSION, not the key.** `grep -c deferJe` on
the served shell returns 2; only one is the flag, the other is the unrelated
`deferJeMs` tunable. JELA-773 and JELA-811 both hit this trap. The new contract
test pins the exact expression `getItem("jellyfin.shell.deferJe")==="0"` in
both src and min, and separately asserts no `!=="1"` read site survives.

## 4. Test coverage

`packages/shell-tizen/scripts/je-defer.test.cjs` (and its bootstrap twin) lift
the **real** `stripJeScriptsForDefer` out of source into `node:vm`:

| pin    | assertion                                                             |
| ------ | --------------------------------------------------------------------- |
| PART A | src + min both carry the `==="0"` read site; neither carries `!=="1"` |
| B0     | key **absent** → JE tags stripped, `__shellJeDefer.on=1 held=2`       |
| B0b    | key `"0"` → html byte-identical, **no** diag object installed         |
| B0c    | key `""` → still defers (only `"0"` disables)                         |
| B0d    | `deferJeMs="0"` does not disable the gate (key-confusion pin)         |
| B3     | throwing localStorage → still defers                                  |

Run against the pre-fix source, 10 of these fail; against the fix, all pass.
The remaining B1/B2/B4 strip pins and the PART C re-injector pins are unchanged
and still pass.

Both package suites pass (`npm test` in `shell-tizen` and
`shell-tizen-bootstrap`), including `cross-shell-parity`. `shell.min.js` is
245,379 B against the JELA-812 cap of 272 KiB (33,149 B headroom).

## 5. Acceptance — BOTH ACs PASS

Two-boot differential, **one boot each on its own fresh profile**, on the
JELA-112 virtual Tizen 5.0 rig (pinned Chromium 63 / V8 6.3, Tizen-5.0 UA,
real WGT bootstrap → shell → real `/web/` → **live** JSI channel). The two arms
differ by **exactly one pre-nav localStorage key** and run the **same** shell
build.

|                                     | **AC1 — arm ON** (key absent, the fixed case) | **AC2 — arm OFF** (kill switch) |
| ----------------------------------- | --------------------------------------------- | ------------------------------- |
| `deferJe` at nav                    | `null`                                        | `"0"`                           |
| `window.__shellJeDefer`             | `{on:1, held:1, rel:1, inj:1}`                | **absent**                      |
| **JE modules PRE-paint**            | **0 / 152**                                   | **152 / 152**                   |
| JE modules POST-paint               | 152                                           | 0                               |
| all `/JellyfinEnhanced/*` pre-paint | **0 reqs / 0 B**                              | **180 reqs / 1,117,005 B**      |
| JE module window, from nav          | +13,423 .. +14,695 ms                         | +2,289 .. +3,948 ms             |
| firstCard                           | 10,084 ms                                     | 14,035 ms                       |
| shell sha ran                       | `b358bd10…`                                   | `b358bd10…` (identical)         |
| prod `/shell/` fetches              | 0                                             | 0                               |
| total requests / cards / sections   | 469 / 130 / 11                                | 459 / 98 / 10                   |
| validity gates                      | all pass                                      | all pass                        |

The module window is the clincher and needs no statistics: with the key absent
the 152 modules land **entirely after** first paint (+13.4 s vs a 10.1 s
firstCard); with `"0"` seeded they land **entirely before** it (+2.3 s vs a
14.0 s firstCard). Binary, on the same build.

**The arm is proven by the diag object, never by a request** (JELA-811).
`__shellJeDefer` exists only when the gate let the strip run, so its
presence/absence is the arm independent of what the network did.

**COUNT claim only.** `firstCard` is 10,084 ms ON vs 14,035 ms OFF and total
requests 469 vs 459 — both **recorded, neither claimed**. The box was
load-saturated (loadavg 10.6→13.0 and 12.1→16.7 across the two arms) and n=1
per arm. The endpoint here is a count, which survives a dirty pre-flight gate
(JELA-805).

### How the unpublished shell was served

The fix is merged dark, so it is not on prod `/shell/` yet. The rig repoints
HSB at a **local** `/shell/` (`jela681-hss-render-rig`): pre-seed
`hsbCachedHash` = the patched build's sha and `hsbCachedShellUrl` = the local
URL, so HSB takes its warm path and loads `<url>?v=<sha>` directly; seed
`hsbShellLsDisabled=1` so the LS body cache always misses and the bytes come
off our wire every boot — which is what makes the sha in the request URL a real
provenance claim. Everything else (`/web/`, the API, the live JSI channel)
stays prod.

Provenance was gated three ways, and the driver refuses to start if any fails:
the served file must contain the `==="0"` read site exactly once and no
`!=="1"` site (audited by **expression**, not by key); the boot must fetch our
URL with a 200 at the expected sha; and it must fetch prod `/shell/`
**zero** times. Both arms: `prov=true`, `prodShellFetched=0`.

Two further guards, because a capture that looks perfect is the real risk here
(JELA-813): the run aborts if `deferJe` is non-null on a supposedly fresh
profile, and a capture with **0** JE modules in total is marked VOID — the
lever moves 152 modules past paint, it does not delete them. Both arms saw all 152.

Rig + captures: `/tmp/jela821-rig-2ac264c1/out/{ON,OFF}-b1-boot.json`, driver
`run821.mjs` (out of git per JEL-141; adapted from the JELA-819 census driver).

## 6. Value

Already measured by the flip that shipped the lever: −3,340 ms at firstCard on
the JELA-690-calibrated ring (JELA-699 ring A, p=0.0024), −2,110 ms on the
JELA-773 rollout ring. That is what a first-install boot is currently leaving
on the floor.
