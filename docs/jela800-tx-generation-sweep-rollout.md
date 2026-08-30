# JELA-800 — rolling out the JELA-799 tx generation sweep

Rollout half of **JELA-799** (implementation merged flag-dark in PR #227,
commit `16bac5a`). Two independent flags, each with a kill switch:

| half                                             | flag                         | kill switch            | counter                       | beacon  |
| ------------------------------------------------ | ---------------------------- | ---------------------- | ----------------------------- | ------- |
| (a) seed-side per-family `gqk:` generation sweep | `jellyfin.shell.txGenSweep`  | `…txGenSweepDisabled`  | `window.__shellTxGenDrop`     | `tx.gd` |
| (b) LRU-track `txc:` bodies + prune-and-retry    | `jellyfin.shell.txLruStatic` | `…txLruStaticDisabled` | `window.__shellTxPruneStatic` | `tx.ps` |

Endpoints are the ones JELA-799 fixed on: **store size in UTF-16 code units**,
orphaned-generation counts, `__shellLsQuotaErr`, and `gd`/`ps`. **Not cards, not
timing** — JELA-797 measured dead boots at 55 % of quota with zero quota errors,
and `net::ERR_ABORTED` in boots that rendered 279 cards. `domCards` appears below
only as a **health gate**: a boot that rendered nothing measured nothing.

## Gate 5 first: prod cannot read either flag today

Protocol item 5 says gate the seeder on the **served** shell carrying the reader.
It does not:

|                                     | sha1 `shell.min.js` | `txGenSweep` | `txLruStatic` |
| ----------------------------------- | ------------------- | ------------ | ------------- |
| live `${server}/shell/shell.min.js` | `3e2e5105b9c5`      | 0            | 0             |
| `origin/main` @ `16bac5a`           | `42f5a2d267e3`      | 1            | 1             |

`3e2e5105b9c5` is the `shell.min.js` of every commit from `2baf137` back through
`23ff261` — prod serves the **pre-799** bytes baked into server-plugin
**1.0.38.0**. Seeding either flag on the fleet today is a guaranteed no-op.
The flip therefore has a publish as its first step.

## The rig

Because prod cannot serve the reader yet, the arms run against a **local
`/shell/`** carrying `origin/main`'s exact `shell.min.js` bytes, with everything
else — API, `/web/`, plugin scripts, JellyfinEnhanced — the real prod server.
That is the JELA-681 local-shell A/B pattern, and it is sound here because every
endpoint is shell-internal; none is a server-side or timing measurement. The HSB
`base` is repointed by a one-line override in the rig's copy of the bootstrap
page (`jela800.shellBase`).

Protocol compliance: fresh profile per arm; `jsiChannelDisabled=1` and
`liteEnabled=0` in **every** arm; render read from the **DOM** over CDP, never
`__707.state`; `Browser.close` and then SIGTERM, waiting for the process to leave
`/proc` before any SIGKILL; localStorage dumped from the **same origin/port** the
ring used; all sizes in UTF-16 code units.

### Inducing the version bump

The control arm has to **show** the defect, so the bump is induced rather than
waited for. Boot 1 populates generation V1. Between boots a same-origin mutator
rewrites the store's dominant `?v=<dotted>-<tick>` token to a synthetic **older**
tick of the same shape. Boot 2 then fetches V1 again. Same family — `__txFam`
strips the whole `v=` pair, since the value matches both the `\d+(\.\d+){2,}`
and the `\d{15,}` arms of `__txVerTok` — different key. That is exactly what a
real JellyfinEnhanced version bump looks like from the next boot's point of view.

**The trap that ate the first run: rewrite KEYS, not values.** A blanket
key-and-value rewrite also moves the cached JE script list, which is the source
of truth for _which_ `?v=` the next boot fetches. Boot 2 then re-requested the
old generation and every endpoint read "no bump happened" — the store came back
with all 153 versioned keys on the synthetic tick and `gd=0` in both arms, which
looks exactly like a dead lever. Only the `gqk:`/`vqk:` index **values** may move
with the keys (their values _are_ keys); every other value must be left alone.

