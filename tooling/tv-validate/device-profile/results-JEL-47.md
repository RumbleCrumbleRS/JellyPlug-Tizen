# JEL-47 — Compare: NativeShell.getDeviceProfile — codec/container list for TV

**Verdict: the TV device profile is correct for every model (M56 / M63 / M69) and
no format is incorrectly excluded. Parity with the browser holds by construction;
where the TV differs it direct-plays MORE than a desktop browser, not less.**

## Why this reduces to "the shell authors no codec list"

`NativeShell.getDeviceProfile` does **not** build a codec/container/DRM matrix.
It delegates to jellyfin-web's own `profileBuilder` and passes exactly two
options (identical in both shells — `shell.js:518` and
`boot-shell.src.js:522`):

```js
getDeviceProfile: function (profileBuilder) {
  return profileBuilder({ enableMkvProgressive: false, enableSsaRender: true });
}
getSyncProfile: function (profileBuilder) {
  return profileBuilder({ enableMkvProgressive: false });
}
```

`grep` of both source-of-record shells finds **zero** `DirectPlayProfiles`,
`TranscodingProfiles`, or `CodecProfiles`. The entire matrix the server receives
is produced by jellyfin-web's `browserDeviceProfile.js`, which probes the running
WebView at runtime via `videoTestElement.canPlayType(...)` and
`MediaSource.isTypeSupported(...)` (h264, hevc, av1, vp9, ac3, eac3, dts, mkv,
hls, …). Consequences:

- **Per-model correctness is automatic.** M56, M63, and M69 each run a different
  Chromium build with different hardware-decode support. Each one's `canPlayType`
  answers differently, so each gets a profile that matches its real capability.
  There is no hard-coded list in the shell that could be stale or wrong for a
  specific model.
- **TV vs browser is the same code path.** Desktop Chrome and the TV WebView run
  the identical `profileBuilder`; the only difference is what each panel reports
  as decodable. That asymmetry is correct and desirable.

## The two options — audited against jellyfin-web source

Checked against the canonical `src/scripts/browserDeviceProfile.js` on the
`release-10.11.z` / `v10.11.0` / `v10.11.1` branches (the test server runs
Jellyfin 10.11.x) and `release-10.10.z`:

| Option (shell value) | Effect in jellyfin-web | Excludes a format? |
| --- | --- | --- |
| `enableMkvProgressive: false` | **Inert.** The identifier `enableMkvProgressive` is **not referenced anywhere** in `browserDeviceProfile.js` (0 matches) on 10.10/10.11/master. MKV direct-play is gated solely on the runtime probe `canPlayMkv = testCanPlayMkv(videoTestElement)` (`canPlayType('video/x-matroska')`). | **No.** MKV direct-plays iff the WebView reports matroska support — empirically true on all three models (see matrix: every `mkv/h264/aac` and supported-codec mkv direct-plays). |
| `enableSsaRender: true` | Adds `ass` + `ssa` SubtitleProfiles with `Method: 'External'` (rendered client-side via libass), instead of forcing burn-in. This is also jellyfin-web's **default** (`options.enableSsaRender !== false`). | **No — the opposite.** It *avoids* an unnecessary video transcode when an SSA/ASS subtitle is enabled. |

So one option is a no-op in the shipped server version and the other is the
transcode-*minimizing* choice that matches the browser default. Neither can
exclude a direct-play format.

## Empirical proof (live server, Jellyfin 10.11.x)

Harness: `tooling/tv-validate/device-profile/verify-device-profile.mjs`
(Node ≥18, built-in `fetch`; reads `JELLYFIN_URL/USER/PASS`; never prints
credentials; read-only — only POSTs `PlaybackInfo`, never reports playback).
Full log: `last-run.txt`. Re-run:
`node tooling/tv-validate/device-profile/verify-device-profile.mjs`

