# JELA-811 — two-boot proof of the jp773 `deferJe` fleet flip

**Date:** 2026-08-30 · **Parent:** JELA-773 · **Verdict: AC1–AC3 all PASS.**
14 valid boots across 5 fresh profiles, against live production bytes. Arm state
was a pure function of the pre-navigation key in **14/14** valid boots.

No rollback indicated.

---

## 1. What was under test

JELA-773 shipped the fleet default-ON for `jellyfin.shell.deferJe` as a JSI
channel entry (config 104 → 105, commit `0cab828`, doc
`docs/jela773-deferje-rollout.md`). That evidence was a byte-verified served
bundle plus a `node:vm` polarity proof.

Per JELA-790 a served bundle **does not** prove a seeder, and per JELA-789 a
seeded shell flag needs a **two-boot arm proof**. The open question was
delivery: does a real browser, booting the real shell, actually reach
`deferJe="1"` through the channel — and then arm on the _next_ boot and defer
the JE bootstrap past first paint?

The shell reads the key **before** the channel executes, so the flip is
inherently a next-boot property. Boot 1 must seed and stay unarmed; boot 2 must
arm. That is the whole claim.

## 2. Re-verification of the served artifacts (at the wire, this session)

Re-checked rather than cited — a JSI config POST replaces the **whole** entry
list, so a sibling agent's deploy can silently drop an entry.

**A sibling agent published a new shell and a new `public.js` in the middle of
this run.** Both were re-verified; the flip survived both deploys intact.

| artifact                        | before (P1, P2 boots)                                                         | after (P3–P5 boots)                                                           |
| ------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `/shell/shell.min.js`           | `8724caf369089db93c83ab4e9a134cbd2b775413c7c51e3d37db1e43bcc9521b`, 243,199 B | `d41a3d7a7b47d809abed913ba78269ef01bcec047c4eadaff7dfbbe6c5b10025`, 245,390 B |
| gate present (audited BY KEY)   | `jellyfin.shell.deferJe` ×1 (+ unrelated `deferJeMs` ×1), `__shellJeDefer` ×2 | identical: `deferJe` ×1, `deferJeMs` ×1, `__shellJeDefer` ×2                  |
| `/JavaScriptInjector/public.js` | `d57b7087…`, 907,657 B                                                        | `63a82467…`, 909,572 B                                                        |
| seeder present                  | `jp773seed` ×1, alongside 14 sibling markers (15 distinct)                    | unchanged: `jp773seed` ×1, all 15 distinct markers intact                     |

The served jp773 entry, verbatim:

```js
(function () {
  try {
    var k = "jellyfin.shell.deferJe";
    if (localStorage.getItem(k) !== "0") {
      localStorage.setItem(k, "1");
    }
  } catch (e) {}
})();
```

The `!=="0"` guard is the per-TV kill switch, and AC3 exercises it directly.

**Audit BY KEY, never by substring.** `grep -c deferJe` on the served shell
returns 2; only one of them is the flag. The other is `deferJeMs`, an unrelated
tunable. JELA-773 hit this same trap.

## 3. Method

`boot811.mjs`, **one boot per invocation**, state carried on disk between
invocations — that persistence is the thing under test. Lineage: two-boot
discipline and the pre-nav assertion from JELA-809's `boot809.mjs`; the
real-app instrument (HSB bootstrap → production `/shell/` → real `/web/` → real
JSI channel) and the `jePre`/`jeReqs`/`jeTags` endpoint from JELA-773's
`run773.mjs`.

**The harness never writes `deferJe`, in any arm.** Boot 1 asserts the key is
`null` before navigating and throws otherwise, so a `"1"` reading can only have
come from the served seeder.

Three things the inherited harnesses do that are deliberately **not** done here:

1. `jsiChannelDisabled=1` — the channel **is** the delivery mechanism under test.
2. HSB's localStorage shell-body cache — prod now serves the gate-carrying
   build, so seeding an unpublished body would stop this being a proof of the
   live flip.
3. A pinned expected shell sha — see §5.2.

Seeded keys are only what makes the rig a logged-in TV (`serverUrl`,
`jellyfin_credentials`, `enableAutoLogin`, `_deviceId2`) plus `liteEnabled=0`,
which is inherited from JELA-773's own pre-registration: lite is a second,
independent `firstCard` producer, and with it on, `.card` from the lite page
sets `fcWall` early and `jePre` stops meaning "pre-paint JE requests" at all.

**Endpoint is a COUNT claim**, so it survives a dirty pre-flight gate A
(JELA-805). JELA-773 AC1 already owns the −2,110 ms number; nothing here
re-litigates it, and no timing claim is made.

## 4. Results

### AC1 — boot 1 on a fresh profile seeds, and stays unarmed

