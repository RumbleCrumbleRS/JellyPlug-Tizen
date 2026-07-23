# JellyPlug Lite rollout runbook (JELA-141 / C5 / WS-5)

How to take the Lite canvas home from flag-dark to fleet default-ON, and how
to take it back. This is the plan gate G-A delivery step (home usable ≤3s vs
the 13.4s SPA baseline) — nothing before it changes fleet behavior.

## The lever

Three flags, one mechanism (JELA-141 `flagDefaults`):

| localStorage key             | what it turns on                                   | fleet default source                |
| ---------------------------- | -------------------------------------------------- | ----------------------------------- |
| `jellyfin.shell.liteEnabled` | Lite canvas home instead of the SPA home           | plugin config `LiteDefaultOn`       |
| `jellyfin.lite.native`       | AVPlay native playback fork on OK                  | plugin config `LiteNativeDefaultOn` |
| `jellyfin.lite.subs`         | Lite-rendered External-srt cues in native playback | plugin config `LiteSubsDefaultOn`   |

Server side: when any `Lite*DefaultOn` is set (Dashboard → Plugins →
JellyPlug Shell → "Lite rollout"), `/shell/manifest.json` carries an additive
`flagDefaults` map with all three keys as explicit `"0"`/`"1"`. All three off
= the field is omitted and the manifest is byte-identical to pre-JELA-141.
Flipping these bools does NOT move `configEpoch` (the shell plugin's own
config is not a fingerprint input), so a flip never causes a fleet cache
reload.

TV side (shell ≥1.0.87): the map is cached in
`localStorage["jellyfin.shell.flagDefaults"]` one boot behind
(stale-one-boot, the same contract as the Lite byte cache) and consulted only
when the device has **no explicit value** for a key. Precedence, per key:

1. explicit device-local `"1"` → on (QA opt-ins survive fleet flips)
2. explicit device-local `"0"` → off (per-device kill survives default-ON)
3. neither → the cached fleet default (absent record = off)

Adoption paths: when Lite runs, `liteRestock`'s per-boot manifest read
refreshes the cache (this is the fetch that lands a fleet kill); when it does
not, one deferred `?__fd=` manifest read ~25s post-boot does (the turn-ON
path, off the boot path). QA surface: `window.__shellLiteDef`
(`{st: cached|adopted|cleared|none, f}`).

## Propagation timeline

- Config flip → manifest changes immediately (`no-cache`).
- TV picks the new map up on its next manifest read (per boot; plus the
  restock read if Lite is live) → behavior changes on the boot **after
  that**. Fleet latency ≈ two boots, no reinstall, no plugin release.
- Shipping the mechanism itself (first time only) is a server-plugin release
  → `docs/deploy-runbook.md`. Gotcha (JELA-58/JELA-139 history): the first
  `PluginUpdates` task run after a release can no-op on a stale
  raw.githubusercontent manifest — `GET /Plugins` must list the new version
  with status `Restart` before you `POST /System/Restart`; otherwise wait
  1–5 min and re-run the task.

## Kill switches (rehearse BEFORE default-ON — gate G-E)

| #   | switch                                                    | scope       | latency                                                                                                                                                     |
| --- | --------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | uncheck `LiteDefaultOn` (+native/subs) in plugin config   | fleet       | next manifest read + 1 boot                                                                                                                                 |
| 2   | roll the server-plugin back to a pre-flagDefaults version | fleet       | same — a reachable manifest **without** the field clears the TVs' cached defaults by design                                                                 |
| 3   | set `jellyfin.shell.liteEnabled=0` on a device            | that TV     | immediate next boot; wins over any fleet default                                                                                                            |
| 4   | SPA fallback underneath                                   | per session | OK/Back/Menu from Lite always hands off to the full SPA; a Lite exec error, missing byte cache, or no stored session falls through to the SPA the same boot |

A TV that cannot reach the manifest keeps its cached defaults (offline boots
keep behavior); the kill lands when connectivity returns.

## Stage sequence

1. **Mechanism live, defaults off** — release server-plugin ≥1.0.23.0
   (carries shell ≥1.0.87 + lite bytes). Manifest unchanged; zero fleet
   change. Verify `curl $JELLYFIN_URL/shell/manifest.json` has no
   `flagDefaults` and the live shell sha moved.
2. **QA device flag-ON soak** — explicit `jellyfin.shell.liteEnabled=1` +
   `jellyfin.lite.native=1` on the QA panel (explicit keys, so later fleet
   flips don't disturb the soak). Run the JELA-138 on-device decode/HDR
   checklist (JELA-141 comment `205003fd`) + suspend/resume cycle.
3. **Rollback rehearsal on the QA device** — flip `LiteDefaultOn` on → clear
   the QA device's explicit keys → confirm it adopts default-ON in 2 boots →
   uncheck → confirm it reverts in 2 boots (kill switch #1), then re-check →
   plugin-rollback drill only if the train changed other bytes (switch #2 is
   the same TV-side code path, already unit+harness pinned).
4. **Fleet default-ON** — `LiteDefaultOn` + `LiteNativeDefaultOn` checked.
   `LiteSubsDefaultOn` stays OFF (below). Measure G-A on-device post-flip.
5. **Post-flip checks** — configEpoch unchanged by the flip; no spurious
   resume reloads (G-C surface); Instant-Home/SPA path intact for TVs that
   decline (no session / no cached bytes).

## Subtitle behavior is BY DESIGN, not a bug (JELA-151 decision)

The C5 rollout ships with `SubtitleProfiles: []`: **every subtitle-selecting
session intentionally declines the native path and rides the SPA.** Native
decline logs showing `SubtitleCodecNotSupported` after the flip are the
system working as decided, not a regression. Measured impact: all 7 real
users are `OnlyForced`/eng; only 89/4206 items (2.1%, forced-sub carriers)
plus remembered manual sub selections are affected, and those play correctly
in the SPA — the failure mode is perf-only, never lost functionality.

Lifting the exclusion is JELA-152 (External srt profile + Lite cue engine,
merged flag-dark): `LiteSubsDefaultOn` flips only after its real-panel gate
(a user-selected sub visibly renders in native playback) passes — it is NOT
part of the C5 default-ON. When it does flip, subbed text-sub items
direct-play/remux natively with Lite-rendered cues; PGSSUB/DVDSUB items keep
riding the SPA (burn-in) permanently.

## Acceptance evidence (issue JELA-141)

- G-A: home usable ≤3s measured on-device post-flip (emulated reference:
  Lite live-boot ms on the JELA-112 harness vs the 13.4s WS-0 SPA baseline).
- G-E: rollback rehearsal evidence (stage 3) BEFORE stage 4.
- No regression: suspend/resume (resume-epoch surfaces), SPA fallback
  (handoff + no-session paths), configEpoch stability across the flip.
