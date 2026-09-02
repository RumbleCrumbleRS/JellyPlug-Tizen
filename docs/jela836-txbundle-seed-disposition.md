# JELA-836 — disposition of the neutralised JELA-824 `txBundleDisabled` seed

**Finding: the entry cannot be dropped on a propagation argument, and no wait
makes it droppable. Keep it permanently and relabel it.**

Measured 2026-09-02 against live prod. Follow-up from [JELA-835](./jela835-tx-bundle-rollout.md).

## What is on the wire right now

`GET /JavaScriptInjector/public.js` → 923,444 B, sha256 `92cf9406851037ae…`,
`cache-control: public, max-age=0, must-revalidate`. Entry **108 of 109** in the
JSI `CustomJavaScripts` array, `Enabled: true`, 610 chars (428 of comment, 92 of
code):

<!-- Deployed payload, recorded byte-for-byte. Do not let prettier expand it: the
     92 code chars below are what is on the wire, and 610 is the measured length
     of the whole entry. Reformatting would make this document describe a payload
     that was never deployed. -->
<!-- prettier-ignore -->
```js
(function(){try{localStorage.setItem("jellyfin.shell.txBundleDisabled","0");}catch(e){}})();
```

That is the correct interim shape JELA-835 left behind, still intact, and the
config and the served bundle agree (both read — the `jsi-config-save-off-by-one`
trap cuts both ways).

## Why "wait for propagation, then delete" cannot terminate

### 1. The key has read sites in vehicles that no deploy can reach

| read site                                                   | vehicle                                                                                                     | updatable?                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `packages/shell-tizen/src/shell.js:7855`                    | hosted `/shell/shell.min.js`                                                                                | **yes** — server-plugin, `max-age=60`, `?v=<sha>` |
| `packages/shell-tizen/src/shell.js:7855`                    | legacy full WGT (`shell-tizen/src/index.html:119` loads the _local_ `shell.min.js`)                         | **no**                                            |
| `packages/shell-tizen-bootstrap/src/boot-shell.src.js:6396` | HSB WGT baked last-known-good fallback (`bootstrap/src/index.html`: loaded on 404 / timeout / script-error) | **no**                                            |

The gate is armed once per boot and shared: `ceTxdState()` calls
`txBundleAttach(d, u)`, which leaves `d.want` undefined when the key reads `"1"`,
and the `/web/`-side seed pipeline (`__txDropGet`) reads `d.want` off the _same_
`window.__shellTxDrop`. So one read of the key decides the whole boot's path —
and on a fallback or legacy-WGT boot that read happens in code we cannot ship to.

⇒ Retiring the key in the shell (rename, or delete the read) does **not** make a
stranded `"1"` inert. It would only split the fleet: hosted boots on the new key,
fallback/legacy boots still honouring the old one. The JSI channel is the only
repair channel for a stranded value, and it is permanent, not interim.

### 2. Neither available fleet signal can answer "has every exposed TV booted since"

The ticket asked for a fleet signal rather than a wall-clock guess. Both were
pulled; both are structurally unable to answer the question.

**`GET /shell/diag/report`** (the shell's own beacon) — 627 devices, 1,704 rings,
newest ring received **2026-09-01T13:05:59Z** (25.7 h before this read; nothing
since).

- The device id is `oid()`, minted into localStorage per _profile_. **Every one of
  the 627 ids appears exactly once** in `LatestPerDevice`. A wiped or fresh
  profile mints a new id, so the beacon cannot express "this TV booted again" —
  the exact predicate the drop decision needs.
- 10 devices' only ring falls inside the exposure window (2026-08-31T23:44:52Z →
  2026-09-01T00:01:47Z). Under the beacon's identity model those are
  indistinguishable from 10 stranded TVs.

**`GET /Devices`** (authenticated clients) — 850 entries, 249 of them
channel-executing (Tizen family / Jellyfin Web), 94 shell-capable.

- Only **8** devices of 850 have any activity since 2026-08-31T23:41Z.
- Exactly **one** device's last activity lands inside the exposure window:
  `RumbleCrumble | Chrome | Jellyfin Web 10.11.11` at `2026-09-01T00:03:12Z`. A
  browser executes the JSI channel but never boots the shell, so a `"1"` there is
  inert.
- **No shell-capable device's last activity falls in the window.** The newest
  Tizen-family entries are `Test`-owned rigs (`QE43Q60RATXXC-LOCAL | JellyPlug`,
  2026-09-01T13:03:52Z); the newest non-rig Tizen client
  (`Tyler | Samsung Smart TV | Jellyfin for Tizen 0.1.0`) last checked in
  2026-08-31T01:48:31Z — **before** the window, so it was never exposed.
- `DateLastActivity` is per _client_, so it can only identify devices that never
  came back. It cannot enumerate who was present during the window.

**The two signals disagree by two orders of magnitude** — ~300 beacon rings on
2026-09-01 versus 8 authenticated clients in 39 h — because the rig re-mints an
`oid` per boot while reusing one Jellyfin device entry. Do not treat the beacon's
device count as a fleet size.

## The cost asymmetry

