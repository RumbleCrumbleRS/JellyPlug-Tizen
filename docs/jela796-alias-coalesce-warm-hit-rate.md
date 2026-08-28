# JELA-796 — aliasCoalesce on WARM boots: measured hit rate

Follow-up to JELA-778 (`jp778seed` flipped default-ON 2026-08-28). The 778 ring
measured **−2 requests/boot, 6/6**, but every ring boot ran on a **wiped
profile**. A real TV is warm on every boot after the first, and 778's post-flip
acceptance got only n=2 usable warm boots which **split** (hit=0 / hit=1). This
run puts a rate on the condition that actually ships.

Measured 2026-08-28 on the pinned Chromium 63 rig, two independent persistent
profiles, arms interleaved, box load 3.9–8.8 (11 of 12 treatment boots at
load < 6).

## Headline

| | result |
|---|---|
| **Warm-boot hit rate** | **12 / 12 = 100 %**, Wilson 95 % CI **[75.7 %, 100 %]** |
| Miss rate upper bound (rule of three) | **≤ 25 %** |
| `__shellACo.err` | **0 in 12/12** |
| Cards rendered | 247–279 (treatment), 247–279 (control) — no regression |
| **Prize per warm boot** | **1 request, ~1.55 KB** — *not* the 2 requests 778 quoted |

## The prize is 1 request on a warm TV, not 2

778 counted the saving as `1 GET + 1 CORS preflight = 2 requests`. That is
correct only on a **cold** profile, which is the only kind its ring ever booted.

| | views-pair URLs | preflights |
|---|---|---|
| cold arming boot (n=2) | no `api_key` | **2** |
| every warm boot (n=20) | `…?api_key=…` | **0** |

`jp788seed` (JELA-788 queryAuth, live) is itself a shell-seed-read flag, so it
arms on a TV's **second** boot and moves the credential from the `Authorization`
header into the query string. A GET with no custom header is a CORS *simple
request*, so there is no preflight left for aliasCoalesce to save. On any TV
that has booted twice — i.e. effectively the whole fleet — the second views
request is a **bare GET, and that single GET is the whole prize**.

Measured size of the `/UserViews` GET the treatment arm never issues:
**1544, 1546, 1569, 1572 B** encoded (n=4).

This is the same lesson as 778's own, one level up: **a sibling flip can take
half of your lever's prize before you get to quote it.** Re-measure the prize
in the arm that matches the fleet's *current* state, not the state at merge.

## Do NOT raise `aliasCoalesceTtlMs`

The control arm (`jellyfin.shell.aliasCoalesceDisabled=1`, the shipped per-TV
hard kill) forces both views calls onto the wire, so the gap between them is
directly observable — the quantity the 10 s TTL is compared against.

```
gap ms (n=8):  186  197  227  262  299  317  366  448      median 299
```

The **worst** observed gap is **22.3× under the 10 s TTL**. The TTL is nowhere
near binding, so raising it buys nothing and only widens the window in which a
stale views body could be served. **Recommendation: leave `cTTL` at 10 s.**
(Cold boots are slower — 540 ms and 1446 ms — and still 7–18× under.)

The other candidate failure mode is also ruled out: `cKey` folds both call
shapes to the same string, and the recomputed keys were **identical in 8/8**
(`V:?api_key=…`, after `_` and `userId` are stripped and the residual sorted).

### Why 778's TTL explanation for its one warm miss is wrong

778 attributed its warm miss (`w1`) to load stretching the gap past 10 s. The
counter arithmetic refutes that. A `V:` slot costs exactly **+1 `rec`, +1
`miss`** — this run pins it:

| arm | `rec` | `miss` | `hit` |
|---|---|---|---|
| control (no `V:` keying) | 10 | 11 | 0 |
| treatment, views hit | 11 | 12 | 1 |
| treatment, TTL expiry *would* read | 12 | 13 | 0 |

`w1` read **`rec=11 miss=12 hit=0`** — exactly **one** `V:` slot created, while
both views GETs went out. A TTL expiry deletes the stale slot and then creates a
second one, which would have read `rec=12 miss=13`. So in `w1` the second views
call **never reached the coalescer's wrapper at all** — consistent with a
startup race (the call was issued before the wrapper installed), which a starved
box makes more likely. Load is still the confound; the TTL is not the mechanism.

## Rig

`warm796.mjs` (env-driven; server and token come from `JELLYFIN_URL` /
`JELLYFIN_API_KEY`, never hard-coded — CI guard). Forked from JELA-778's
`accept778.mjs`. Boot 0 wipes the profile and lets the live channel arm the key;
it is **excluded from every endpoint** because the shell reads the flag before
the channel runs, so a cold boot cannot hit by construction. Boots 1..N are warm
on that same profile, arms interleaved `T,T,C` / `C,T` (never in blocks).

Inherited traps, all load-bearing:

- `__707.state` **persists** in localStorage — clear it before every navigate or
  boot N reads boot N−1's state and mis-times firstCard.
- `shellFromProd` is **invalid** as a warm-boot gate: the warm shell comes off
  the HTTP disk cache and emits no `requestWillBeSent`. Gate on `cards > 10`.
- `Browser.close`, never SIGKILL, or localStorage never flushes to the profile.
- `Network.requestServedFromCache` never fires on M63 — use
  `responseReceived.fromDiskCache` (checked: the views GETs are `false`, i.e.
  real network round trips, so the saved request is a genuine saving).

### New trap: the profile's localStorage hits a quota cliff

A persistent profile reaches **≈3.67 MB / 228 keys** after ~9 boots and then
boots start failing outright: `net::ERR_ABORTED`, `cards=0`, `fcCard=-1`,
`__shellACo` all-zero, ~44 requests and no render. **That reads exactly like
"the defect vanished" and it is not** (cf. JELA-788's `fcCard=-1` zero). Profile
A died 4/4 at low load once it aged in; fresh profile B ran 9/9 clean.

The store is dominated by the shell's own transpile cache, not by app data:

| key | bytes |
|---|---|
| `shell.tx1t1at4s:txc:…` | 901,582 |
| `jellyfin.shell.bundlePatchState` | 497,795 |
| `jellyfin.shell.hsbShellBody` | 240,607 |
| `shell.tx1t1at4s:<per-plugin-script>` × ~200 | 33–78 K each |

Any multi-boot rig on one profile must watch `localStorage` size and start a
fresh profile before the cliff. **A real TV accumulates the same store**, which
is a fleet concern in its own right — tracked separately, not in this issue.

## Not a rollback trigger

The failure mode is fail-open: a miss costs one extra request (the pre-flip
status quo), `err=0` in 12/12, no card loss, no added requests. This issue
quantifies the prize; it does not gate the flip, which is live and accepted.
