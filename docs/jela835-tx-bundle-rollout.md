# JELA-835 — tx-bundle coalescer rollout: published, propagated, proven on the fleet path

Rollout half of **JELA-833** (`a341396`, PR #262). The design and the local
4/4 AC capture are in [`jela833-tx-bundle-coalesce.md`](./jela833-tx-bundle-coalesce.md);
this file is the "it is on the wire and it works there" record.

## 1. Published — server-plugin v1.0.47.0

`v1.0.46.0` carried shell `f3fdc2df` (251,940 B), which predates the coalescer.
The plugin embeds `packages/shell-tizen/src/shell.min.js` as a resource, so the
`<Version>` bump in PR #263 is the whole shipping mechanism.

| step                          | evidence                                                            |
| ----------------------------- | ------------------------------------------------------------------- |
| release cut                   | `server-plugin-v1.0.47.0`, `jellyplug-shell_1.0.47.0.zip` 2,755,707 B |
| manifest spliced              | `plugin-repo/manifest.json` head = `1.0.47.0`                        |
| propagation **driven**        | `PluginUpdates` → `/Plugins` showed `1.0.46.0 Superseded \| 1.0.47.0 Restart` → `POST /System/Restart` |
| **served body hashed**        | `GET /shell/shell.min.js` → sha256 `2f5d35c0…`, **253,065 B**        |
| byte-identical to the source  | `cmp` vs `git show origin/main:…/shell.min.js` → identical           |
| coalescer present in the body | `bulkSolo`, `bulkBatches`, `tx-bundle` all present                   |
| JELA-824 union **gone**       | `Object.keys(e)` count **0** in the served body                      |

Propagation is driven, not waited on (JELA-831). One `PluginUpdates` trigger was
enough this time; the restart took ~7 polls (~105 s) to come back.

## 2. The JELA-824 kill switch — it *had* landed, and the served bundle hid it

JELA-833 recorded that `GET /JavaScriptInjector/public.js` carried **no**
`txBundleDisabled` seed. That was true **of the served bundle** and false of the
stored config, and the difference is the JSI off-by-one: the served `public.js`
only rebuilds on a later save. **The `POST /System/Restart` in step 1 rebuilt it**,
and the seed appeared on the wire mid-run:

| fetch | sha256 (12) | `txBundleDisabled` | entry body |
| ----- | ----------- | ------------------ | ---------- |
| before the deploy | `d9f72b9bcf7d` | absent (14 other `jellyfin.shell.*` flags present as positive control) | — |
| after the restart | `b32f6f823079` | **present** | `if (getItem(k) !== "0") setItem(k, "1")` — suppresses the fix |
| at close          | `554e5ae8d1be` | present, **neutralised** | `setItem(k, "0")` unconditionally |

The third state was applied by another actor while this run was measuring, and
it is the correct shape: the entry must **write `"0"`, not be deleted**, because
a TV that already holds `"1"` keeps that value after the entry goes away. The
approval card this run raised for exactly that flip (`18dfd7cf`) was therefore
**withdrawn as moot**, not left pending. Dropping the entry is a separate,
later task, valid only once `"0"` has propagated.

**The durable lesson: a "not on the wire" reading of `public.js` is only true as
of the last config *save*, not the last config *write*. A deploy that restarts
Jellyfin can surface a seed that was invisible an hour earlier.** Re-check
`public.js` *after* the restart, never only before.

## 3. Proven on the fleet path

JELA-112 rig, cold boot, fresh profile per arm, **no proxy** — the bootstrap's
`jela833.shellBase` override was physically stripped from this rig's
`boot/index.html` and the `SHELL_BASE`/`SHELL_SRC` env hooks were hard-disabled,
so the shell can only come from prod. Two new gates assert it:
`shellFromFleetOrigin` (the recorded `shellUrl` starts with the prod origin) and
`shellNotLocal`. Both pass on every capture below, and every capture hashes the
executed body to `2f5d35c0`.

### The AC gates

| AC  | gate                                          | measured (2 cold boots each)              | verdict  |
| --- | --------------------------------------------- | ----------------------------------------- | -------- |
| 1   | `/shell/tx` + `/shell/tx-bundle` requests ≤ 8 | **6, 6** (3 GET + 2 POST + 1 preflight)   | **PASS** |
| 2   | total tx wire bytes ≤ 223,419 B               | **196,989 / 195,670 B**                   | **PASS** |
| 3   | `bulkBatches ≥ 1`, `f == 0`, `r == 0`, `h` matches per-body | `batches=2`, `f=0`, `r=0`, `h=68` | **PASS** |

Same-box per-body control, same served shell, differing by one pre-nav key:

| arm                          |   requests |    wire bytes |  h |  m |  r |  f | batches |
| ---------------------------- | ---------: | ------------: | -: | -: | -: | -: | ------: |
| BUNDLE (key absent)          |      **6** | **196,989**   | 68 | 63 |  0 |  0 |       2 |
| BUNDLE (key absent), replicate |    **6** | **195,670**   | 68 | 63 |  0 |  0 |       2 |
| PERBODY (`txBundleDisabled=1`) |     69   |   223,385     | 69 | 63 |  0 |  0 |     n/a |
| PERBODY, replicate           |       68   |   223,434     | 68 | 63 |  0 |  0 |     n/a |

**11.3x fewer requests and ~12% fewer bytes** than the per-body control, and —
against the shipped JELA-824 bundle's 18,820,722 B — a **95.5x** byte reduction
(taking the worst bundle boot, 196,989 B, against it).

Two notes on reading this table honestly:

- **`h` has ±1 boot-to-boot variance** (68, 69, 68, 68 across four cold boots):
  it counts what the SPA happens to splice, which is not fixed. AC3's "`h` equal
  to the per-body arm's `h`" holds on the matched pair (68 vs 68) and within that
  variance elsewhere. The invariant that actually carries the AC is **`m = 63`,
  `r = 0`, `f = 0` on every single boot of both arms** — nothing was lost to the
  batching, and no oracle rejected a batched body.
- **A per-body cold boot measured 223,434 B — 15 B *over* the AC2 gate.** The
  223,419 B ceiling sits exactly at the per-body arm's own noise band, which is
  the point: the bundle arm clears it by ~27 KB, not by a hair.

### Warm boots — no JELA-824-class regression

The worry inherited from JELA-824 is the cache asymmetry: `no-store` POSTs are
re-paid every boot where `immutable` GETs are paid once. Measured on kept
profiles (three boots, per JELA-832 — the boot right after a profile wipe loses
its localStorage tail, so the 2→3 pair is the one that counts):

| boot                       | arm key at nav | requests | wire bytes | LS keys at start | tx cache hits |
| -------------------------- | -------------: | -------: | ---------: | ---------------: | ------------: |
| fleet boot 1 (fresh)       |         absent |        6 |    195,182 |                5 |             0 |
| fleet boot 2 (kept)        |          `"0"` |        6 |    194,901 |               59 |             0 |
| **fleet boot 3 (kept)**    |          `"0"` |    **1** |  **2,726** |              379 |       **150** |
| per-body boot 2 (kept)     |          `"1"` |    **1** |  **2,726** |              374 |       **150** |

**Both arms converge to the same steady state — 1 request, 2,726 B** — because
the shell's own localStorage tx cache (`txLruStatic`) absorbs the bodies and is
policy-agnostic. The bundle arm reaches it one boot later here only because its
bodies arrive late in the boot (POSTs at 34 s and 39 s in a 70 s capture) and the
JELA-776 write-behind had not flushed the tail before the window closed; that is
a capture-window artifact, not a per-boot cost. So the `no-store` route costs at
most one extra warm boot of ~195 KB, against 18.8 MB **every** boot for JELA-824.

`armPre = "0"` on boots 2 and 3 is also the live confirmation that the
neutralised kill switch works: the channel writes `"0"`, the next boot reads
`"0"`, and the bundle path arms.

## 4. What this run would tell the next person

- **Hash the served body, then hash it again after the restart.** The shell sha
  is the deploy proof; `public.js` needed a *second* read for the same reason,
  and that second read is what caught the kill switch.
- **Strip the override, don't just leave it unset.** The JELA-833 rig could be
  pointed at a local shell by one localStorage key. For a fleet proof that key
  was deleted from the bootstrap and the env hooks were hard-disabled, so
  "served by prod" is structural rather than a matter of how the rig was invoked.
- **A neutralised flag entry is not a deleted one.** `setItem(k,"0")` must
  propagate before the entry can be dropped, or every TV that saw `"1"` keeps it.
- Wall-clock is unusable in this capture (loadavg 1.1 → 11.5 across the run).
  Request counts and `encodedDataLength` are load-independent, which is why every
  AC is written against those.