|                                      | cost                                                                                                                                                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **keep the entry forever**           | 610 chars of 923,444 (**0.066 %**) of a bundle that is itself localStorage-cached per boot (`jsiChannelCache`), plus one `localStorage.setItem` per boot                                                                                                    |
| **drop it while one TV holds `"1"`** | that TV pays the per-body path on every cold boot, **forever**, with no repair channel left: 68 requests / 223,434 B instead of 6 / 196,989 B (JELA-835 measured pair) — +62 requests, +26 KB, and the JELA-824 tx storm carries 3.9–10.2 s of client queue |

Unbounded-in-duration downside against a 0.066 % upside, with the propagation
premise unprovable. There is no version of the cleanup that pays.

## Disposition

1. **Keep the entry permanently.** It is not a temporary neutralisation; it is the
   permanent repair seed for a key whose read site ships in un-updatable vehicles.
2. **Relabel the entry's comment header** so it stops advertising its own removal.
   The old header ended `Drop this entry only after it has propagated to the fleet.`
   — that sentence is what would have got it deleted by a future cleanup.
   Done 2026-09-02; see _Outcome_ below.
3. Any future `txBundle` kill switch should be **seeded from a key the hosted
   shell alone reads**, so that its rollback is a delete rather than an
   unprovable propagation wait.

## Outcome — accepted and executed 2026-09-02

The board accepted the disposition on JELA-836 (interaction
`559e8a99-4aee-4d62-a9f1-56b98af95006`): **keep the seed permanently, and relabel
the comment that advertises its own removal.**

The relabel is deployed. Only the entry's `Name` and its comment header changed;
the executable body is byte-identical to what JELA-835 left on the wire, and no
other entry of the 109 moved.

|             | before                                                       | after                                                                                                       |
| ----------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| entry name  | `JellyPlug — txBundle kill switch (JELA-824)`                | `JellyPlug — txBundle repair seed (JELA-824/836, PERMANENT)`                                                |
| header ends | `Drop this entry only after it has propagated to the fleet.` | `This entry is the only repair channel, permanently. … Details: docs/jela836-txbundle-seed-disposition.md.` |
| `public.js` | 923,444 B, sha256 `92cf94068510…`                            | 924,051 B, sha256 `d7b6a5b3e958…`                                                                           |

Verification (per `jsi-config-save-off-by-one`, both sides read):

- config re-GET: entry 108 byte-identical to the posted body, `Enabled: true`,
  `RequiresAuthentication: false`; diff against the pre-deploy snapshot shows
  **entry 108 only**, array length 109 → 109.
- served bundle re-GET: carries the new header, no longer carries
  `Drop this entry`, still carries exactly one
  `localStorage.setItem("jellyfin.shell.txBundleDisabled","0")`, and the whole
  923 KB bundle parses (`node --check`).
- the served bundle rebuilt on the first POST this time — the save count is not
  fixed; the rule is _POST until the served artifact carries your bytes_.

The deployed entry, verbatim (the JSI config is not in git):

<!-- prettier-ignore -->
```js
/* JellyPlug — PERMANENT tx-bundle repair seed. Hands every TV back to the
   JELA-833 coalesced tx-bundle path by writing "0" UNCONDITIONALLY.

   DO NOT DELETE THIS ENTRY. Disposition settled on JELA-836 (approved
   2026-09-02): "drop it once \"0\" has propagated" has no terminating
   condition. The JELA-824 emergency kill wrote "1" into each TV's
   localStorage and that value outlives this channel entry; the read site is
   opt-OUT (jellyfin.shell.txBundleDisabled === "1" kills) and ALSO ships
   inside two un-updatable vehicles — the legacy full WGT's baked
   shell.min.js and the HSB WGT's baked boot-shell.min.js fallback — so no
   shell release can retire the key on a fielded TV, and no fleet signal can
   prove propagation (the diag device id is minted per profile, so it can
   never say "this TV booted again"). This entry is the only repair channel,
   permanently. Cost to keep: 0.066% of public.js. Cost of dropping it one TV
   early: +62 requests / +26 KB on every cold boot of that TV, forever.
   Details: docs/jela836-txbundle-seed-disposition.md. jp824kill */
(function(){try{localStorage.setItem("jellyfin.shell.txBundleDisabled","0");}catch(e){}})();
```

Snapshots (rollback + clobber-detection reference) are kept in the agent
workspace as `jela836/pre-relabel-20260902.json` and
`jela836/post-relabel-20260902.json`.

## Lesson

**An opt-OUT flag whose read site ships in an un-updatable vehicle converts its
own seed into permanent infrastructure.** The rollback of such a seed is never a
delete, and it is never _eventually_ a delete either — the "wait for propagation"
plan has no terminating condition, because the only instrument that could
terminate it (a per-device boot signal) does not survive a profile wipe. Decide
the flag's vehicle before you decide its polarity.

See also: `jela824-txbundle-union-regression`, `jela853-web-index-double-fetch`
(a flag whose read site ships in the un-updatable WGT can only be moved by
seeding its value), `jsi-config-save-off-by-one`.