| boot     | shell      | preFlag | postFlag | armed | `jeBootPre` | `jePre` | `jeTags` |
| -------- | ---------- | ------- | -------- | ----- | ----------- | ------- | -------- |
| P1 boot1 | `8724caf3` | `null`  | `"1"`    | false | –           | 194     | 152      |
| P2 boot1 | `8724caf3` | `null`  | `"1"`    | false | –           | 24      | 152      |
| P3 boot1 | `d41a3d7a` | `null`  | `"1"`    | false | –           | 173     | 152      |
| P4 boot1 | `d41a3d7a` | `null`  | `"1"`    | false | **1**       | 173     | 152      |
| P5 boot1 | `d41a3d7a` | `null`  | `"1"`    | false | **1**       | 173     | 152      |

**5/5 PASS.** The seeder delivers end-to-end on a real boot, on both shell
builds, and the seeding boot itself is correctly still unarmed.

### AC2 — the next boot arms, with no seeding help

| boot     | shell      | preFlag | armed | `__shellJeDefer`   | `jeBootPre` | `jePre` | `jeTags` | `jeReqs` |
| -------- | ---------- | ------- | ----- | ------------------ | ----------- | ------- | -------- | -------- |
| P2 boot2 | `8724caf3` | `"1"`   | true  | held:1 rel:1 inj:1 | –           | 6       | 153      | 178      |
| P2 boot3 | `8724caf3` | `"1"`   | true  | held:1 rel:1 inj:1 | –           | 0       | 153      | 170      |
| P3 boot2 | `d41a3d7a` | `"1"`   | true  | held:1 rel:1 inj:1 | –           | 0       | 153      | 173      |
| P4 boot2 | `d41a3d7a` | `"1"`   | true  | held:1 rel:1 inj:1 | **0**       | 0       | 153      | 179      |
| P5 boot2 | `d41a3d7a` | `"1"`   | true  | held:1 rel:1 inj:1 | **0**       | 0       | 153      | 171      |

**5/5 PASS** on the scored set, with the full post-paint fan-out intact
(153 JE tags, 170–179 JE requests — JELA-773's ring reported ~153 tags /
180–182 requests). A sixth armed boot, **P1 boot2** (`jePre=0`, `jeTags=153`,
held:1 rel:1 inj:1), is excluded from the count only because it tripped a
validity gate this run later **retracted** — see §5.1. Including it the result
is 6/6.

### AC3 — differential: ONE key changed pre-navigation, everything else inherited

| boot     | pre-nav action | preFlag | postFlag | armed | `__shellJeDefer` | `jePre` | `jeTags` |
| -------- | -------------- | ------- | -------- | ----- | ---------------- | ------- | -------- |
| P1 boot3 | `removeItem`   | `null`  | `"1"`    | false | **ABSENT**       | 198     | 152      |
| P4 boot3 | `removeItem`   | `null`  | `"1"`    | false | **ABSENT**       | 11      | 152      |
| P1 boot4 | set `"0"`      | `"0"`   | `"0"`    | false | **ABSENT**       | 38      | 152      |
| P5 boot3 | set `"0"`      | `"0"`   | `"0"`    | false | **ABSENT**       | 124     | 152      |

**4/4 stayed unarmed.** Both `"0"` arms still read `"0"` _after_ a boot in which
the channel demonstrably ran (§5.1 canary) — the seeder's `!=="0"` guard holds, so the
per-TV kill switch is real and durable, not merely single-boot.

### The sharpest statement the data supports

> `armed === (preFlag === "1")` in **14/14** valid boots.

Zero mismatches across 5 profiles, 2 shell builds, and 3 pre-nav arms.

### The matched pairs, in the lever's own units

`jePre` counts **anything** on the JellyfinEnhanced origin. The lever only
defers the one `<script>` the shell holds out of the written markup — confirmed
at runtime as `__shellJeDefer.urls === ["../JellyfinEnhanced/script?v=…"]`.
`jeBootPre` counts that bootstrap alone, and it is arm-independent:

| profile | boot 1 (unarmed) | boot 2 (armed) |
| ------- | ---------------- | -------------- |
| P4      | `jeBootPre=1`    | `jeBootPre=0`  |
| P5      | `jeBootPre=1`    | `jeBootPre=0`  |

Consecutive boots, same profile, one thing different: the key the channel
seeded. The JE bootstrap moves from pre-paint to post-paint. That is the flip.

## 5. Findings that outlived the ticket

### 5.1 "Was the channel FETCHED?" is the wrong instrument on a warm profile

Boot 2 initially failed a gate requiring `/JavaScriptInjector/public.js` in the
request log. It was not a dead channel: boot 1 populates the shell's own
transpile cache (`shell.tx1t1at4s:…/JavaScriptInjector/public.js?v=…`,
JELA-799/800), so a warm boot runs the channel with **zero network requests**.

The gate was replaced with a **positive control for execution**: remove a
_different_ key that a sibling entry re-seeds unconditionally (jp807's
`udcGate`) immediately pre-navigation, and require it back afterwards. This
proved its worth immediately — P1 boot3 recorded `chanRan=true` with
`chanFetched=false`, which is exactly the state the old gate misread as failure.

**Rule: prove a channel RAN by an effect it writes, never by a request it makes.**

### 5.2 Never pin an expected shell sha as a constant

