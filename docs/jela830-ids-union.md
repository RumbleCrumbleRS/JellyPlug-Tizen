# JELA-830 — coalesce the boot `Ids=` hydration burst by id-union

Split out of [JELA-829](./jela829-home-row-seam-census.md), which found this lever by
census. Ships **DARK** behind its own opt-in flag, seeded nowhere.

---

## 1. The defect

Eleven boot GETs carry `Ids=`. Between them they ask for **339 item ids of which only
144 are distinct** — 2.35× over. Three of them (`+30 407 / +30 436 / +30 469 ms`) land
inside **62 ms of each other with pairwise 100 % id overlap**: the same 21 items,
three times, differing only in which `Fields` are requested.

The shell already owns a coalescer (JELA-724 / 752). `/Users/*/Items` is already on its
allowlist; it already has a window, a kill switch and counters. It misses **every one**
of these, because its key is the **byte-identical URL** and no two of the eleven URLs
are identical — every one carries a different `Ids=` list.

So this is not a wider window and not another allowlist entry. It is a different key.

The captured eleven are checked in verbatim at
`packages/shell-tizen/scripts/fixtures/jela830-ids-burst.json` (host, user id and
`api_key` replaced with placeholders — CI forbids real hosts in tracked files; every
other byte, the ordering and the `t` offsets are the captured values).

---

## 2. The change

A short **batch window** per `(route, credentials, mode, request headers, non-unionable
query)`. Requests landing in the window are held, their id lists unioned into ONE
request, and each waiter served a response **sliced** back down to exactly the ids it
asked for, in the server's own order.

The window is a **real delay** — the batch is not sent until it closes. That is only
affordable because the whole burst fires at **+19 s to +30 s**, long after firstCard, so
the latency is paid by post-paint hydration and never by paint.

A batch that closes with **one member is re-issued verbatim** (original url, original
init). A singleton pays the window but takes on no rewrite risk at all.

### What is unioned

| parameter                | rule                                                       |
| ------------------------ | ---------------------------------------------------------- |
| `Ids`                    | unioned — the point                                        |
| `Limit`                  | set to the union's id count                                |
| `Fields`                 | unioned (additive on the base DTO ⇒ always a superset)     |
| `EnableUserData`         | absent means TRUE ⇒ OR                                     |
| `EnableTotalRecordCount` | forced `false` on the wire, **synthesized per slice** (§3) |

Everything else is part of the key: `api_key`, `SortBy`, `IncludeItemTypes`, `ParentId`
— **and the three image-shape parameters** `EnableImages` / `EnableImageTypes` /
`ImageTypeLimit`, for the reason measured in §5. The base path is in the key too, which
is what keeps `/Items?Ids=` and `/Users/{u}/Items?Ids=` — different routes, one of which
ignores user data — in separate batches.

### Opt-outs

A `Request` object, a body or an `AbortSignal` opts the call out, exactly as the
existing coalescer requires. `Range` / `If-None-Match` / `If-Modified-Since` opt it out.
Request headers are part of the key, and headers we cannot walk opt the call out
entirely.

### Fallback

A non-2xx union, a body that will not parse, or a body with no `Items` array replays
**every** waiter on the real network with its original url — worst case is today's
behaviour plus one wasted request. Every slice is built **before** any waiter is
resolved, so a mid-slice throw cannot leave half the batch resolved and half replayed.

---

## 3. `EnableTotalRecordCount` — the constraint is discharged, not obeyed

The census listed _"only merge requests with `EnableTotalRecordCount=false` — a caller
that wants the count cannot be served from a filtered slice"_ as a hard constraint.

It is discharged here instead. For an `Ids=`-bounded query the count is derivable
**exactly**: `Ids` caps the result set at `|Ids|`, so whenever `Limit >= |Ids|` and
`StartIndex` is 0 the server cannot truncate, and `TotalRecordCount` is identically
`Items.length`. The slice therefore sets `TotalRecordCount` to its own length and is
byte-for-byte what the server would have answered.

