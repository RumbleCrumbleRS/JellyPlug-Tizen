# JELA-815 — fleet flip of `jellyplug.rows.viewgate`

Rollout half of **JELA-815** (implementation merged flag-dark in PR #241, squash
`cd86bbf`; design and dark A/B in [`jela815-rowviewgate.md`](./jela815-rowviewgate.md)).
The genre-row fetch burst — 14 candidate queries, 28 requests with preflights,
landing at document y = 3,437 px — now waits until the user scrolls toward it.

Board approved the flip on 2026-08-31 (interaction
`c97da66e-66ef-4ce8-86e7-dbec38c12c47`).

| flag                      | kill switch (per-TV)  | fail-open belt            |
| ------------------------- | --------------------- | ------------------------- |
| `jellyplug.rows.viewgate` | same key set to `"0"` | 800 polls x 750 ms ≈ 10 m |

## 1. What was deployed

JSI channel entry **`JellyPlug — rowViewGate default-ON (JELA-815)`**, appended
under the [`jsi-config-write-race`] + [`jsi-config-save-off-by-one`] discipline:
fresh base fetched immediately before the POST, fail-closed structural gate on
that base, POST, deep-equal re-GET, served-bundle byte-verify.

```js
// seeder — currently live (marker: jp815seed)
/*jp815seed*/ (function () {
  try {
    var k = "jellyplug.rows.viewgate";
    if (localStorage.getItem(k) !== "0") {
      localStorage.setItem(k, "1");
    }
  } catch (e) {}
})();
```

| step                                   | result                                      |
| -------------------------------------- | ------------------------------------------- |
| config entries                         | 105 → **106**                               |
| POST status                            | `204`                                       |
| re-GET vs POSTed body                  | **deep-equal** — no concurrent clobber      |
| served `/JavaScriptInjector/public.js` | 913,463 → **913,815 B**, `jp815seed` **x1** |
| `node:vm` parse of the bundle          | OK                                          |

It landed on the **first** POST this time. That is not a contradiction of the
"it took three" note in the dark-deploy doc — the rule is _POST until the served
artifact carries your bytes_, and the loop in `flip815.mjs` re-fetches a fresh
base and re-verifies the served artifact on every iteration, so it stops at one
when one is enough.

### The structural gate refuses to seed a flag nothing reads

The [JELA-807] trap is a seeder shipped against a reader that can never see the
key. `flip815.mjs` fails closed unless the base config still contains
`n.rowViewGate=` in `tizen-compat`, `jpG815.hold` in `genre-rows`, the flag key
itself, and four live sibling seeders. A decayed sibling marker is a _question_,
not an answer ([JELA-773]) — but it is checked before anything is written.

## 2. Polarity, proven against the served bytes

Both halves extracted from the live `public.js` and run in `node:vm`
(`polarity815.mjs`) — the JELA-806 rule of proving polarity with the **served**
seeder rather than the source. The reader's key literal is extracted from the
served bytes too; hoisting a hand-typed key into the harness would prove nothing
about what the fleet actually reads.

```js
// reader, extracted from the served tizen-compat body
var F = "jellyplug.rows.viewgate",
  P = 750,
  MX = 800,
  LK = 1080;
function on() {
  try {
    return !!(s.localStorage && s.localStorage.getItem(F) === "1");
  } catch (e) {
    return !1;
  }
}
```

| pre-existing value | armed this boot | armed next boot | meaning                         |
| ------------------ | --------------- | --------------- | ------------------------------- |
| absent             | `false`         | **`true`**      | fleet default arms              |
| `"0"`              | `false`         | `false`         | per-TV kill switch is respected |
| `"1"`              | `true`          | `true`          | idempotent                      |

Note the gate is `==="1"`, so it fails **closed** — only the exact string arms
it. Audit such a gate by **key**, never by counting substring occurrences
(JELA-770): the served bundle contains `viewgate` in the seeder, in the gate,
and in this entry's own comment.

### Arming is NOT one boot late here — and that was worth measuring

Static reading says it should be. The flag is read inside `genre-rows`' `Z()`,
`genre-rows` is entry 13, and the seeder is entry 106 — so the read looks like
it precedes the write, which is the [JELA-807] "seed arms one boot late" shape
every prior flip in this series has had.

It does not happen. On a wiped profile, boot 1 recorded `flagPreNav=null`, an
`lsPre` census with no such key, an `lsPost` census with `"1"` — **and
`genreGetsBoot=0`**. The gate was armed and holding on the very boot that seeded
it.

The reason is that entry 13's inline `Z()` call **early-returns**: it needs an
`ApiClient` user id, and there is none yet when the channel body executes. The
`Z()` that actually reaches the gate arrives later, from the mutation observer
and the JELA-745 `rowPrefetch` arm — by which time entry 106 has long since run.

This is a benign race, and it is worth stating which way it can fail: if `Z()`
ever _did_ win (user id already resolved at entry-13 time), `on()` would read
`null`, the burst would fire, and that TV would get **today's shipped
behaviour** for one boot before latching. The failure mode is "no improvement
yet", never a missing row. Both orderings are safe, so this is not something the
flip has to defend against — but the acceptance below is still a **two-boot**
proof on one profile (JELA-789, JELA-790), because the latched steady state
is the state almost every TV in the fleet will actually be in.

## 3. Post-flip acceptance on the rig

Three boots against the **live** channel on the JELA-112 virtual Tizen 5.0 rig,
prod shell `d41a3d7a`, `shellProvenanceOk` in all three, `invalid: null` in all
three. Nothing about the flag is seeded by the rig in the two `FLEET` arms —
whatever the channel does is what is measured.

