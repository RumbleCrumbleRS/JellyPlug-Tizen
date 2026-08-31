# JELA-821 rollout — arming `deferJe` on the first boot, in production

**Status: SHIPPED 2026-08-31.** Board approved the deploy (interaction
`1ec3a546`). Published as server-plugin **v1.0.43.0**, shell
`b358bd100862c55f1ff83e32fa824958df6bf08bec687b48b1cfac218e77b0f3`.

This is the rollout record. The fix itself, the reasoning, and the pre-deploy
rig acceptance are in [`jela821-deferje-opt-out.md`](./jela821-deferje-opt-out.md).

## What shipped

One expression in `stripJeScriptsForDefer()`:

```js
- if (localStorage.getItem("jellyfin.shell.deferJe") !== "1") return html;   // opt-in
+ if (localStorage.getItem("jellyfin.shell.deferJe") === "0") return html;   // opt-OUT
```

`deferJe` is seeded fleet-ON by the jp773 JSI channel entry, but the channel
only runs after the lite→SPA handoff (JELA-802) — one boot *after* this read
site. So every boot that began with the key absent (a first install, a
re-install, any localStorage eviction) fell through to the stock pre-paint
injection and paid all 152 JellyfinEnhanced modules — 670,857 B, 36% of a cold
boot's requests — ahead of first paint.

## Rider audit

A release ships **all** of main, so the audit is on the shell bytes, not on the
ticket list. Between the previously-served shell and this one there was exactly
one shell-source commit:

| | sha256 | read site |
|---|---|---|
| served before (v1.0.42.0) | `d41a3d7a…` | `…deferJe") !== "1"` |
| served after (v1.0.43.0) | `b358bd10…` | `…deferJe") === "0"` |

`git diff cd86bbf origin/main -- packages/shell-tizen/src/` is that expression,
its comment, and the `catch` that no longer bails. Everything else merged since
v1.0.42.0 is docs or JSI-channel scripts — jp815/jp816 live in the channel, not
in the shell, and did not ride here.

## Deploy sequence

1. PR #246 — `<Version>` 1.0.42.0 → 1.0.43.0, merged `eed180d`.
2. `release-server-plugin` dispatched with `confirm_version=1.0.43.0`; release
   `server-plugin-v1.0.43.0` created and `plugin-repo/manifest.json` spliced
   (md5 `814b90b073d7624a5d066babe488511a`).
3. **Audited the shipped artifact, not just the release.** Downloaded the
   published zip, extracted `Jellyfin.Plugin.JellyPlugShell.dll` and grepped the
   embedded shell **by read expression**: 1 × `deferJe")==="0"`, 0 ×
   `deferJe")!=="1"`. Grepping by *key* is useless here — `deferJe`
   substring-matches the unrelated `deferJeMs` tunable.
4. `PluginUpdates` scheduled task → `/Plugins` listed 1.0.43.0 with status
   `Restart` on the **first** trigger (the stale-manifest gotcha did not bite).
5. `POST /System/Restart` at 16:45:12Z; API back ~16:49Z.
6. Verified live: plugin `1.0.43.0 Active`; `/shell/manifest.json` sha256 =
   `b358bd10…`; the served `shell.min.js` **byte-identical** to
   `git show origin/main:packages/shell-tizen/src/shell.min.js`; 1 opt-out site,
   0 opt-in sites.

TVs cache-bust on the manifest sha, so propagation needs no version bump beyond
this and no TV-side action.

## Post-deploy acceptance — on the bytes TVs actually get

The pre-deploy acceptance necessarily served a **local** shell (the fix was
dark). That proves the build, not the fleet. Re-run here against the **real**
path: no `hsbCached*` seeding at all, so HSB discovers the shell through prod's
own `/shell/manifest.json` and fetches prod's `/shell/shell.min.js`.
`/web/`, the API and the JSI channel were already prod.

