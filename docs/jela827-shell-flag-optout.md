# JELA-827 — five channel-seeded shell flags were dead on the first boot

**Status:** code merged-ready (PR #249, 5 commits). All three acceptance
criteria PASS on the M63 rig. Fleet deploy (publish the shell) is a separate
board decision.

Follow-up to JELA-821 (`deferJe`) and JELA-823 (`deferBitrateTest`). Same bug
class, five more flags.

## The bug class

A shell gate is boot-1-dead when **both** hold:

1. the read site is **in the shell**, so it runs before the lite→SPA handoff, and
2. the key is **channel-seeded** — the JSI channel writes it, i.e. fleet-ON.

The channel only runs _after_ the handoff (JELA-802). On a first install, a
localStorage wipe or a quota eviction the key is absent when the shell reads it,
the fail-closed branch is taken, and the fleet-ON feature does nothing for that
entire boot. Every post-flip measurement ever taken on these flags was a warm
boot, which is why they all looked correct.

`flagDefaults` cannot repair this — that map is itself cached one boot behind by
contract, so it is absent on a true first boot too (JELA-819 rejected exactly
this for `deferJe`).

## The five flags

| flag            | shipped under  | before            | after             |
| --------------- | -------------- | ----------------- | ----------------- |
| `diagBeacon`    | JELA-30 / 34   | `!=="1"` → bail   | `==="0"` → bail   |
| `ytApiStub`     | JELA-725       | `!=="1"` → bail   | `==="0"` → bail   |
| `homeResume`    | JELA-753 / 789 | `!=="1"` → bail   | `==="0"` → bail   |
| `udcGate`       | JELA-761 / 807 | `!=="1"` → bail   | `==="0"` → bail   |
| `lsWriteBehind` | JELA-776 / 806 | `==="1"` → enable | `!=="0"` → enable |

`lsWriteBehind` uses the `==="1"` **assignment** form rather than an early
return. A grep for the `!=="1"` bail shape misses it entirely — worth
remembering the next time this audit is run.

`homeResume`'s seeder header had already written the defect down as expected
behaviour: _"The shell reads the key BEFORE this channel executes, so the seed
takes effect on the NEXT boot."_ It was filed as a deploy-verification caveat,
not as a bug.

## Seeding was re-derived, not trusted

The "these five are fleet-ON" claim was verified against the live channel rather
than the repo. Every one of the **106 enabled** `CustomJavaScripts` entries was
executed in a `node:vm` against a stub `localStorage`, recording what each entry
actually writes (the JELA-816 precedent: prove a channel entry by executing it).

That yields **13** seeded `jellyfin.shell.*` keys, including all five targets. It
also independently confirms the out-of-scope list: `bitrateCache`, `directHome`
and `bootFailOverlayClear` are read fail-closed in the shell but are **not**
seeded, so flipping them would silently enable untested code fleet-wide. They
are untouched.

A regex over the config text finds only 2 of the 13 — most seeders bind the key
to a local (`var k="…"; setItem(k,"1")`). **Do not audit this with a grep.**

## AC3 — the audit, with a negative control

The audit cross-references every `getItem("jellyfin.shell.*")` comparison in the
**built min** against the executed-seeder key set. Its classifier is deliberately
over-inclusive — it also flags `*Disabled` kill switches, which are correct
polarity — so a zero is a superset claim.

```
patched shell.min.js        AC3: PASS — 0 violations
patched boot-shell.min.js   AC3: PASS — 0 violations
base f1c1d4c shell.min.js   AC3: FAIL — 5 violations
    lsWriteBehind === "1"   ytApiStub !== "1"   udcGate !== "1"
    homeResume !== "1"      diagBeacon !== "1"
```

The base run names exactly the five ticket flags, no more and no fewer. Without
that negative control a PASS would be indistinguishable from an audit that
stopped looking (JELA-813: a truncated capture looks like a perfect result).

## AC1 / AC2 — the rig

Real widget bootstrap booted from `file://` on the pinned Chromium 63 harness,
with HSB repointed at a locally-served **patched** `shell.min.js` (JELA-821
recipe: seed `hsbCachedHash` + `hsbCachedShellUrl` + `hsbShellLsDisabled=1`).
`/web/`, the API and the live JSI channel all stay on the real server. Fresh
chrome process and fresh `--user-data-dir` per arm — JELA-719: the
no-HTTP-cache rule is per PROCESS, not per boot.

Three arms, all five keys set together, one pre-nav difference:

| flag            | ABSENT (cold boot)           | SEEDED `"1"` (fleet today) | KILL `"0"`     | AC1  | AC2  |
| --------------- | ---------------------------- | -------------------------- | -------------- | ---- | ---- |
| `udcGate`       | `__shellUdc` `{on:1}`        | `{on:1}`                   | absent         | PASS | PASS |
| `homeResume`    | `__shellHR` `{on:1}`, hook 1 | `{on:1}`, hook 1           | absent, hook 0 | PASS | PASS |
| `diagBeacon`    | armed                        | armed                      | inert          | PASS | PASS |
| `ytApiStub`     | stub + `YT.Player`           | stub + `YT.Player`         | absent         | PASS | PASS |
| `lsWriteBehind` | `__shellLsWB` object         | object                     | absent         | PASS | PASS |

**AC1** is ABSENT ≡ SEEDED. **AC2** is KILL ≠ SEEDED with the feature off,
proving each gate is still live and not merely deleted.

Provenance gated three ways on every arm, all PASS: the driver refuses to start
unless the bytes it is about to serve carry all five opt-OUT expressions and
none of the five opt-in ones; the boot fetched the local URL 200 with the sha in
the query; and `prodShellFetched === 0`.

### Negative control — the rig can see the bug

The same three-arm driver, re-pointed at the **unpatched** `f1c1d4c`
`shell.min.js` (with its GATE1 inverted so it refuses to run unless the bytes
carry the five _opt-in_ expressions):

| flag            | BASE_ABSENT    | BASE_SEEDED (control) | boot-1 bug |
| --------------- | -------------- | --------------------- | ---------- |
| `udcGate`       | absent         | `{on:1}`              | reproduced |
| `homeResume`    | absent, hook 0 | `{on:1}`, hook 1      | reproduced |
| `diagBeacon`    | inert          | armed                 | reproduced |
| `ytApiStub`     | absent         | stub installed        | reproduced |
| `lsWriteBehind` | absent         | object                | reproduced |

All five are dead on a cold boot of the shipped shell and alive on a warm one.
This is the measurement that makes the ABSENT column above mean something.

### Two rig bugs worth not repeating

Both produced a **false OFF in every arm, including the positive control** —
the failure mode that reads as a result rather than as a broken harness.

1. **The wait loop exited on the first signal.** `installLsWriteBehind` runs at
   the top of the shell, so "any flag went true" was satisfied ~5 s in, long
   before the lite→SPA handoff that installs the other four. Wait on the
   **handoff**, never on the thing under test.
2. **No `jellyfin_credentials` seeded.** The SPA parked on login, the written
   document was never built, and the four shims that live in it never installed.

Both times the SEEDED arm — the positive control — was also off. **A capture
where the positive control is dark is void, not negative.**

## Operational notes

**Rollback is `setItem(key,"0")`, never `removeItem`.** After the flip a
key-absent arm is an ON arm. The `jsi-jp806/807-patch.mjs` rollback bodies
already write `"0"`; they are now mandatory rather than a convenience.

**Durable per-TV kills** — `homeResume`, `udcGate`, `lsWriteBehind`. Their
seeders guard on `!== "0"`, so a `"0"` survives the channel. `lsWriteBehind`
additionally keeps `lsWriteBehindDisabled`.

**Two kills are NOT durable:**

- `ytApiStub` — its seeder guards on `ytApiStubDisabled`, so it rewrites `"1"`
  over a per-TV `"0"`. The durable kill is `ytApiStubDisabled="1"`, intact.
- `diagBeacon` — its seeder guards on `!== "1"`, so it rewrites `"1"` over a
  `"0"` and there is currently **no** durable per-TV kill. This is not a
  regression: the same seeder also rewrote a _removed_ key. The fix is a
  one-word channel edit — guard on `!== "0"` like jp789/jp806/jp807 — and is
  raised with the deploy request rather than done here, since editing the live
  channel is a production change.

**`lsWriteBehind` diverges from JELA-823 deliberately:** a _throwing_
localStorage still leaves it OFF. It monkey-patches `Storage.prototype`, and an
engine whose localStorage cannot be read is the one case to stand down on rather
than wrap. Only the key-absent path flipped.

`diagBeacon` is the only one of the five that changes network egress rather than
deferral. The target is still the user's own server, the body is still numeric
ring/tx counters plus an opaque fnv1a id, `DiagIngestService` still re-sanitizes,
and `DisableDiagIngest` still refuses server-side.

## Repo state at the time of this work

The work was first built on `f1c1d4c`, where two guards were red — `config-epoch`
(4 checks) and prettier on `shell.js` / `boot-shell.src.js`. Both were
pre-existing; I diffed the `config-epoch` failure list against base and it was
byte-identical, and I deliberately did not reformat the two sources so the diff
stayed surgical.

`main` then moved to `17473c0` ("CI: make main green again"), which fixed both.
The series was replayed onto that base — all five patches applied three-way
cleanly, and the rebuilt `shell.min.js` is **byte-identical** (sha
`a171f117…0034c4`, 246,435 B) to the artifact the rig booted, so every
measurement above still describes the shipped bytes. All four package suites
now pass.

One rebase hazard worth recording: the first replay silently produced commits
with a STALE `shell.min.js`. The worktree's `node_modules` symlink disappeared
mid-run, `build_shell_min.py` fell back to a PATH `esbuild` that does not exist,
and the failure scrolled past under `set -e` inside a loop while
`build_boot_shell.py` (which resolves its own path) kept succeeding. The replay
was redone with an explicit `[ -x node_modules/.bin/esbuild ]` gate and a
`verify_shell_src.py` call after every single commit. **A generated artifact
that fails to regenerate looks exactly like one that did not need to.**

Rig: `/tmp/jela827-rig-*` (`run827.mjs` + `run827base.mjs`, out of git per
JEL-141).

---

# Rollout record — LIVE in production 2026-08-31

Board approved on interaction `9c1a7fc3-caeb-463d-ab2b-70b6344e7113` (accepted
17:57Z). The accept carried no option id, so it is read as approving the card as
written — both actions.

## 1. Shell published as server-plugin v1.0.45.0

`0c6bbd3` (PR #251) bumped `<Version>`; `release-server-plugin` is
**dispatch-only**, so the release was triggered by hand with
`confirm_version=1.0.45.0` rather than firing on the merge. Release
`server-plugin-v1.0.45.0` at 18:13Z, then `POST /Packages/Installed/…` →
`1.0.44.0 Superseded | 1.0.45.0 Restart` → `POST /System/Restart` → ~100 s of
502 → `1.0.45.0 Active`.

Verified on the wire, hashing the SERVED body rather than trusting the version:

```
GET /shell/shell.min.js  200  246,435 B
sha256 a171f117…0034c4   ==  repo packages/shell-tizen/src/shell.min.js
udcGate / homeResume / diagBeacon / ytApiStub / lsWriteBehind
    opt-OUT sites = 1 each,  opt-in sites = 0 each
```

## 2. diagBeacon seeder guard repaired in the live channel

The JELA-34 entry guarded `!== "1"`, so it rewrote `"1"` over a per-TV `"0"` and
the kill switch survived only the boot it was set in. Changed to `!== "0"`,
matching jp789/jp806/jp807.

Sequence, per the JSI hazards: re-fetched the config **immediately** before
patching — the entry count had moved 106 → 108 while this ticket was in flight,
so a stale body would have deleted two sibling entries — proved the patched
seeder's polarity in `node:vm` (absent → `"1"`, `"1"` → `"1"`, `"0"` → stays
`"0"`, non-Tizen → no write), POSTed twice, then verified the **served** bundle:

```
GET /JavaScriptInjector/public.js  200  921,989 B
  !== "0" guard : 1 site      !== "1" guard : 0 sites
```

Note the path is `/JavaScriptInjector/public.js` (capital S, capital I), not
`/web/public.js` — the latter is a 404.

## 3. Post-deploy cold boot on the REAL fleet path

The acceptance above booted a locally-served shell. This one drops the
`hsbCached*` seeds entirely so HSB discovers the shell through prod's own
manifest — a local-shell acceptance proves the build, not the fleet.

All five keys `null` pre-nav on a fresh profile, 68 requests, SPA reached:

| flag            | cold boot, nothing seeded                    |
| --------------- | -------------------------------------------- |
| `udcGate`       | **ARMED** — `__shellUdc {on:1}`              |
| `homeResume`    | **ARMED** — `__shellHR {on:1}`, chunk hook 1 |
| `diagBeacon`    | **ARMED**                                    |
| `ytApiStub`     | **ARMED** — stub + `YT.Player`               |
| `lsWriteBehind` | **ARMED** — `__shellLsWB` object             |

The shell came off `…/shell/shell.min.js?t=1788200384` — HSB's timeout-fallback
path, whose URL carries **no sha at all** (the JELA-821 trap that fakes a
provenance failure). Provenance here rests on the independent `sha256` of the
served body above, not on the request URL.

## Rollback

Per-flag, no republish: set the key to `"0"` in the channel. **Never
`removeItem`** — an absent key now means ON. All five kills are now durable;
`diagBeacon`'s became durable with item 2 above.