Both preconditions are **enforced**, not assumed: a member with `StartIndex > 0`, or with
a `Limit` below its own id count, is refused the batch and goes to the network alone.

Obeying the constraint literally would have left census requests 0 / 1 / 2 / 4 — none of
which sends `EnableTotalRecordCount` at all — unmergeable.

---

## 4. Flag, counters, kill switch

Its own **opt-in** flag, seeded nowhere until a board flip. Deliberately not sharing a
flag with anything else — the JELA-820 lesson: a shared flag is not a dark deploy, it is
a deploy timed by someone else's ticket.

```
localStorage['jellyfin.shell.fcIdsUnion']       = '1'   arms it (absent ⇒ NOT INSTALLED)
localStorage['jellyfin.shell.fcIdsUnionWindowMs']       0..2000, default 250; '0' stands it down
window.__shellFCU = {on,w,seen,skip,batch,fire,sing,serve,items,short,absent,fb,err}
```

The saving is `batch - fire - sing`. **`short` is the correctness invariant and must stay
0** — it counts ids a waiter asked for that _were_ in the union response and yet did not
reach its slice, which is the only way the id normalisation could be wrong.

---

## 5. The image shape is KEY, not union — and that is a measured decision

The first cut unioned the image parameters, following the absent-is-permissive rule:
`EnableImageTypes` absent means ALL image types and `ImageTypeLimit` absent means
unlimited, so a union must **drop** them whenever one member omits them (unioning
`Primary` with `absent` would strip Backdrop/Logo from the member that asked for
everything).

Dropping them is correct. It is also expensive. The first A/B measured it:

| boot tail, 98-card home | requests | bytes      | B / item        |
| ----------------------- | -------- | ---------- | --------------- |
| OFF: 21 + 21 + 6 ids    | 3        | **9,298**  | 171 / 213 / 204 |
| ON: one 24-id union     | 1        | **11,835** | **493**         |

Two requests saved, 2,537 B paid. Across three-boot medians: **−4 `Ids=` GETs and +12 KB
of `Ids=` bytes, +48 KB of boot bytes, +2 preflights.** That is the wrong trade by this
repo's own standard, and it is not a tuning problem — an unrestricted image shape is
~2.5× the per-item cost.

So the three image-shape parameters moved out of the union and into the key. An identical
image shape still merges and the parameters ride onto the union URL verbatim; any
difference — **including absent vs present** — splits the batch.

Cost of the fix, on the census replay: **11 → 7** at 250 ms instead of 11 → 6. At 150 ms
it is 11 → 9, which does _not_ clear AC1; that is pinned as a test rather than asserted
away, because a shorter window is a weaker lever, not a free one.

---

## 6. Evidence

### 6.1 Unit test — `packages/shell-tizen/scripts/ids-union.test.cjs`

33 checks. Drives the **shipped** `instantHomeBody()` through a stubbed window, a fake
clock, a fake network and a fake **item pool** that answers `Ids=` queries the way the
server does (filter to the requested ids, return them in pool order, honour `Limit`).

The headline test **replays the census**: all eleven captured requests at their captured
`t` offsets, so the AC1 number is pinned to the measurement and not to a hand-written
scenario.

AC2 is asserted on **every one of the eleven waiters**: exactly its own ids, no foreign
id, none short, the server's order preserved, `TotalRecordCount` equal to its own slice.

Also pinned: dark by default; route / credentials / mode / header / query-parameter key
separation; the `StartIndex` and `Limit` preconditions; the six image-shape cases both
ways; the verbatim singleton; all four fallback paths with no half-resolved waiter;
`Request` / body / `AbortSignal` / non-`/Items` / empty-`Ids` scope; the window clamp
and `'0'` stand-down; dashed-vs-undashed id normalisation; the id and URL-length caps;
one install per window.