Driver `run821prod.mjs` (out of git per JEL-141), JELA-112 virtual Tizen 5.0 rig
(pinned Chromium 63 / V8 6.3). One boot per **fresh profile**. Provenance is
established by **hashing the response body the engine executed** — not by the
URL, because under load HSB's 1.5 s manifest probe loses the race and it falls
back to `shell.min.js?t=<now>`, a URL carrying no sha at all. The driver also
re-audits the executed bytes for the read expression and refuses to start unless
the served artifact is the patched one.

| | ON — key absent | ON — key absent | OFF — kill switch |
|---|---|---|---|
| capture | `PRODON2` | `PRODON5` | `PRODOFF3` |
| executed shell sha | `b358bd10…` | `b43aa2b7…` | `b43aa2b7…` |
| `deferJe` at nav | `null` | `null` | `"0"` |
| `__shellJeDefer` | `{on:1,held:1,rel:1,inj:1}` | `{on:1,held:1,rel:1,inj:1}` | **absent** |
| **JE modules pre-paint** | **0 / 152** | **3 / 152** | **152 / 152** |
| all `/JellyfinEnhanced/*` pre-paint bytes | **0** | 51,231 | **1,118,155** |
| JE module window, from nav | +17,570 .. +19,377 ms | +47,796 .. +48,833 ms | +26,723 .. +31,614 ms |
| firstCard | 15,019 ms | 48,281 ms | 40,653 ms |
| provenance / validity gates | pass | pass | pass |

**COUNT claim only.** The box carried loadavg 4.8–11.4 from concurrent sibling
rigs and n=1 per arm, so firstCard is recorded but **not** claimed.

### Reading the `3 / 152`

Not a gate failure — a boundary artifact of the rig's polled firstCard. In
`PRODON5` the gate held every module for ~48 s and released at `tInj`; the three
counted modules (`splashscreen.js`, `translations.js`, `login-image.js`) fire at
+47,796 / +47,802 / +48,099 ms against a firstCard observed at 48,281 ms — i.e.
inside the few hundred ms by which the DOM poll lags the actual paint. The
remaining 149 follow immediately after.

The OFF arm is a different regime entirely, and that is the real contrast: its
modules start at +26,723 ms and run to +31,614 ms against a firstCard of
40,653 ms — **9 to 14 seconds ahead of paint**, and they are why paint is that
late. Arm proven by the diag object, never by a request (JELA-811).

## Operating notes — both are traps

1. **A key-absent arm is no longer an OFF arm.** The JELA-811 harness asserted
   `deferJe === null` pre-nav and never wrote the key in any arm; under the old
   read site that made boot 1 an implicit OFF arm. It is now an **ON** arm. Any
   OFF arm must seed `"0"` explicitly.
2. **Rollback must SET `"0"`, not remove the key.** Removing the jp773 channel
   entry no longer turns the lever off — it latches every TV ON. The jp773
   seeder itself is already guarded on `!== "0"`, so it never clobbers a
   device's kill switch and is a correct no-op after this ship. Plugin-level
   rollback is roll-**forward** to a higher version carrying a reverted read
   site; there is no downgrade channel.

## Two things that happened mid-rollout

- **The served shell moved under the acceptance run.** A sibling published
  **v1.0.44.0** (JELA-825, MaterialIcons subset) while the arms were running, so
  `PRODON5` / `PRODOFF3` executed `b43aa2b7…` rather than `b358bd10…`. A release
  ships all of main, so that build carries this fix too — re-verified on the new
  bytes: 1 opt-out site, 0 opt-in sites. Both arms in the headline comparison
  share one build. This is why provenance hashes the executed body per boot and
  why no expected sha is ever pinned (JELA-811).
- **Prod returned 502 for ~2 minutes at 17:03–17:06Z**, consistent with the
  sibling's v1.0.44.0 restart. Recovered on its own; the deployed state was
  re-verified afterwards.
