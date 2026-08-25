# JellyfinEnhanced eager module load — upstream report (JELA-713)

Status: **DRAFT — not yet filed.** Filing target: `n00bcodr/Jellyfin-Enhanced`
(the repo the plugin's own release-notes module names as `GITHUB_REPO`).
Verified against upstream `main` at release `12.4.1.0` (2026-08-23), whose
`js/plugin.js` is byte-identical to what our production server serves.

## What we verified at upstream HEAD (do not re-derive)

- `js/plugin.js` declares `allComponentScripts` with **149 module entries**
  and `await loadScripts(allComponentScripts, basePath)` fires one
  `<script async=false>` per entry, all appended in one synchronous loop —
  every module downloads at boot, before any feature is used. A handful of
  extra modules (`others/splashscreen.js`, `extras/login-image.js`,
  `enhanced/translations.js`) load separately, which is how a cold boot
  observes ~157 requests under `/JellyfinEnhanced/js/`.
- `Controllers/JellyfinEnhancedController.cs` → `GetScriptResource` serves
  each module as a raw `FileStreamResult` from the embedded resource stream.
  It sets `Cache-Control: public, max-age=31536000, immutable` (correct — the
  URLs are `?v={version}-{dllTimestamp}` pinned) but there is **no
  compression**: a cold boot pays the full uncompressed byte cost. Our CDP
  trace confirms encoded ≈ decoded bytes on every module body.
- Boot cost measured on a Tizen 5.0-class device profile (Chromium M63, CDP
  Network domain, not Resource Timing, so CORS preflights are not
  double-counted): **~2.5 MiB uncompressed across 157 requests, 15% of the
  16.5 MiB cold boot**, landing in a single burst at ~1.5–2.8 s with
  in-flight concurrency to the server peaking above 130.

## What is deliberately NOT in the report

The `core/navigation.js` wrong-base 404×5 burst the JELA-713 ticket flagged
is **not a JellyfinEnhanced bug**. It is our own shell's JEL-131 tx-cache
primer (`__txScrapeBodies`/`probe()` in `packages/shell-tizen/src/shell.js`):
it scrapes the JE loader body for module-name literals, then probes
`names[0]` (= `core/navigation.js`) across up to six candidate directory
literals from the same body and commits to the one that answers 200
(`/JellyfinEnhanced/js`). The five 404s are the losing probes, by design
("wrong guesses cost ~4 probe 404s"), fire once per cold profile, and skip
entirely on a warm one. Do not report this upstream and do not "fix" it
locally without reading the JEL-131 block comment first.

## Timing evidence policy

The 3-arm ring (CTL / DEFER / ALLJE, n=7, CDP URL blocking) from JELA-706 is
quoted in the draft below with its own caveats: ALLJE −1.6 s median with a CI
that barely excludes zero, DEFER's CI includes zero, and the control arm
spread was 3.9 s because the server failed preflight gate B for that whole
session. A re-run under a clean preflight is queued (`/tmp/jela706/run713.sh`,
results land in `/tmp/jela706/ring713-analysis.txt`); update the numbers
below from that analysis before or shortly after filing.

---

## Draft issue body (file verbatim to `n00bcodr/Jellyfin-Enhanced`)

Title: **plugin.js eagerly loads all 149 component modules at boot (~2.5 MiB
uncompressed) — dominates cold-boot network on TV-class devices**

> **Environment:** Jellyfin Enhanced 12.4.1.0 (also verified against current
> `main` — `js/plugin.js` is identical), Jellyfin 10.11, measured on a
> Tizen 5.0-class TV profile (Chromium M63) with a CDP Network-domain trace.
>
> **What happens**
>
> `js/plugin.js` builds `allComponentScripts` (149 entries) and
> `loadScripts()` appends one `<script async=false>` per entry in a single
> synchronous loop, so every module downloads and evaluates at boot, before
> any feature is used. On a cold boot we measure:
>
> - **~2.5 MiB uncompressed across ~157 requests** under
>   `/JellyfinEnhanced/js/` (the array plus the separately-loaded splash
>   screen / login image / translations) — **15% of the 16.5 MiB the whole
>   cold boot pulls**.
> - The burst lands at ~1.5–2.8 s, and in-flight request concurrency to the
>   server peaks above **130**, right when the web client is fetching the
>   data it needs to paint the home screen.
> - `GetScriptResource` serves the bodies with
>   `Cache-Control: … immutable` (good) but **no compression**, so a cold
>   or updated client pays the full byte cost. These are text files that
>   typically compress 3–4×.
>
> By subtree, uncompressed KiB on the wire:
>
> | KiB | subtree                    |
> | --: | -------------------------- |
> | 223 | `enhanced/hiddencontent`   |
> | 210 | `jellyseerr/*`             |
> | 185 | `extras/*`                 |
> | 172 | `enhanced/settingspanel/*` |
> | 169 | `jellyseerr/moreinfo/*`    |
> | 166 | `jellyseerr/ui/*`          |
> | 161 | `tags/*`                   |
> | 153 | `enhanced/player/*`        |
> | 146 | `core/*`                   |
> | 135 | `enhanced/bookmarks/*`     |
> | 115 | `elsewhere/*`              |
> | 115 | `arr/requests/*`           |
> | 107 | `arr/calendar/*`           |
>
> The two largest single files in our entire boot after the jellyfin-web
> framework bundles are `enhanced/settingspanel/ui-panel-template.js`
> (78 KiB) and `enhanced/player/playback.js` (68 KiB) — a settings panel and
> a player overlay, neither on the path to a home row.
>
> **Why it matters on TVs**
>
> TV-class devices run old engines (Tizen 5.0 = Chromium 63) on weak SoCs;
> 2.5 MiB of extra JS download + parse + eval at boot competes directly with
> the home screen. In a 3-arm interleaved A/B on our rig (n=7, CDP URL
> blocking), blocking all `/JellyfinEnhanced/js/*` moved median first-card
> time by **−1.6 s** (95% CI 0.2–2.8 s), and blocking only the feature
> subtrees (jellyseerr, arr, elsewhere, awards, settingspanel, player,
> bookmarks, extras) showed a similar-sized but noisier shift. We offer these
> as directional numbers, not precision claims — but the byte and request
> counts above are exact.
>
> **The ask**
>
> 1. **Lazy-load the feature subtrees on first use** instead of at boot.
>    `jellyseerr/*`, `arr/*`, `elsewhere/*`, `awards/*`,
>    `enhanced/settingspanel/*`, `enhanced/player/*`,
>    `enhanced/bookmarks/*`, `extras/*` together are roughly **1.4 MiB** —
>    none of it is needed until the user opens that surface, and
>    `loadScripts()` already returns a promise, so a
>    `JE.require(subtree)`-style gate in front of each feature's init would
>    keep the dependency-order guarantees the array encodes today.
> 2. **Compress the module bodies.** Either enable response compression for
>    the `js/{**path}` route or embed precompressed (`.js.gz`) resources and
>    serve with `Content-Encoding: gzip`. With `immutable` already set this
>    is a one-time cost per version, ~3–4× smaller.
>
> Happy to help with a PR for either piece if useful.

---

## Local mitigation (parked pending the ring re-run)

If upstream is slow: the shell already interposes on script loading for the
tx transform, so a boot-window deferral list for known non-critical plugin
modules is expressible there (`maybeTranspile`/`__txGet` layer). That is a
sharp tool pointed at a third-party plugin's load order — per the ticket, do
not build it until the re-run ring (clean preflight) shows a clear gate, and
QA it against JELA-696's failure mode (a boot-path change that killed every
native card surface while `onerror`/`unhandledrejection` stayed 0).