### 6.2 Rig A/B — `run830.mjs` (fork of the JELA-829 rig)

Same shell in both arms. The flag is **removed pre-nav in BOTH arms**, then set only in
ON (JELA-809 differential), so the OFF arm is an explicit removal and never an
assumption. `jellyfin.shell.queryAuth` is seeded in both arms, or the census is a boot-1
census of a TV that does not exist (JELA-829 §1).

**Provenance.** The shell under test is unpublished, so it cannot come off `/shell/` and
the rig's sha-match against the live manifest cannot pass. It was not relaxed away — it
was replaced with a stronger, positive claim. The build is served to the rig and executed
out of HSB's localStorage body cache (`readShellBody()` only requires
`rec.sha === hsbCachedHash`), with **both** pinned to the sha256 of the local build, so
`__hsbShellLs.sha` is the sha of the bytes that actually executed — the JELA-821 rule,
hash the executed body and never the URL. The base `shell.min.js` at `7010657` is
byte-identical to the live prod shell (`a171f117`), so the arms differ from production by
exactly this ticket's commits.

Matched on rendered home (114 cards / 10 sections), n = 2 per arm:

| metric               | OFF             | ON              | delta      |
| -------------------- | --------------- | --------------- | ---------- |
| `Ids=` GETs on wire  | 10, 11          | 6, 6            | **−4.5**   |
| `Ids=` bytes at boot | 65,817 / 70,210 | 58,948 / 62,289 | **−7,395** |

Across all seven boots: wire median 10 → 6.5, `Ids=` bytes median 69,829 → 66,534, boot
requests median 352 → 346, preflights unchanged at 10.

Same-boot candidate → wire, read off `__shellFCU` (immune to boot-to-boot home-size
variance): **11 → 9, 10 → 6, 10 → 7, 10 → 6.**

`short = 0`, `absent = 0`, `err = 0`, `fb = 0` in all four ON boots.

### 6.3 Acceptance

| AC                                                                                                             | verdict                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** boot `Ids=` GETs 11 → ≤ 8 at a 250 ms window, same-shell A/B with the flag stripped pre-nav in both arms | **PASS with a caveat.** Census replay of the exact eleven: **11 → 7**. Live: median 10 → 6.5, and 3 of 4 ON boots land at 6–7. **One boot (ON4) landed at 9.** See §7 — the absolute count tracks rendered home size, so a per-boot absolute bound is the wrong shape for this AC; the same-boot reduction is −2 to −4 on every boot. |
| **2** every waiter gets exactly the items it asked for                                                         | **PASS.** Unit-tested on all eleven census waiters; live `short = 0` / `absent = 0` on 4/4 ON boots.                                                                                                                                                                                                                                  |
| **3** card and section count at settle unchanged vs OFF                                                        | **PASS.** OFF cards {114, 114, 130} / sections {10, 10, 11}; ON cards {130, 114, 130, 114} / sections {11, 10, 11, 10}. Same two regimes, both present in both arms; ON never below the OFF minimum.                                                                                                                                  |
| **4** kill switch as a same-boot differential                                                                  | **PASS.** With the key absent `window.__shellFCU` does not exist — the shim is not installed at all, not merely inert — and every candidate is on the wire. The rig gate voids any OFF capture where `__shellFCU` is present.                                                                                                         |

---

## 7. What is NOT settled

**The absolute wire count is not a stable quantity.** Across seven boots the rig rendered
two different homes (98 / 114 / 130 cards) and the `Ids=` candidate count moved with it
(9–11 in OFF, 10–11 in ON). A per-boot "≤ 8" bound is therefore partly a statement about
how much home the boot built. `ON4` built the largest home seen (130 cards, 348 ids
asked) and its burst was spread widely enough that seven of eleven batches closed with a
single member — 11 → 9. The reduction was still real; the absolute number was not ≤ 8.