A sibling agent published a new shell (`8724caf3` → `d41a3d7a`, 243,199 →
245,390 B) **between two boots of this run**. A hardcoded sha would have failed
provenance on a perfectly good boot — or, after the next deploy, silently passed
a boot running bytes nobody verified.

The harness now reads `/shell/manifest.json` per boot and records the sha the
boot **actually ran** (from the cache-busted `?v=` URL, or HSB's self-reported
replay sha). Provenance is `ranShellSha === prodShellSha`, evaluated per boot.

Related: `/shell/manifest.json` reports `version: "1.0.90"` for **both** builds.
**The version string is not a build identity — compare shas.**

### 5.3 A relative-vs-absolute URL comparison gives a FALSE ZERO

The shell stores held URLs exactly as they appeared in the markup — relative
(`../JellyfinEnhanced/script?v=…`) — while the CDP request log is absolute.
The first version of the matcher compared them raw and reported
`jeHeldTotal=0`, which looks indistinguishable from a perfect result. Both
sides must be normalised to an origin-less, query-less path.

**Any metric whose failure mode is "0" needs a positive control that makes it
non-zero.** Here that was the unarmed arm: it must report `jeBootPre=1`, and a
matcher that cannot produce a 1 anywhere is broken, not passing.

### 5.4 `jeBootPre` is only meaningful when `jeBootTot >= 1`

Warm boots sometimes replay the JE bootstrap from the shell's transpile cache
too (`jeBootTot=0`, e.g. P4 boot3, P5 boot3). Then there is no request to time
and a `0` means "never fetched", not "deferred". The scored matched pairs in §4
are restricted to boots where `jeBootTot >= 1`. The unambiguous, always-present
readout is `__shellJeDefer` itself: present with `held/rel/inj` when armed,
absent when not.

### 5.5 JELA-750 profile poisoning reproduced, with a sharp numeric signature

Profiles die after ~3–5 boots. Healthy boots on this rig log **400–537**
requests; a poisoned profile logs **~118** with 0 cards, 1 JE request, and no
channel execution — at _low_ load, which rules out starvation. Retrying in place
never recovers it; **only a new profile dir does** (P3 failed 3× consecutively,
P4 was fine on the first try). The harness now fails any boot with
`reqsTotal < 200`.

### 5.6 A fixed linger silently truncates the fan-out under load

At loadavg 14–19 (a sibling rig pinning the shared box) a boot completed every
other gate but landed **4** JE tags instead of 153 — an armed boot that would
have _understated_ the very fan-out AC2 asserts. Added a load gate (wait for
loadavg ≤ 6) and an explicit fan-out floor. Per JELA-682, the shared box is the
default hazard, not the exception.

### 5.7 `jePre` is a superset, and one armed boot shows a non-zero residue

P2 boot2 armed correctly yet reported `jePre=6`. Those requests are JE
**sub-modules** (`js/enhanced/themer.js`, `ui-styles.js`, `settingspanel/*`) on
the JellyfinEnhanced origin, not the deferred bootstrap. In **every** armed
boot the deferred injection landed 3.3–4.3 s _after_ `firstCard`
(`tInj − fcWall`), so nothing the lever controls was pre-paint.

**Report the lever's own endpoint, not an origin-wide proxy that happens to
correlate.** JELA-773's `jePre=0 in 8/8` used fresh profiles every boot, where
the proxy and the endpoint coincide; on warm profiles they diverge.

### 5.8 The environment variable trap flips per session

JELA-736/808 record `JELLYFIN_URL` as the trap and `JELLYFIN_SERVER_URL` as the
correct name. **In this session it was the exact opposite**: `JELLYFIN_URL` was
set and `JELLYFIN_SERVER_URL` was empty. Read both with a fallback and never
inherit the polarity from a previous ticket.

## 6. Coverage actually achieved

22 boots run: **14 valid and scored**, 7 quarantined and listed rather than
dropped silently — 4 profile-poisoned (§5.5), 2 load-starved (§5.6), 1 vacuous
zero-card boot. The 22nd (P1 boot2) is retained but excluded from the AC2 count
under the retracted gate of §5.1.

The Q60R panel leg is **not** covered here and was not attempted. Per JELA-809
the M63 rig runs the live JSI channel end-to-end, so a public seeder's last mile
does not need a panel; JELA-802 separately confirmed a Samsung panel executes
`public.js` for sibling entries.

## 7. Reproducing

`boot811.mjs` (rig `/tmp/jela811-rig`, one boot per invocation) and the offline
scorer `an811.py` are stored base64 in a JELA-811 issue comment, per
`workspace-not-durable`. Both are generic for any seeded-shell-flag two-boot
proof — change the flag name, the canary key, and the bootstrap regex.

```
node boot811.mjs <profileTag> <bootIndex> <wipe:0|1>
env J811_PRENAV = inherit | remove | zero
    J811_LOADMAX (default 6), J811_LINGER_MS (default 25000)
python3 an811.py
```

Needs `/tmp/jela811-rig/{srv/,auth.json}`, with `srv/` copied from the JELA-773
rig and a static server on port 8811.
