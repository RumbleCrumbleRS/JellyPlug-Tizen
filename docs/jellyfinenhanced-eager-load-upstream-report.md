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
  double-counted): **2.5–2.8 MiB uncompressed across 157–179 requests, ~15%
  of the 16.5 MiB cold boot**, landing in a single burst that is fully
  issued by ~2.4 s with in-flight concurrency to the server peaking above 130. The spread across boots is server config, not measurement error —
  which modules the loader appends depends on which JE features are enabled.

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

## Timing evidence policy — RE-RUN LANDED, first numbers superseded

The original ring ran while the server failed preflight gate B all session,
and its "ALLJE −1.6 s, 95% CI 0.2–2.8 s" headline **does not survive a clean
gate**. It has been removed from the draft below. The re-run (n=7,
interleaved, shuffled within cycle, `preflight.sh` CLEAR before and after)
gives, on the pre-registered statistic (paired median):

```
cyc |  CTL  DEFER  ALLJE   (firstCard ms)
  1 | 5496   2690   2026
  2 | 2063   2672   1769
  3 | 2042   2032   2086
  4 | 2144   2027   1962
  5 | 2007   2859   2328
  6 | 6008   2682   1920
  7 | 3825   2069   1774

CTL − DEFER  median  +117 ms  95% CI [-609, 2806]   mean  +936 ms  CI [-164, 2132]
CTL − ALLJE  median  +294 ms  95% CI [ -44, 3470]   mean +1389 ms  CI [ 217, 2700]
```

**On the pre-registered endpoint this is a null**: both median CIs include
zero. Per the JELA-690 framing that is _"not resolvable at this n on this
box"_ — never "confirmed", never "killed".

What the re-run did surface is that the effect is not a median shift at all,
it is **a race with a bimodal outcome**, and that shape is what we report
upstream because it is mechanism-grounded rather than statistical:

- 3 of 7 control boots ran **3,825 / 5,496 / 6,008 ms**; the other 4 ran
  **2,007–2,144 ms**. No intervention boot in either arm exceeded 2,859 ms
  (0 of 14).
- In the slow control boots, **5.18 MiB / 422 requests** had completed
  before the first card. In the fast control boots, **2.38 MiB / 192
  requests**. The ≈2.8 MiB difference is the JE module set.
- Host load does not explain it: the slow boots started at a _lower_ loadavg
  (median 1.87) than the fast ones (2.27), so this is not the
  JELA-682 shared-box confound.

So first card is racing the JE fan-out drain. It either wins (≈2.0 s) or
loses (≈3.8–6.0 s). A paired median over a bimodal arm reports the modal
outcome and hides the tail — which is why the pre-registered statistic reads
null while the arm maxima differ by 3.7 s.

**Post-hoc, flagged as such:** the ">3 s" split above was chosen after seeing
the data. All 3 slow boots falling in the 7 control boots has Fisher
one-sided p = 0.026, but that p-value is not pre-registered and should not be
quoted as a result. A confirmatory ring would pre-register "fraction of boots
over 3 s" as the endpoint. The mean-difference CI for CTL−ALLJE excludes zero
([217, 2700] ms) and is the better summary of _user-visible_ cost for a race
like this, but it is also not what was pre-registered.

## Drain evidence (JELA-726) — the cost is execution, not download

Two further cold boots on the same rig, gate CLEAR before and after,
measured the fan-out directly rather than through an A/B:

- 179 `/JellyfinEnhanced/js/*` requests, 2,853 KiB, all uncompressed.
- Every one is **issued** by 2,391 ms. The last one does not **finish** until
  **5,833 ms**.
- The server answers each in **under 1 ms** (`x-response-time-ms`).

The 3.4 s tail is therefore neither server time nor network time — it is the
M63 renderer draining ~250 concurrent responses while the main thread is
blocked. Both boots show it as a hard network-idle window (3.0–6.0 s and
3.0–5.5 s) with the responses already on the wire. This is _execution_ cost,
not parse cost, so it does not contradict the ~2% parse figure from M63
boot-cost work — it is a separate cost that a byte count understates. It also
lines up exactly with the race above: 5,833 ms is where the losing control
boots land.

Note this changes the relative weight of the two upstream asks. Compressing
the bodies (ask 2) cuts the bytes but not the 179 requests and not the drain
tail; only lazy-loading (ask 1) removes those. Our own server-side gzip of
this route (JELA-727, ~2,853 → ~713 KiB) is a local mitigation that
deliberately does **not** overlap with ask 1.

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
> TV-class devices run old engines (Tizen 5.0 = Chromium 63) on weak SoCs,
> and the cost there is not really the download — it is the drain. In a
> traced cold boot, all 179 module requests are **issued by 2.4 s**, the
> server answers each in **under 1 ms**, and yet the last response body does
> not **finish** until **5.8 s**. The waterfall shows a hard network-idle
> window from ~3 s to ~5.8 s with the responses already on the wire: the
> renderer is working through ~250 concurrent module responses on a blocked
> main thread. Compression would shrink the bytes but would not remove that
> window; only not requesting the modules would.
>
> The user-visible effect is a race. In a 3-arm interleaved A/B on our rig
> (n=7, cycles shuffled, CDP URL blocking), 3 of 7 unmodified boots painted
> their first card at 3.8–6.0 s and the other 4 at ~2.0 s, while **no boot
> with `/JellyfinEnhanced/js/*` blocked exceeded 2.9 s** (0 of 14 across both
> intervention arms). In the slow boots ~5.2 MiB had landed before the first
> card versus ~2.4 MiB in the fast ones — the difference is the module set.
> First card either beats the fan-out or waits behind it.
>
> In fairness to the numbers: on our pre-registered statistic (paired median)
> the confidence intervals include zero at n=7, so we are **not** claiming a
> confirmed median win, and the bimodal split is a post-hoc reading. The byte
> counts, request counts and the 2.4 s→5.8 s issue-to-finish gap are exact
> measurements, not inferences, and they are the part of this report we would
> ask you to act on.
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

## Local mitigation — STAYS PARKED, and now for a known reason

If upstream is slow: the shell already interposes on script loading for the
tx transform, so a boot-window deferral list for known non-critical plugin
modules is expressible there (`maybeTranspile`/`__txGet` layer).

The ticket's condition for building it was "the re-run ring under a clean
gate shows a clear result". The gate is now clear and **the ring came back
null on the pre-registered endpoint**, so that condition is not met and the
spike stays parked. Two further reasons not to build it yet:

- The `DEFER` arm — which is exactly what this mitigation would implement —
  is the _weaker_ of the two arms (median +117 ms, CI [-609, 2806]; mean
  +936 ms, CI [-164, 2132]) and its per-arm median (2,672 ms) is worse than
  the control's (2,144 ms). Only `ALLJE`, which blocks the whole plugin, has
  a mean CI that clears zero. If the goal is "don't pay for JE at boot", the
  sibling lever that defers JE injection entirely (measured −3,340 ms,
  p = 0.0024) dominates this one and is already tracked separately.
- It is a sharp tool pointed at a third-party plugin's load order, so it
  needs QA against JELA-696's failure mode: a boot-path change that killed
  every native card surface while `onerror`/`unhandledrejection` both stayed
  at 0.

The next measurement that would actually change this decision is a
confirmatory ring with "fraction of boots over 3 s" pre-registered as the
endpoint, at a larger n than 7.