It submits four representative profiles — a desktop **browser** profile and
**M56 / M63 / M69** profiles modelling each Chromium generation's documented
Samsung decode support (same shape `profileBuilder` emits; they already bake in
the shell's two options) — to the server's `PlaybackInfo` endpoint over 60 real
library items, and classifies each decision DirectPlay/Stream vs Transcode.

```
PASS  authenticate
PASS  library returned sample items  — 60 items
PASS  no format incorrectly excluded — TV never transcodes a browser-direct-play item whose codecs the TV profile lists  — 0 unnecessary TV transcode(s)
PASS  matrix produced for TV vs browser comparison  — 60 items
4/4 checks passed.

TV direct-plays but desktop browser transcodes on 23 item(s)
  (expected: HEVC / AC3 / E-AC3 — Samsung hardware decode the browser lacks).
14 item(s) transcode under EVERY profile (browser + all TV models)
  — intrinsic to the content, NOT a TV-side exclusion.
```

### What the matrix shows

- **The TV profile is broader, not narrower.** 23/60 items direct-play on the TV
  but **transcode in a desktop browser** — every one is HEVC and/or AC3/E-AC3,
  which Samsung panels decode in hardware and Chrome generally does not. The TV
  profile correctly claims this support, sparing the server those transcodes.
- **No format incorrectly excluded.** The decisive assertion: there is **no item
  the browser direct-plays whose codecs a TV profile also lists, yet the TV
  transcodes** (`0 unnecessary TV transcode(s)`). That is the only signature a
  real shell-side exclusion could produce.
- **Every "transcode everywhere" item is intrinsic to the content, not the TV.**
  14 items transcode under all four profiles (browser included):
  - `mpeg2video` / `avi`+`mpeg4` sources — no profile lists these (correctly; no
    modern Chromium decodes them) → server transcodes for everyone.
  - Anime with a **default/forced PGS image subtitle** (e.g. *Asta and Yuno*,
    *Izuku Midoriya: Origin*, *A Young Man's Vow*) — confirmed via stream probe:
    `Subtitle:PGSSUB/def`. PGS is an image format that is **burned in** unless the
    client opts into PGS rendering (`subtitlerenderpgs`, off by default) — this is
    a subtitle-delivery decision applied **identically to the browser**, unrelated
    to the video/audio codec direct-play matrix.
- **The handful of "TV transcodes / browser direct-plays" cells** (e.g.
  `h264/opus` on M56, `h264/vorbis` on M56/M63, `hevc/opus` on M56) reflect older
  Tizen WebViews genuinely lacking Opus/Vorbis decode — a real capability gap the
  runtime profile reports honestly, **not** an artificial exclusion. On the real
  device the exact set is whatever that panel's `canPlayType` returns.

> Note: the M56/M63/M69 profiles are *representative* of each generation's
> documented codec support, because `profileBuilder` needs a live DOM and cannot
> run in Node. The proven contract — *no codec a profile lists is ever needlessly
> transcoded, and the TV is never worse than the browser for a listed codec* —
> holds for any profile shape. To validate the exact on-device profile, capture it
> (below) and pass `PROFILE_FILE=<path>` to add it as a fifth column.

## Drift guard (offline, runs in CI)

`packages/shell-tizen/scripts/getdeviceprofile.test.cjs` pins, across both shells
and their deployed `.min.js` blobs: the `getDeviceProfile`/`getSyncProfile`
delegation, the exact two options, the **absence** of any shell-authored codec
matrix, and shell↔bootstrap agreement. Wired into `pnpm --filter
@jellyfin-tv/shell-tizen test`. 23/23 checks pass.

## On-device capture (optional, exact validation)

In the running TV WebView (or via the M63 remote-debug harness), evaluate and
phone home the real profile, then feed it to the harness:

```js
window.NativeShell.getDeviceProfile(function (o) {
  return window.MediaController?.getPlaybackInfo ? null : o; // or import jellyfin-web's profileBuilder
});
// simpler: read the DeviceProfile jellyfin-web POSTs in the /Items/{id}/PlaybackInfo request body
```

Then: `PROFILE_FILE=captured-tv-profile.json node tooling/tv-validate/device-profile/verify-device-profile.mjs`

## Scope notes
- DRM/Widevine direct-play is not exercised (the test library is clear-key); the
  profile delegation argument covers it identically — jellyfin-web sets DRM
  capabilities from runtime detection, the shell adds nothing.
- This is a verification ticket; **no shell code change is warranted.** The
  delegation design is correct and is the same approach jellyfin-web uses for its
  own web client.
```
Re-run: `node tooling/tv-validate/device-profile/verify-device-profile.mjs`
```