The sound measure is the **same-boot** `seen → wire` figure off `__shellFCU`, which is
immune to that variance and was −2 to −4 on every ON boot.

**`sing` dominates `fire`.** Across the four ON boots the shim fired 1–2 unions and 6–7
verbatim singletons. Most batches close with one member, i.e. most of the burst is not
actually concurrent at 250 ms once the image shape is keyed. A longer window would merge
more (the census simulates 11 → 5 at 800 ms with the old union rules) at the cost of more
post-paint hydration latency. Not explored — 250 ms is what AC1 names.

**Not measured on a warm TV.** Everything here is a cold boot into a fresh profile.
JELA-829 §4 left the warm question open and named the instrument it needs (a _replay_
into a fresh profile, not a re-boot); that is unchanged.

---

## Reproducing

- Unit test: `node packages/shell-tizen/scripts/ids-union.test.cjs`
- Rig: `run830.mjs`, a fork of the JELA-829 rig namespaced per `RUN_ID`. Adds the HSB
  localStorage body seed for an unpublished shell, the JELA-809 flag differential, the
  positive `__hsbShellLs.sha` provenance gate, an `Ids=` boot census (`rec.jp830`), and
  ON/OFF arm gates that void a capture where the shim failed to install, failed to fire,
  reported `short > 0`, or was present in an OFF arm.

  ```
  J820_RIG=$RIG J820_SRV_PORT=8830 J820_CDP_PORT=9830 \
  J830_SHA=<sha256 of the shell served at /shell830.min.js> J830_ARM=ON|OFF \
  node run830.mjs <tag> 1 1 boot
  ```

---

## 8. JELA-831 — the fleet flip

### 8.1 Why the flag could not stay opt-in

JELA-830 shipped `jellyfin.shell.fcIdsUnion` opt-in and seeded it nowhere. Arming it by
JSI-channel seeder — the obvious move — **would have shipped the flip with its effect
removed.** The read site is in `instantHomeBody()`, which runs at shell boot; the JSI
channel runs only after the lite→SPA handoff (JELA-802). A seeded `"1"` therefore arms
**one boot late** (JELA-821, and the whole JELA-827 bug class). The burst this coalesces
is a **cold-boot** burst, so boot-1-dark is exactly where the prize lives.

So the read was flipped to the JELA-827 opt-OUT shape instead. An absent key now means
**ON**, and the flip arms on **boot 1** with no seeder at all.

```
- if(flg ("jellyfin.shell.fcIdsUnion") && ...)   // getItem(k) === "1"
+ if(flgO("jellyfin.shell.fcIdsUnion") && ...)   // getItem(k) !== "0"
```

`flgO` is a new opt-OUT companion to the existing `flg` helper, mirrored into both
shells. It is **fail-closed on a throwing `localStorage`** — deliberately, and not for
symmetry with `flg`: a device whose `getItem` throws can never read its own kill switch,
and an un-killable feature is the one state no rollback can reach. That device is left
OFF.

**Rollback is `setItem("jellyfin.shell.fcIdsUnion", "0")` — never `removeItem`, which is
now an ON arm.** Setting `fcIdsUnionWindowMs` to `"0"` is a second, independent
stand-down. Both leave the shim _uninstalled_, not merely inert.

### 8.2 Rider audit (JELA-821)

The live prod shell was fetched and hashed, not assumed:

|                                                              | value                                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| live `/shell/shell.min.js` before the flip                   | `a171f117ecf9c798…`                                               |
| the commit that built those bytes                            | `b9b185e8` (JELA-827 5/5, `lsWriteBehind`)                        |
| shell-source commits between the live bytes and this release | `69361d2`, `a3dc802` (**both JELA-830**), plus this ticket's flip |

