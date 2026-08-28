# JELA-799 — tx-cache generation sweep, and making the biggest key prunable

Split from **JELA-797**, which _refuted_ the parent claim that localStorage size
kills boots. Keep that refutation in view while reading this: the M63 quota was
measured at **5,242,880 UTF-16 code units**, a boot with a 2.87M-char store and
`__shellLsQuotaErr=0` died anyway, and a boot padded to the ceiling rendered 279
cards. Nothing here is about boot survival. These are **cache-efficiency**
defects, and at quota they degrade _plugin_ behaviour, not rendering.

Evidence for the census numbers: `docs/jela797-localstorage-quota-cliff.md`
(PR #226). Aged rig profile: 228 keys / 3,674,995 chars.

Sizes throughout are **UTF-16 code units** (`k.length + v.length`), the unit the
quota is denominated in. Calling that "MB" is exactly the error that produced the
retracted JELA-797 cliff — don't reintroduce it.

## The two defects

### (a) Seed-written `?v=` slots were never generation-swept

`__txKey` deliberately **keeps** a `?v=` token — only 12–14 digit epoch busters
are stripped (JEL-178) — so `path?v=OLD` and `path?v=NEW` are two different keys
holding two full bodies. Nothing removed the old one:

- the seed maintained no index at all;
- the widget's one-generation cleanup `txRecordQuerySlot` (the `vqk:` index) only
  ever runs for URLs the **widget** fetched;
- census: **3 `vqk:` entries against 163 plain slots** — ~160 seed-written slots
  with no generation sweep of any kind.

The only eviction was `__txPrune`, which fires **only** from `__txSet`'s quota
catch. So the bound was the quota itself, reached reactively and then thrashed 10
keys at a time.

Measured cost: 163 plain slots / 1,882,682 chars, essentially all carrying
`?v=12.4.1.0-<ticks>`. One JellyfinEnhanced version bump lays a fresh ~1.84M-char
generation beside the old one: **3.67M + 1.84M = 5.51M > 5.24M**. One bump pins
the store at the ceiling.

### (b) `txc:` bodies were invisible to the pruner

`__txPrune` removes the 10 LRU-oldest keys **from the `__txLru` map**, which only
`__txGet`/`__txSet` populate. `txSetStatic` and `txRecordQuerySlot` never touched
it, so content-addressed `txc:` bodies could never be evicted — including the
single biggest key in the store, `shell.tx1t1at4s:txc:<hash>` at **901,582 chars
= 24.5% of everything**. At quota the pruner dropped small seed entries while the
901 KB body stayed forever. `txSetStatic`'s own quota catch did not prune at all;
it counted the lost write (`__shellLsQuotaErr`) and gave up.

Observed cost at quota **on a boot that rendered**: a cascade of
`TypeError: Cannot read property '<x>' of undefined` from plugin scripts whose
dependencies never got cached.

## What shipped

Both halves are mirrored into `shell.js` (retail `/shell/` drop) and
`boot-shell.src.js` (baked HSB fallback). Both are **flag-dark**.

### (a) `gqk:` — a per-family generation index on the seed side

`__txSet` now calls `__txGenRec(k)` in its query-bearing arm, **before** the body
is written, so the space is freed proactively rather than at quota.

The index is keyed on the **family**, not the bare path. Family = the `__txKey`
key with its _version-ish_ tokens removed (`>=15`-digit ticks, dotted `a.b.c`,
long hex — lockstep with `__txQC`'s `pin` arm). This matters: the HomeScreen
sections ship `/HomeScreen/…js?v=<ver>&c=N`, so a **bare-path** index would let
`c=1` and `c=2` evict each other every boot. As families they are distinct, and
only a real `?v=` change sweeps.

- family `===` key (class 1, epoch buster only) → skipped entirely; no index key,
  nothing to sweep.
- old generation's body **and** its `ts:` sibling are removed, and the key is
  dropped from the LRU map so the pruner doesn't later waste a slot on it.
- content-addressed `txc:` bodies are **not** dropped here on purpose: they are
  keyed by _source hash_, so a byte-identical body legitimately survives a
  version bump, and dropping it would kill a live entry. Reaching those is (b).
- `ceInvalidate`'s scripts-component sweep now also drops `gqk:` entries (a
  no-op with the flag dark, since no such key exists).

Flag: `jellyfin.shell.txGenSweep='1'`, kill switch
`jellyfin.shell.txGenSweepDisabled='1'`. Counter: `window.__shellTxGenDrop`.

### (b) LRU-track `txc:` bodies + prune-and-retry

- `txSetStatic` tracks the key it wrote, and on quota now does
  `txPruneStatic()` + retry, mirroring `__txSet`. The retry is gated on the prune
  having _actually evicted something_, so with the flag dark it collapses exactly
  to the old "count the lost write and give up".
- `txGetStatic` touches the **body** key on a hit — the deref target for a
  `@@shellref:` pointer, `k` otherwise. Without this every `txc:` body would look
  eternally cold and prune first the moment it became prunable at all.
- Pointer keys are deliberately **not** tracked: evicting a pointer while the body
  lives is a leak, whereas evicting a body while the pointer lives is already a
  self-healing miss (`txGetStatic` treats an absent target as a miss and refetches).
- `txRecordQuerySlot` forgets a superseded `txc:` key so dead entries can't sort
  oldest and burn the pruner's 10-key budget.
- The widget uses the **same** map the seed does (`shell.txLru<TX_VER>`), so the
  seed's `__txPrune` can now reach `txc:` bodies too.

Flag: `jellyfin.shell.txLruStatic='1'`, kill switch
`jellyfin.shell.txLruStaticDisabled='1'`. Counter: `window.__shellTxPruneStatic`.

### Telemetry

The opt-in diag beacon's `tx` object gains `gd` (generations swept) and `ps`
(keys evicted by the widget pruner), alongside the existing `ls`/`lk`/`qe`.
Both read `0` on a flag-dark boot, which is what makes them a usable flip signal.

## Tests

`packages/shell-tizen/scripts/tx-gen-sweep.test.cjs` (60 checks, wired into the
`shell-tizen` chain) lifts the shipping functions out of **both** shells and runs
them against one shared store with a real UTF-16 quota. It pins the fix _and the
control arms that show the defect_ — see the gating note below for why that is
not optional:

- (a) control: flag dark, a `?v=` bump leaves **both** generations, the store
  grows by a whole body, and the orphan is still readable.
- (a) fix: one generation survives, the old body is _gone_, the store grows by
  index churn only, `gd=1`, the new URL serves, the old one misses (JEL-178
  staleness contract intact).
- (a) kill switch restores the orphaning exactly; class-1 URLs write no index;
  `&c=1` / `&c=2` do not thrash and a bump drops only the matching family.
- (b) control: `txSetStatic` tracks nothing and `__txPrune` cannot touch the
  biggest key; at quota the body is dropped and counted as `qe=1`.
- (b) fix: the body enters the map, the seed pruner reaches it, a hit refreshes
  recency, the pointer key stays untracked, and the write that would have been
  lost lands with `qe=0`.

Also updated: `plugin-fetch-cache.test.cjs` and `diag-beacon.test.cjs` harnesses,
and the `buildSeedScript` divergence pin in `cross-shell-parity.test.cjs` (both
seeds gained the identical sweep block). `verify_shell_src.py` and
`verify_boot_shell_src.py` both pass against regenerated `.min` blobs.

## Measuring this (read before running an arm)

Learned the hard way in JELA-796/797:

1. **The control arm must SHOW the defect.** A version bump has to be _induced_,
   not waited for. A lever's prize can decay between merge and flip (JELA-778), and
   an arm where no bump happened proves nothing either way.
2. **Do not measure this by boot survival.** JELA-797 showed dead boots at 55% of
   quota with zero quota errors, and `net::ERR_ABORTED` in boots that rendered 279
   cards. The endpoints are **store size after an induced version bump** (in
   UTF-16 code units), **`__shellLsQuotaErr`**, **tx hit/miss**, and the new
   **`gd`/`ps`** counters. Not cards. Not timing.
3. **Read render from the DOM over CDP**, never from `__707.state` — rec707 writes
   that into localStorage inside a swallowing catch, so a full store makes a
   healthy boot look dead.
4. A persistent profile hits a ~3.67M-char cliff of the shell's _own_ transpile
   cache and then boots `cards=0`, which reads as "the defect vanished"
   (JELA-796). Use a fresh profile per arm, and dump localStorage from the **same
   port/origin** the ring used.

## Rollout

Both flags ship dark. Flip order should be (a) then (b): (a) is the one that
prevents the store reaching the ceiling in the first place, (b) is what makes the
ceiling survivable when it is reached anyway. They are independent — either can
be flipped or killed without the other.
