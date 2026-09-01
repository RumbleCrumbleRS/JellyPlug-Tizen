# JELA-834 — `bitrateCache` opt-in → opt-OUT: acceptance

**Result: AC1, AC2 and AC3 all PASS, with a negative control that reproduces the
defect on the unflipped shell.**

## The defect

JELA-817 seeded `jellyfin.shell.bitrateCache="1"` fleet-wide but left the shell
read site opt-in:

```js
if (localStorage.getItem("jellyfin.shell.bitrateCache") !== "1") return;
```

The key is written by the JSI channel, which only runs *after* the lite→SPA
handoff (JELA-802). On a cold boot with no prior `"1"` in localStorage (fresh
install, wipe, eviction) the key is **absent** when this line executes, so the
whole cache block returns. The boot then spends the full 5.77 MB
`/Playback/BitrateTest` escalation **and** persists nothing, so boots 2..N
inherit no cache either.

Confirmed live before the fix: the served shell (sha `d73fd58f`) carried
**1** opt-in site and 0 opt-out sites.

## The fix

```diff
- if(localStorage.getItem("jellyfin.shell.bitrateCache")!=="1")return;
+ if(localStorage.getItem("jellyfin.shell.bitrateCache")==="0")return;
```

Mirrored into `boot-shell.src.js`; both `.min` regenerated. All four artifacts
carry **1 opt-out site, 0 opt-in survivors**.

## Rig

JELA-112 virtual Tizen 5.0 (pinned Chromium 63), fresh profile and fresh chrome
process per arm. The flip is not deployed, so the JELA-681 recipe was used: the
HSB bootloader's shell base was repointed at a locally-served `/shell/` tree.
Everything else — the API, auth, and the live JSI channel — is still the real
prod server, so the seeder that writes the flag is the fielded one.

- fix shell `2ce95e0e` = this branch's build
- control shell `18675de5` = `origin/main` (still opt-in), the negative control

Arms differ by exactly one pre-nav localStorage key. Provenance is the sha256 of
the **executed** body, never the request URL.

## Results

| arm | `lsPre` key | `lsPost` key | `__shellBitrate` | on | hits | miss | saves | BitrateTest reqs | bytes |
|---|---|---|---|---|---|---|---|---|---|
| ABSENT (fix) | *absent* | `"1"` | **present** | 1 | 0 | 1 | 1 | 6 | 5,770,648 |
| SEED1 (fix) | `"1"` | `"1"` | **present** | 1 | 0 | 1 | 1 | 6 | 5,770,632 |
| OFF (fix) | `"0"` | `"0"` | **absent** | — | — | — | — | 6 | 5,770,627 |
| BOOT2 (fix) | `"1"` | `"1"` | **present** | 1 | **1** | 0 | 0 | **0** | **0** |
| ABSENT (**control**, unflipped) | *absent* | `"1"` | **absent** | — | — | — | — | 6 | 5,770,635 |

The arm oracle is `window.__shellBitrate`: the gate installs it only when it does
**not** return early, so presence/absence is the arm independent of the network
(JELA-811/823).

### AC1 — key-absent arms, and matches a seeded `"1"`

`ABSENT` and `SEED1` are **indistinguishable**: both present with `on:1`,
`armed:1`, `miss:1`, `saves:1`. A first-install boot now measures **and
persists**, which is the half that was previously impossible.

### AC2 — the kill switch is live, and durable

`OFF` (`"0"` pre-nav) leaves `__shellBitrate` **absent**, so the gate is real and
not deleted. The probe still ran (6 requests, 5.77 MB) — a capture with no probe
at all would prove nothing (JELA-813 false-pass guard).

Durability: the OFF arm's `lsPost` is still `"0"`. The channel seeder guards on
`!== "0"`, read out of the served `/JavaScriptInjector/public.js`:

```js
(function(){try{var k="jellyfin.shell.bitrateCache";
if(localStorage.getItem(k)!=="0"){localStorage.setItem(k,"1");}}catch(e){}})();
```

so a per-TV `"0"` is **not** overwritten — unlike the `ytApiStub` / `diagBeacon`
shapes JELA-827 found.

### AC3 — boot 2 hits the cache boot 1 seeded

Boot 2 on boot 1's profile (no wipe, no re-seed) shows `hits:1`, `miss:0`,
`bps:146489350`, and **0** BitrateTest requests / **0** bytes. Per JELA-817,
`hits>=1` is the signal, **not** "0 requests" — zero requests alone is equally
consistent with a truncated capture. The persisted row carried byte-identically:

```
boot 1 lsPost : {"bps":146489350,"t":1788249591101,"id":"ced3b2e3…|https:…
boot 2 lsPre  : {"bps":146489350,"t":1788249591101,"id":"ced3b2e3…|https:…
```

### Negative control — the rig discriminates

The same `ABSENT` arm on the **unflipped** shell leaves `__shellBitrate`
**absent** while its `lsPost` key is `"1"` — the key written *during* the boot it
was supposed to govern. One character of shell difference flips armed/unarmed,
so the pass above is caused by the fix and not by the harness.

## Prize

Per TV, from its **first** boot rather than never: boot 2 drops from 6 requests /
5,770,648 B of `/Playback/BitrateTest` to **0 / 0**. JELA-817's stated prize is
unchanged; what this restores is the boot that seeds it.

## Rollback

`setItem("jellyfin.shell.bitrateCache","0")` — **never `removeItem`**. A
key-absent arm is now an ON arm.

## Notes

- Load average was 2.2–5.2 across the arms. These ACs are arming/counting claims
  (gate presence, `hits`, request counts), not latency claims, so the JELA-682
  load confound does not apply; no timing claim is made here.
- One control capture was discarded on a CDP `Runtime.evaluate` timeout and
  re-run on a fresh port. No claim is built on a boot that failed its own gates.
