# JELA-823 — `deferBitrateTest` armed one boot late: acceptance on the live fleet path

**Date:** 2026-08-31 · **Parent:** JELA-737/787 (`deferBitrateTest` fleet flip) ·
**Sibling:** JELA-821 (`deferJe`, same polarity change) · **Found by:** JELA-822
full Tizen 5.0 perf census · **Status: fix LIVE; AC1 and AC2 PASS; AC3 PASSES
except for one newly-seeded flag, raised as a child.**

## 1. What shipped

The read site was opt-in and fail-closed, so a boot that started with the key
absent skipped the whole deferral block and let the 5.77 MB bitrate probe run
unmanaged:

```js
- if (localStorage.getItem("jellyfin.shell.deferBitrateTest") !== "1") return;
+ if (localStorage.getItem("jellyfin.shell.deferBitrateTest") === "0") return;
```

The key is seeded by the JSI channel, which only runs after the lite→SPA handoff
(JELA-802), while this read site runs on the boot _before_ that. Present in all
four artifacts (`shell.js`, `shell.min.js`, `boot-shell.src.js`,
`boot-shell.min.js`) and **live on prod** in shell v1.0.90 /
`f3fdc2df8988134aee22c7e36336abc67d6fb0c13e5ac7b3eb07cd7cf797bfad`.

## 2. How it was verified

JELA-112 virtual Tizen 5.0 rig (pinned Chromium 63 / V8 6.3, Tizen-5.0 UA), real
WGT bootstrap → **prod** `/shell/` → real `/web/` → **live** JSI channel. Because
the fix is already published, no local-shell repointing was needed: this is the
real fleet path, not a staged one.

Three arms differing by **exactly one pre-nav localStorage key**, each boot on
its own **fresh profile and fresh chrome process** (JELA-719: M63's in-process
memory cache serves repeat fetches, so a cold census needs a new process):

| arm      | `deferBitrateTest` at nav | expectation              |
| -------- | ------------------------- | ------------------------ |
| `ABSENT` | absent — the fixed case   | deferred                 |
| `SEED1`  | `"1"`                     | deferred (AC1 twin)      |
| `OFF`    | `"0"`                     | undeferred (kill switch) |

**The arm is proven by the diag object, never by a request** (JELA-811). The
gate installs `window.__shellBT = {on:1, gate, armed, fired, why, …}` only when
it does _not_ return early, so its presence/absence is the arm independently of
what the network did.

Provenance is asserted on the **executed body, never the request URL**: the
shell response body is pulled back over CDP and hashed, and must equal the
expected sha, carry the `==="0"` read site exactly once, and carry no `!=="1"`
site. All 8 boots: `f3fdc2df…`, 1 opt-out site, 0 opt-in sites.

## 3. Results — 8 boots, all VALID

| arm      | rep | `lsPre` | `lsPost` | `__shellBT` | `why`    | `fired` | fcWall | probe at | probe − fcWall | pre-paint |
| -------- | --- | ------- | -------- | ----------- | -------- | ------- | -----: | -------: | -------------: | --------: |
| `ABSENT` | 1   | `null`  | `"1"`    | **present** | `settle` | 1       | 20,570 |   37,986 |    **+17,416** |     **0** |
| `ABSENT` | 2   | `null`  | `"1"`    | **present** | `settle` | 1       | 11,937 |   29,154 |    **+17,217** |     **0** |
| `ABSENT` | 3   | `null`  | `"1"`    | **present** | `settle` | 1       |  8,786 |   24,334 |    **+15,548** |     **0** |
| `ABSENT` | 4   | `null`  | `"1"`    | **present** | `settle` | 1       | 20,322 |   40,766 |    **+20,444** |     **0** |
| `SEED1`  | 1   | `"1"`   | `"1"`    | **present** | `settle` | 1       | 16,251 |   33,530 |    **+17,279** |     **0** |
| `SEED1`  | 2   | `"1"`   | `"1"`    | **present** | `settle` | 1       | 13,750 |   34,941 |    **+21,191** |     **0** |
| `OFF`    | 1   | `"0"`   | `"0"`    | **absent**  | –        | –       | 11,010 |   19,504 |     **+8,494** |         0 |
| `OFF`    | 2   | `"0"`   | `"0"`    | **absent**  | –        | –       | 14,501 |   17,657 |     **+3,156** |         0 |