Nothing unrelated rides along: the only shell-source changes between the bytes on the
wire and the release are JELA-830's two commits and JELA-831's flip. `shell.min.js` is
unaffected by the `.csproj` version bump — `__SHELL_VER__` is substituted from
`tizen/config.xml` (1.0.90), not from the plugin version.

**Expected shell sha after this release — pinned before the release, to be confirmed on
the wire:**

```
shell.min.js       f3fdc2df8988134aee22c7e36336abc67d6fb0c13e5ac7b3eb07cd7cf797bfad
boot-shell.min.js  4e8c61fb3171c46353bd34474b33f0174558292e86fead22c8e3ecab70bf8365
```

### 8.3 Test evidence for the flip

`ids-union.test.cjs` gained the arming differential (JELA-789/809) and kept every
JELA-830 assertion. The static contract check now pins the **polarity**, not just the
key: it asserts `flgO(FLAG)` is present _and_ that the old `flg(FLAG)` read is **gone**,
so a silent revert to opt-in fails the build rather than passing a key-only check.

| arm                         | before (JELA-830)                  | after (JELA-831)                                         |
| --------------------------- | ---------------------------------- | -------------------------------------------------------- |
| key **absent**              | shim not installed, 11 on the wire | **shim installed, census collapses, `short=0`, `err=0`** |
| key `"0"`                   | (was ON)                           | **shim not installed, 11 on the wire**                   |
| **throwing** `localStorage` | —                                  | **shim not installed** (device stays killable)           |

All 35 checks pass. Both `src↔min` verifiers pass, `cross-shell-parity` passes (111
shared functions), and both package suites are green. Both built mins were audited **by
read expression**: 1 × `flgO("jellyfin.shell.fcIdsUnion")`, 0 × stale `flg(...)`.

### 8.4 What this does NOT change

Everything in §7 stands. The absolute wire count still tracks rendered home size, `sing`
still dominates `fire` at a 250 ms window, and the **warm** path is still unmeasured.
The flip changes _when_ the shim arms, not what it does once armed.

### 8.5 Rollout record

Board approved the deploy on interaction `0b2aa86c` (accepted 2026-08-31 20:17 Z).

| step                                                                | result                                                                                                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| PR #257 — the opt-OUT flip                                          | merged `4ddb6e8` → `360cf70`, 6/6 CI green                                                                                                |
| PR #258 — `.csproj` 1.0.45.0 → **1.0.46.0**                         | merged → `5488559`, 6/6 CI green                                                                                                          |
| `release-server-plugin` (dispatch-only, `confirm_version=1.0.46.0`) | run `33435750040` **success**; release `server-plugin-v1.0.46.0` with `jellyplug-shell_1.0.46.0.zip`; `plugin-repo/manifest.json` spliced |
| merged shell bytes vs the pre-release pin                           | **exact match** on both shells                                                                                                            |

**AC1 is NOT yet met at the close of this run.** A publish is not a deploy: the
Jellyfin server auto-pulls the plugin zip **and restarts** on its own cadence
(`docs/deploy-runbook.md` §1), which the release step does not control. At close,
9 minutes of `verify-shell-deploy.sh --poll` (18 polls) still read:

```
live /shell/manifest.json   sha256=a171f117…  (the OLD bytes)
installed plugin            1.0.45.0 Active
plugin-repo/manifest.json   1.0.46.0          (the new bytes are published)
```

So the release is **cut and published** but **not yet on the wire**. AC1–AC4 are
carried by the acceptance follow-up, which must run against the **shipped**
artifact and not against a local build. Do not read "released" as "live"
(JELA-747: "flag-dark" turned out to mean NOT DEPLOYED).

Because the flip is opt-**OUT**, the AC2 two-boot proof inverts relative to
JELA-830: `window.__shellFCU` must be present on **boot 1**. The JELA-829 §4 gate
still applies — boot-1 `lsPost` ∩ boot-2 `lsPre` must be large, or boot 2
silently re-ran boot 1 and the pair is VOID.