**Second instrument note: `Browser.close` does not stop M63 headless.** The first
run lost 121 keys / 1,337,341 code units between the two boots of one arm
(3,620,901 → 2,283,560 at the next boot's start). Adding a 20 s wait for the
process to leave `/proc` did not help — `cleanExit` was `false` on every boot,
i.e. Chromium was still alive and got SIGKILLed anyway, and the throttled
DOMStorage commit (JELA-748) never reached disk. **SIGTERM** is what runs
Chromium's normal shutdown. The (a) arms below were measured before that fix and
therefore bump only the ~40 keys that survived the flush, rather than all 153 —
which makes them a **conservative** reading of the prize, not an inflated one.

## (a) `txGenSweep` — result: the sweep removes the whole orphaned generation

Both arms: fresh profile, boot 1 → induced bump → boot 2. Flag state constant
across both boots of an arm (the treatment needs boot 1 to build the index).
`domCards` 247–279 in all four boots, `err` 0, load 5.7–10.2.

|                                      | control `a-off`       | treatment `a-on`                   |
| ------------------------------------ | --------------------- | ---------------------------------- |
| keys carried across the induced bump | 39                    | 42                                 |
| **orphan keys left after the bump**  | **39**                | **0**                              |
| **orphan code units left**           | **391,881**           | **0**                              |
| `gd` (`__shellTxGenDrop`)            | 0                     | **42**                             |
| multi-generation families            | 39                    | 2 (both pre-existing `vqk:` pairs) |
| generations present in the store     | **both** ticks        | new tick only                      |
| store, boot 1 → boot 2               | 3,617,283 → 4,009,867 | 3,652,987 → 3,665,037              |
| **Δ across the bump**                | **+392,584**          | **+12,050**                        |
| `qe` (`__shellLsQuotaErr`)           | 0                     | 0                                  |

The control **shows the defect** — that gate is the whole reason the bump is
induced — and the treatment removes it completely: every one of the 42 bumped
families dropped its old body plus the `ts:` sibling, and not one orphan
survived. Δ store across a bump falls **32.6×**, from a whole extra generation
to index churn.

Scaled to a real JellyfinEnhanced bump (the JELA-797 census: 163 plain slots /
1,882,682 code units, essentially all carrying `?v=12.4.1.0-<ticks>`), the
control's behaviour is 799's headline arithmetic — 3.67M + 1.84M = 5.51M against
a 5,242,880-code-unit quota — and the treatment simply never gets there.

**Price of the index, measured:** 152 `gqk:` entries cost **+35,704 code units**
(3,652,987 vs 3,617,283 on the otherwise-identical first boot) = **+0.99 %** of
the store, against 391,881 units recovered on a _partial_ bump. It pays for
itself an order of magnitude over on the first bump.

**No `gqk:` thrash on the multi-`c=` families.** `famCount` is 157–158 while
`gqk` is 152 on both treatment boots and `gd` stays 0 on boot 1 — the HomeScreen
`?v=…&c=N` slots are distinct families and did not evict each other, which is
the family-not-bare-path property JELA-799 called load-bearing. Confirmed here on
real prod URLs rather than in the unit test.

## (b) `txLruStatic` — result: the pruner can now reach the biggest keys

Two readings per arm. Boot 1 is unpadded and answers the question directly.
Boot 2 drops the `txc:` bodies (a warm hit writes nothing, so a boot that writes
nothing can never meet the quota path under test — pointer slots are left alone
on purpose, an absent deref target is already a self-healing miss) and pads the
store to **~4.91M of the 5,242,880-code-unit quota**, so the widget's
`txSetStatic` meets a real `QuotaExceededError` while re-writing them.

### Boot 1 — the tracking half, no quota involved

|                               | control `b-off`        | treatment `b-on` |
| ----------------------------- | ---------------------- | ---------------- |
| keys in `shell.txLru<TX_VER>` | 152                    | 161              |
| **`txc:` bodies tracked**     | **0**                  | **3**            |
| pointer keys tracked          | 0                      | 0                |
| `txc:` bytes in the store     | 938,108 (25.9 % of it) | 938,108          |

938,108 code units — **25.9 % of the whole store**, and the single biggest key in
it — were unreachable by `__txPrune` in the control, exactly as JELA-799
described. With the flag on all three enter the map, and **pointer keys stay
out**, which is the deliberate asymmetry: evicting a pointer while its body lives
is a leak; evicting a body while the pointer lives is a self-healing miss.

### Boot 2 — at the ceiling

|                                | control `b-off`             | treatment `b-on` |
| ------------------------------ | --------------------------- | ---------------- |
| store at navigation            | 4,912,875                   | 4,913,977        |
| `ps` (`__shellTxPruneStatic`)  | **0**                       | **10**           |
| `qe` (`__shellLsQuotaErr`)     | 1                           | 1                |
| plain slots retained           | 27                          | **57**           |
| plain-slot code units retained | 502,400                     | **779,946**      |
| store at end                   | 5,217,995 (99.5 % of quota) | 5,164,828        |
| `domCards`                     | 279                         | 279              |

Under identical quota pressure the treatment's prune-and-retry fired
(`ps=10`) and **kept 2.1× the live cache** — +30 script bodies, +277,546 code
units — while finishing **53,167 units lower** in the store. That is the whole
claim of (b): at the ceiling the cache keeps working instead of losing the write.

**Stated honestly: `qe=1` in _both_ arms.** Prune-and-retry reduces the damage,
it does not eliminate quota errors — the retry is deliberately gated on the prune
having actually evicted something, so a store that is full of untouchable keys
still loses a write. (b) makes the ceiling survivable; only (a) keeps the store
away from it. That is why the flip order is (a) then (b).

## A rig fact worth keeping: this M63 build loses ~1.4M code units per restart

Even with `cleanExit=true` (SIGTERM, normal Chromium shutdown), a boot that ended
with **3,617,244** code units in the store restarted with **2,015,589**. Across
all four two-boot arms the loss is 1.30M–1.60M. It is not a SIGKILL artifact and
not the shell pruning — `lsBefore` is read on the seed page, before any shell has
run. Roughly the last boot's final ~1.4M of writes never reach the LevelDB.

Consequences for anyone measuring localStorage across boots on this rig:

- a growth-across-boots curve is **systematically low**, and a "the store shrank"
  reading is an instrument artifact, not an eviction;
- an induced bump only covers the keys that survived the flush (~40 of 153 here),
  so this run's (a) prize is a **floor**, not an estimate;
- any single-boot endpoint (like (b)'s boot-1 LRU composition) is unaffected —
  prefer one where the question allows it.

## Rollout

Order is (a) then (b): (a) stops the store reaching the ceiling, (b) makes the
ceiling survivable when it is reached anyway. They are independent — either can
be flipped or killed without the other.

**Step 0 is a publish, not a flag.** Nothing can be seeded until prod serves a
shell containing the readers. `release-server-plugin` reads `<Version>` from the
csproj and refuses an existing tag, so the publish needs a bump; the concurrent
**JELA-798** branch already bumps to **1.0.39.0**, and a release ships _all_ of
main (JELA-787/JELA-725), so the 799 shell rides along with it. Do not bump the
csproj a second time for this ticket. **Verify by SHA, never by version number:**

```sh
curl -s "$JELLYFIN_URL/shell/shell.min.js" | sha1sum      # must be 42f5a2d2… or later
curl -s "$JELLYFIN_URL/shell/shell.min.js" | grep -c txGenSweep   # must be >= 1
```

Then the two JSI channel seeders, appended in the established
`JellyPlug — <flag> default-ON (JELA-nnn)` shape. Both read _after_ the shell has
already read the flag, so each takes effect on the TV's **next** boot — a seeded
shell flag needs a two-boot arm proof (JELA-789).

```js
/* JellyPlug — JELA-799 (a) jp799a: fleet default-ON for the seed-side
   per-family gqk: generation sweep (PR #227 squash 16bac5a).
   Per-TV kill: 'jellyfin.shell.txGenSweep'='0' or
   'jellyfin.shell.txGenSweepDisabled'='1'. jp799aseed */
(function () {
  try {
    var k = "jellyfin.shell.txGenSweep";
    if (localStorage.getItem(k) !== "0") {
      localStorage.setItem(k, "1");
    }
  } catch (e) {}
})();
```

```js
/* JellyPlug — JELA-799 (b) jp799b: fleet default-ON for txc: LRU tracking and
   the txSetStatic prune-and-retry (PR #227 squash 16bac5a).
   Per-TV kill: 'jellyfin.shell.txLruStatic'='0' or
   'jellyfin.shell.txLruStaticDisabled'='1'. jp799bseed */
(function () {
  try {
    var k = "jellyfin.shell.txLruStatic";
    if (localStorage.getItem(k) !== "0") {
      localStorage.setItem(k, "1");
    }
  } catch (e) {}
})();
```

Channel-deploy mechanics that have bitten every previous flip: the config POST
replaces **all** entries, so re-fetch and re-run the patcher immediately before
POSTing; the served bundle rebuilds on the _next_ save, so save twice and verify
the **served** bundle, not the config JSON; and purge the rig's `jsiChannel` keys
after a channel deploy.

Rollback is a **remover**, not a delete: dropping the seeder leaves every TV that
already latched the key still ON (JELA-789). A rollback entry must write the kill
switch (`…Disabled='1'`) or set the flag to `'0'`.

## Flip executed — 2026-08-28

Board approved on JELA-800 (interaction `e6e96c64`, accepted 19:21Z). The publish
half was already satisfied: **JELA-798's release published server-plugin
1.0.39.0**, and `16bac5a` is an ancestor of the publish commit `99aa755`, so the
799 shell rode along. Verified by SHA, never by version number:

```sh
curl -s "$JELLYFIN_URL/shell/shell.min.js" | sha1sum   # 42f5a2d2… == origin/main
curl -s "$JELLYFIN_URL/shell/shell.min.js" | grep -c txGenSweep   # 1
GET /Plugins                                          # JellyPlug Shell 1.0.39.0 Active
```

Both seeders appended to the JSI channel, **saved twice**, each POST preceded by
a fresh GET + re-run of the patcher (the POST replaces _all_ entries), and
verified in the **served** bundle rather than the config JSON:

```sh
curl -s "$JELLYFIN_URL/JavaScriptInjector/public.js" | grep -c jp799aseed   # 1
curl -s "$JELLYFIN_URL/JavaScriptInjector/public.js" | grep -c jp799bseed   # 1
```

### Two-boot proof, fresh profile, live channel, **prod** `/shell/`

|                                      | boot 1                          | boot 2          |
| ------------------------------------ | ------------------------------- | --------------- |
| flags read back                      | `txGenSweep=1`, `txLruStatic=1` | same            |
| `gqk:` index entries                 | **152**                         | **152**         |
| LRU keys / `txc:` tracked / pointers | 154 / **0** / 0                 | 161 / **3** / 0 |
| `domCards`                           | 247                             | 279             |

**(a) engages on the SAME boot; (b) needs the NEXT one.** Both flags are read
from `localStorage` per call, not once at startup, so the seeder arming mid-boot
is enough for the seed's `__txSet` — which keeps running after the channel
executes — to build the index immediately. The `txSetStatic` writes for the
`txc:` bodies, by contrast, are the shell's own transpile of the static plugin
scripts and have all happened _before_ the channel runs on a cold boot. Do not
read `lruTxc=0` on a first boot as "the (b) flip failed".

**A channel deploy purges the tx cache — never run one during an arm.** An
earlier proof read `gqk=152` on boot 1 and `gqk=0` on boot 2, which looks exactly
like "the index does not survive a warm boot". It was self-inflicted: the second
seeder was POSTed while that boot was in flight, which changed the scripts
component hash and fired `ceInvalidate` — whose sweep JELA-799 deliberately
extended to drop `gqk:` entries. `txKeys` 314 → 8, `plain` 157 → 4, `lru` 152 → 0
in the same reading, i.e. the whole cache went, not just the index. The re-run
above, with the channel left alone, holds `gqk=152` across both boots.

Kill switches, per TV: `jellyfin.shell.txGenSweep='0'` or
`jellyfin.shell.txGenSweepDisabled='1'`; likewise `txLruStatic`. Fleet rollback
must be a **remover** — deleting the seeder leaves every TV that already latched
the key still ON.
