# Hosted Shell Bootstrap v2.0.6 — JEL-111 iterator-clobber fix (signed)

`JellyfinShellBootstrap_v2.0.6.wgt` — 582,250 bytes, sha256
`fa91224cdcc0cb307e374ea384d97bd5489964c11e393b15b4ae39cb1aa1eebb`.

**Signed (author + distributor).** Produced by the `bootstrap-sign` GitHub
Actions workflow from tag `bootstrap-v2.0.6` (run `27293498308`, commit
`eeee51f`) and verified by `tooling/ci/verify-wgt-signed.sh` (embeds
`author-signature.xml` + `signature1.xml`). Installable on a retail Tizen TV
via Samsung Device Manager.

## What this build adds (JEL-114, promotes JEL-111 and everything since 2.0.2)

First retail cut since v2.0.2. The baked `boot-shell.min.js` (sha256
`6cf13a49590de1f6a247b296ec846ebf050b9bb3a361a7b6a13a73f52ad84919`,
byte-identical to merged `main`) carries:

- **JEL-111** — home "spins forever after sign-in" fix. jellyfin-web
  10.11.11's lazy home-route chunks rebind the DOM collection constructors
  during eval, clobbering `Symbol.iterator` on
  `NodeList`/`HTMLCollection`/etc., so home render died with "Invalid attempt
  to iterate non-iterable instance". Fix = deterministic constructor setter
  traps + 250ms/3s iterator re-sweep (PR #37), guarded by
  `iterator-resweep.test.cjs`.
- **JEL-99** — defer-script watchdog no longer clobbers healthy-but-slow
  boots (drop bogus readyState trigger, 20s cap, removeChild originals).
- **JEL-100** — QA localStorage seed stripped from retail builds
  (`process-qa-seed.sh`, default OFF, CI-guarded).
- **JEL-85** — connect-form parity: server validation gets a 5s timeout and
  requires a Version field before proceeding.

## Verification

Installed on the physical user TV (`QN82Q60RAFXZA`, 2026-06-10) via
`vd_appinstall` as a same-cert upgrade (`install completed`, `cmd_ret:0`);
firstscreen REST reads the app `running:true, visible:true` post-launch. The
underlying JEL-111 fix was verified on-device on the QA flavor of this same
shell (realCards=211 on home, zero iterate errors). The QA flavor's leftover
localStorage flags (`fastPathDisabled`, `qa.overlay`, `qa.beaconUrl`) were
cleared by a one-shot transitional build (branch `qa/jel114-clear`, farewell
beacon confirmed + relay silence after) before this retail install, so this
build boots the fast path with telemetry disarmed. Note: the device's
REST/`vd_applist` `version` field is a stale cache on this set (still reads
2.0.2 after every upgrade since) — version confirmation rests on the
byte-verified pushed artifact, not that field.

## Source

`packages/shell-tizen-bootstrap/` at tag `bootstrap-v2.0.6`. JEL-2040
architecture; JEL-114 retail cutover of the JEL-111 fix.
