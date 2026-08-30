# JELA-809 — two-boot proof of the jp807 `udcGate` fleet flip

**Date:** 2026-08-30 · **Parent:** JELA-807 · **Verdict: AC1–AC4 all PASS** on the
M63 virtual panel against live production bytes. The Q60R leg is **not** done —
the panel was powered off for the whole run (evidence in §5).

---

## 1. What was under test

The JELA-807 flip shipped in two steps:

| step                    | commit              | what                                                               |
| ----------------------- | ------------------- | ------------------------------------------------------------------ |
| server-plugin v1.0.41.0 | `e210a88` (PR #234) | `/shell/shell.min.js` now carries the `udcGate`                    |
| jp807 seeder            | `c09b30e` (PR #235) | JSI channel 103 → 104 entries, writes `jellyfin.shell.udcGate="1"` |

JELA-790's rule is that **a served bundle does not prove a seeder**. The open
question was therefore delivery: does a real browser, booting the real shell,
actually reach `udcGate="1"` through the channel — and then arm on the next boot
and swallow the right pushes?

## 2. Re-verification of the served artifacts (2026-08-30, at the wire)

Re-checked rather than cited: a JSI config POST replaces the **whole** entry
list, so a sibling agent's deploy can silently drop an entry.

| artifact                        | value                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/shell/shell.min.js`           | sha `8724caf369089db93c83ab4e9a134cbd2b775413c7c51e3d37db1e43bcc9521b`, 243,199 B — exact match to the ship |
| gate present                    | `jellyfin.shell.udcGate` ×1, `__shellUdc` ×10                                                               |
| `/JavaScriptInjector/public.js` | 906,972 B, sha `5ecf861917508f9093864c23416ea8e210160395d5e0bfc5ae5b16f68b38a871`                           |
| seeder present                  | `jp807seed` ×1, alongside 13 siblings                                                                       |

## 3. Method

`boot809.mjs`, one boot per invocation, state carried on disk between
invocations — that persistence is the thing under test. Lineage: profile/two-boot
discipline from JELA-808's `boot808.mjs`, induction + per-push scoring from
JELA-761's `idlea761.mjs`.

**Three things `idlea761.mjs` does that are deliberately NOT done here.** Each
one would have voided the run:

1. It seeds `jsiChannelDisabled=1`. Here **the channel IS the thing under test** —
   it is what delivers the seeder.
2. It seeds `liteEnabled=0`. The fleet default is lite-ON, and the lite→SPA
   handoff is _precisely_ what makes the channel post-handoff (JELA-802).
3. It seeds HSB's localStorage shell-body cache to run an unpublished shell.
   That was right when prod served v1.0.90 (no gate); it is **wrong now** that
   prod serves the gate-carrying build.

So the only seeded keys are what makes the rig a logged-in TV at all:
`serverUrl`, `jellyfin_credentials`, `enableAutoLogin`, `_deviceId2`. **The
harness never writes `udcGate`.** Boot 1 asserts the key is `null` before
navigation, so a `"1"` reading can only have come from the served seeder.

**No witness socket, at any point.** A second authenticated socket on the same
access token steals the broadcast off the SPA (JELA-761, measured within one
boot); that instrument was the blocker that stalled JELA-807 for a whole pass.
Ground truth for "did the server actually emit?" comes from the SPA's **own**
socket via CDP `Network.webSocketFrameReceived` — the gate drops frames in JS,
_after_ the wire, so CDP frame receipt is gate-independent.

Other rules applied: fresh inducer DeviceId per push; score per **induction**,
not per frame; window `[push−3 s, push+25 s]`; taint detected on a wider
`[push−15 s, push+25 s]`; rebuild traffic is the **query** form
`/Users/{u}/Items?…` plus `/HomeScreen/Section/*` only, excluding the 12 s
mediabar single-item rotation (JELA-762).

### Shell provenance — which bytes actually executed

Recorded per boot, not assumed. First boot of each profile fetched
`…/shell/shell.min.js?v=8724caf369089db93c83ab4e9a134cbd2b775413c7c51e3d37…`
from the server; later boots replayed HSB's own localStorage body cache, which
self-verifies `sha=8724caf3…9bcc9521b`, `b=243199`. **Same bytes as the ship, in
every scored boot.**

## 4. Results

### AC1 — boot 1 seeds, and correctly stays dormant

Two fresh profiles, wiped, `udcGate` asserted `null` pre-navigation.

| profile | gate at start | gate at end | `__shellUdc` across boot | cards | clean exit |
| ------- | ------------- | ----------- | ------------------------ | ----- | ---------- |
| smoke   | `null`        | **`"1"`**   | absent in 7/7 samples    | 290   | yes        |
| P1      | `null`        | **`"1"`**   | absent in 13/13 samples  | 258   | yes        |

The flag was already `"1"` at the t=10 s sample — the channel delivers it
promptly after the handoff. `__shellUdc` **absent** for the entire boot is the
**correct** result, not a broken deploy: the gate's IIFE reads the flag once, at
install (document start), and the channel is a `<script defer>` inside the remote
`/web/index.html`, i.e. structurally post-handoff. **AC1 PASS ×2.**

### AC2 — boot 2 arms, read before any push exists

| profile | `__shellUdc` at pre-window                                             |
| ------- | ---------------------------------------------------------------------- |
| smoke   | `{on:1, seen:0, pass:0, dropNoHit:0, dropDup:0, held:0, ids:0, err:0}` |
| P1      | `{on:1, seen:0, pass:0, dropNoHit:0, dropDup:0, held:0, ids:0, err:0}` |

All counters zero, so this is genuinely pre-push. **AC2 PASS ×2.**

### AC3 / AC4 — swallow and correctness

12 inductions across three arms. **Every push took 2/2 frames at CDP; 0 foreign
frames; 0 pushes dropped; 0 windows tainted.**

| arm                     | swallow pushes | rebuild reqs | bytes       | rendered push | rebuild reqs      |
| ----------------------- | -------------- | ------------ | ----------- | ------------- | ----------------- |
| smoke, armed            | 3              | **0, 0, 0**  | **0**       | 1             | **20** (64,069 B) |
| P1, armed               | 3              | **0, 0, 0**  | **0**       | 1             | **18** (49,012 B) |
| P1, **unarmed control** | 3              | 30, 28, 30   | 83,977 mean | 1             | 29 (74,894 B)     |

Shell telemetry was identical in both armed boots and matches the JELA-761 ring
exactly: `seen:8, pass:1, dropNoHit:6, dropDup:1`. `dropNoHit` rose 2 → 4 → 6
across the three swallow pushes, and the rendered push moved `pass` 0 → 1.

**AC3 PASS ×2** (6/6 swallowed pushes, exactly zero rebuild traffic).
**AC4 PASS ×2** (2/2 rendered pushes still rebuilt the home; `pass` incremented).
**No rollback is indicated.**

### The unarmed control, and why AC3's zero is earned

AC3's "zero requests" is only meaningful as a **differential** — on its own,
zero is indistinguishable from a harness that failed to observe traffic. Two
independent controls establish it:

1. **In-boot positive control.** In the _same_ armed boot, on the _same_ socket,
   with the _same_ scoring code, the rendered push produced 18–20 rebuild
   requests. So the instrument demonstrably sees rebuild traffic when it happens.
2. **Matched unarmed arm.** `J809_UNARM=1` removes `udcGate` immediately before
   navigation and changes **nothing else** — same profile lineage, same shell
   sha, same 16 channel-seeded fleet flags, same target pool, same analyzer. Its
   swallow pushes cost **29.33 requests / 83,977 bytes each**.

**Measured differential: 29.33 reqs → 0.00 reqs per swallowed `UserDataChanged`.**

That control also incidentally re-proves the install-time read: it booted with
`pre.flag === "1"` (the channel had re-seeded the key) yet `__shellUdc === null`
for the whole boot. The flag being present is not sufficient — it has to be
present _at install_.

Note the control's ~29 requests is roughly **double** JELA-761's fleet-OFF figure
of 16.00. The likely reason is dedup: one induction emits two frames, and an
unarmed shell has no `dropDup`, so it rebuilds on both. Consistent with the
armed rendered push (`dropDup:1`, one rebuild, 18–20 reqs ≈ the reference
16.00). Stated as an observation, not a firm mechanism — it was not isolated.

## 5. What is still owed: the Q60R itself

The panel was **powered off** for this entire run. Established with the JELA-802
control set, because a powered-off panel is otherwise indistinguishable from a
dead route:

| control                                    | result                      | means                            |
| ------------------------------------------ | --------------------------- | -------------------------------- |
| gateway `192.168.86.1:80`                  | HTTP 200                    | LAN routable from this container |
| dev PC `192.168.86.38`                     | `:22`, `:443`, `:8080` open | live hosts answer normally       |
| liveness sweep `22/80/443/8080`            | 9 hosts alive               | the sweep itself works           |
| **full /24, ports `8001/8002/9197/26101`** | **zero hits**               | **no Samsung panel on the LAN**  |

Swept in batches of 32 (a single 253-way fan-out returns a false all-clear).
`.249` and `.202` both silent. A Samsung panel answering nothing on `:8001` is
powered off or off Wi-Fi.

**The residual gap is exactly one link:** "a Samsung Q60R executes
`/JavaScriptInjector/public.js` at all." Links 1 and 2 (snippet in the served
bundle; snippet does what it claims) were proven off-panel by JELA-807, and this
run proves the full chain end-to-end on an M63-class engine against the live
prod bytes. JELA-802 separately confirmed link 3 **on this exact panel** for
sibling entries in the same config list, same
`Name/Script/Enabled/RequiresAuthentication` shape.

## 6. Reproducing

```
/tmp/jela809-rig/boot809.mjs   # node boot809.mjs <tag> <boot:1|2> <wipe:0|1>
/tmp/jela809-rig/an809.py      # offline scorer, derives every number from raw logs

node boot809.mjs P1 1 1                 # boot 1: fresh profile, channel seeds
node boot809.mjs P1 2 0                 # boot 2: armed, 4 inductions
J809_UNARM=1 node boot809.mjs P1 2 0    # matched unarmed control
python3 an809.py out/*-boot2*.json
```

Env: `JELLYFIN_SERVER_URL` (note `JELLYFIN_URL` is unset here and is the classic
trap). Knobs: `J809_UPTIME_MS`, `J809_SETTLE_MS`, `J809_WINDOW_MS`.

Load average was 0.94–4.96 across the ring. Every claim here is a **boolean or a
count**, both of which survive a dirty box; no timing claim is made.