| arm        | profile      | `flagPreNav` | gate                | genre GETs at boot | home-row reqs / bytes | reqs | cards | secs |
| ---------- | ------------ | ------------ | ------------------- | ------------------ | --------------------- | ---- | ----- | ---- |
| `FLEET/b1` | wiped        | `null`       | `flag=true held=1`  | **0**              | 60 / 261,806 B        | 480  | 98    | 9    |
| `FLEET/b2` | **reused**   | **`"1"`**    | `flag=true held=1`  | **0**              | 26 / 203,384 B        | 408  | 114   | 10   |
| `KILL/b1`  | wiped, `"0"` | `null` → `0` | `flag=false held=0` | **14**             | 84 / 327,802 B        | 504  | 258   | 17   |

**The two-boot arm proof (JELA-789/790).** Boot 1 starts virgin and the channel
seeder writes the key; boot 2 reuses that **same profile dir** with
`J815_KEEP_FLAG=1`, so the rig does not strip and does not re-seed. Boot 2 read
`flagPreNav="1"` before navigation — the seeder's write survived a browser
restart and armed the gate from disk. That is the state essentially every TV in
the fleet will be in from its second boot onward.

`held=1` is the load-bearing evidence, **not** `genreGetsBoot=0` on its own: a
truncated capture also reads zero (JELA-813). The gate reporting that it held is
the thing that distinguishes "deferred" from "never happened".

**AC4, the kill switch, as a differential against the live seeder.** The `KILL`
arm strips the key pre-nav and then explicitly writes `"0"`, so the control is a
removal-plus-write rather than an assumption about the channel. The gate read
`flag=false`, never held, and all 14 genre queries fetched at boot for
90,521 B — 258 cards and 17 sections, which is the JELA-813 shipped baseline
exactly. 504 total requests sits inside the 498–512 cold band.

The seeder did **not** clobber the `"0"`. Verified from disk by a second process
after the browser exited (JELA-748/805 — a late-boot write is not persistence
until another process can read it):

```
prof-KILL/Local Storage/leveldb/000003.log @ 785449
  _http://127.0.0.1:8815 \x00\x01 jellyplug.rows.viewgate \x02\x01 0
```

**What the armed arms give up at rest, stated plainly.** `FLEET` ends its boot
at 9–10 sections and 98–114 cards, against `KILL`'s 17 and 258. That is the
lever working as designed, not a regression — the genre rows are not built until
the user scrolls toward them, and the dark A/B scroll arms already showed the
scrolled home converging on 19 sections / 290 cards / `scrollTop` 6,641 of 7,181,
identical to the JELA-813 baseline (AC2). It does mean **no cold-boot count from
an armed arm is comparable to a cold baseline that built all 17 rows**, which is
why AC3 rests on the 5-boot dark A/B (505.5 → 476.7) and not on the 480 above.

Both post-flip boots ran at `loadavg` 15–16 with two sibling rigs on the box, so
every number here is scoped as a **count** claim. No timing is quoted from them
(JELA-805: a count claim survives a dirty pre-flight gate A, a timing claim does
not).

## 4. Re-verified at close

A sibling deploy landed after the flip, so the served artifact was re-checked
before closing rather than trusted from deploy time (JELA-818 — a config
round-trip is not a deploy, and a sibling clobbered an entry 6 minutes later
once):

| check                                        | at deploy | at close               |
| -------------------------------------------- | --------- | ---------------------- |
| served `public.js`                           | 913,815 B | **917,652 B** (grew)   |
| `jp815seed`                                  | x1        | **x1** — intact        |
| `rowViewGate`                                | x7        | **x7**                 |
| sibling `jp710` (JELA-814 self-hosted fonts) | x2        | **x2** — still present |
| `node:vm` parse of the whole bundle          | OK        | **OK**                 |

The growth is another team's appended entry, not a change to ours: our seeder is
still the last entry in the bundle and byte-identical to what was POSTed. The
parse re-check is the point of doing this at close — a sibling append that threw
a `SyntaxError` would take down **every** entry in the channel, including a
perfectly good one of ours.

## 5. Rollback

`node flip815.mjs --rollback --execute` swaps the entry's `Script` for a
**remover**:

```js
// remover — rollback payload (marker: jp815rollback)
/*jp815rollback*/ (function () {
  try {
    var k = "jellyplug.rows.viewgate";
    if (localStorage.getItem(k) === "1") {
      localStorage.removeItem(k);
    }
  } catch (e) {}
})();
```

Deleting the entry is **not** a rollback for a seeded flag (JELA-789): it
would strand every TV latched ON with no way to clear the key.

This supersedes §7 of the dark-deploy doc, which anticipated a rollback that
writes `"0"`. A remover is better: `"0"` is the per-TV kill switch, and writing
it fleet-wide would latch every TV into a state the seeder itself refuses to
overwrite, so a later re-flip would need a second corrective deploy. The remover
returns TVs to the shipped default and leaves an explicit user `"0"` alone.

`flip815.mjs` and `polarity815.mjs` live in the run scratch directory, which is
**not durable** ([`workspace-not-durable`]), so both payloads are reproduced
above in full. Deploy either by editing the `Script` of the
`JellyPlug — rowViewGate default-ON (JELA-815)` entry in the JSI plugin config,
POSTing until the served `public.js` carries the marker, then byte-verifying.

[`jsi-config-write-race`]: ./jela773-deferje-rollout.md
[`jsi-config-save-off-by-one`]: ./jela815-rowviewgate.md
[`workspace-not-durable`]: ./jela773-deferje-rollout.md
[JELA-773]: ./jela773-deferje-rollout.md
[JELA-807]: ./jela809-udcgate-two-boot-proof.md