All 8 boots: 6 `/Playback/BitrateTest` requests totalling ~5,770,6xx B (the
issue's 5,770,501 B, plus three CORS preflights), served sha `f3fdc2df…`,
398–429 total requests, 98–130 cards, 9–11 sections.

### AC1 — PASS. A key-absent boot now behaves exactly like a seeded one.

`ABSENT` and `SEED1` are indistinguishable across 6 boots: `__shellBT` present,
`armed=1`, `fired=1`, released on `why="settle"`, and **0 of 6 probe requests
pre-paint** in every boot. The differential the AC asks for holds — removing the
key pre-nav no longer changes behaviour.

### AC2 — PASS. The gate is live, not deleted.

With `"0"` seeded, `__shellBT` is **absent** in both boots: the gate returns
early and the probe runs on ApiClient's own schedule. The separation is clean —
**the armed and unarmed offset ranges do not overlap**: armed 15,548–21,191 ms
after paint (n=6) against unarmed 3,156–8,494 ms (n=2), a gap of ~7 s.

**Honest limit: in this rig every arm's probe landed after paint, including the
unarmed one.** That does not weaken AC2, and it is exactly the ticket's own
point — unarmed, the probe's position relative to paint is _uncontrolled_ (the
census caught it pre-paint on `B-b1` only because that boot painted at 28,881 ms).
Armed, the probe is _causally pinned_ after paint by the settle gate, which by
construction cannot release until cards are stable and no requests are in
flight. The claim here is that coupling, not a pre/post-paint count on the OFF
arm — and JELA-822 already owns the measured harm.

**COUNT and ordering claim only.** `fcWall` (8,786–20,570 ms) and total requests
are recorded, not claimed: n is small, loadavg ran 1.69–4.35 across arms, and a
sibling census was running concurrently. The endpoint is a count, which survives
a dirty pre-flight gate (JELA-805).

## 4. AC3 — the audit re-run, and what it caught

Method (JELA-823's own, reused): a shell gate is boot-1-dead only if **both**
the read site is in the shell (runs before the lite→SPA handoff) **and** the key
is channel-seeded. Channel-seeded was determined empirically here, not from the
config: any `jellyfin.shell.*` key present in `lsPost` and absent in `lsPre` on
a fresh profile was written during the boot. That found 34 seeded keys.

Cross-referencing those against every `getItem("jellyfin.shell.*") !== "1"` read
site in the served shell leaves **8** opt-in sites, of which:

- **5 are `*Disabled` keys** — `configEpochDisabled`, `instantHomeDisabled`,
  `instantHomeHoldCoverDisabled`, `lsWriteBehindDisabled`, `txPrimeDisabled`.
  Correct polarity: absent means the feature stays ON. Not affected.
- **2 are not channel-seeded** — `bootFailOverlayClear`, `directHome`. An opt-in
  gate on a non-seeded key is a **dark feature, not a bug**; flipping it would
  silently enable untested code fleet-wide. Do not flip.
- **1 is a real violation** — see below.

### `bitrateCache` is now boot-1-dead, and it was not when this audit first ran

```js
if (localStorage.getItem("jellyfin.shell.bitrateCache") !== "1") return;
```

When JELA-823's audit first ran, `bitrateCache` was correctly classified as a
dark feature — the channel did not seed it. **JELA-817 then flipped it fleet-ON
without flipping its read-site polarity**, which re-created this exact bug class
for a different flag. Measured on a fresh profile, in the same capture that
shows the fixed flag working:

| diag                                                | on boot 1      |
| --------------------------------------------------- | -------------- |
| `window.__shellBT` (`deferBitrateTest`, fixed)      | **present**    |
| `window.__shellBitrate` (`bitrateCache`, not fixed) | **absent**     |
| `bitrateCache` in `lsPre` / `lsPost`                | absent / `"1"` |

A positive and a negative control on one boot. The consequence lands squarely on
this ticket's own territory: a first-install TV has no bitrate cache **and** —
before this fix — no deferral, so it paid the full 5.77 MB on the critical path
twice over. This fix removes half of that; the other half is raised as a child
issue, since flipping a second flag's read site is its own shell change and its
own prod deploy.

**So AC3 passes for the class this ticket owns and fails for one newly-seeded
flag that entered the class after the audit was written.** That is worth stating
plainly rather than scoring the AC green: the audit is only ever true as of the
channel state it was run against.

## 5. Operational notes

**Rollback is `setItem(key, "0")`, never `removeItem`.** After this flip a
key-absent arm is an **ON** arm. Any test wanting an OFF arm must seed `"0"`
explicitly.

**The channel seeder stays as-is.** It guards on `!== "0"`, so it never clobbers
a device's kill switch — confirmed on the wire: the `OFF` arm's `"0"` survived
the boot in `lsPost` on both replicates. The per-TV kill is durable.

**A boot-1 audit must be re-run after any flag goes fleet-ON.** `bitrateCache`
is the proof: the audit was correct when written and stale within the day.

Rig + captures: `/tmp/jela823-rig-d856ac39/out/{ABSENT,SEED1,OFF}-r*-boot.json`,
driver `run823.mjs` (out of git per JEL-141).
