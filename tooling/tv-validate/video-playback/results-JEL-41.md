# JEL-41 results — Video playback compare (browser vs Tizen TV)

**Server:** Jellyfin 10.11.10 (Test) · **Harness:** `verify-video-playback.mjs`
· **Engine:** headless Chrome-for-Testing 149 (browser mode) + Samsung Tizen 5.0
/ Chromium 69 UA override + `NativeShell` shim (Tizen mode) · **Status: PASS**

The shell's `getDeviceProfile` carries **no codec logic** — it delegates to
jellyfin-web's `profileBuilder` with `{ enableMkvProgressive:false,
enableSsaRender:true }` (`shell.js:518`). The harness confirmed the Tizen path
actually routes through that shim (`__nsProfileCalls === 1`, `NativeShell`
present, `browser.tizen` true).

## 1. Playback starts without error ✅

Every `/PlaybackInfo` negotiation returned 200 with a `PlaySessionId` and a
usable `MediaSources[0]` — movie and episode, browser and Tizen. No client-side
exception in either mode.

## 2. Device profile is appropriate for the TV ✅

The captured `DeviceProfile` (what the client actually sends) differs exactly as
expected for Samsung TV hardware:

|                     | Browser | Tizen TV |
| ------------------- | ------- | -------- |
| DirectPlayProfiles  | 18      | **31**   |
| TranscodingProfiles | 11      | 10       |
| CodecProfiles       | 6       | 6        |

**Direct-play formats the TV adds (hardware decoders), not present in browser:**
HEVC (`mkv/mp4/ts/mpegts/m2ts/hls/m4v/avi`), MPEG-2, VC1, MS-MPEG4v2, plus whole
legacy containers `wmv/asf/avi/flv/3gp/mpeg/mpg/vob/vro/mts/trp/ts/m2ts`.

**Direct-play formats only the browser claims:** `hls/av1`, `hls/vp9` (desktop
software decode; the TV profile keeps AV1/VP9 in `mp4/mkv/webm` but not over HLS).

This matches Samsung TV reality: broad hardware container/codec support
(HEVC/VC1/MPEG-2/WMV) that a desktop browser lacks.

## 3. Direct-play vs transcode decision is correct ✅

Per-item server decisions under each profile (random picks this run):

| Item                                         | Source                            | Browser decision                                                      | Tizen decision                                                       |
| -------------------------------------------- | --------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Pirates of the Caribbean: DMTNT**          | mkv · HEVC Main 10 · 4K · aac     | transcode → HLS — `VideoCodecNotSupported, AudioChannelsNotSupported` | transcode → HLS — `VideoProfileNotSupported, VideoLevelNotSupported` |
| **South Park — "The Death of Eric Cartman"** | mkv · h264 High · 1080p · **ac3** | **transcode → HLS** — `AudioCodecNotSupported`                        | **DIRECT PLAY** ✅                                                   |

Two correct, distinct decisions:

- **Episode (headline):** the same h264/ac3 MKV that the **browser must transcode**
  (no ac3 passthrough) the **TV direct-plays** — `SupportsDirectPlay:true`, no
  `TranscodingUrl`. This is the format/codec gap the TV's HW profile closes.
- **Movie:** both transcode, but for the _right different reasons_ — the browser
  can't decode HEVC at all (`VideoCodecNotSupported`); the TV _can_ (HEVC is in
  its direct-play list) but this file's **Main 10 profile + level** exceeds the
  profile's HEVC constraints, so it correctly falls back to transcode. Decision
  logic is sound on both paths.

## 4. Resume / seek position is correct ✅

Resumable item **Hotel Transylvania 2** at `12 935 650 000` ticks ≈ **1294 s** of
**5358 s**. Re-running negotiation with that `StartTimeTicks` succeeds. The shell
does **not** touch playback position — `NativeShell.AppHost` exposes no
playback/seek hook (see the contract block in `shell.js`), so resume is 100%
jellyfin-web client logic and the offset round-trips through PlaybackInfo intact.

## Codec/container notes

- The Tizen direct-play additions are **UA-gated** in jellyfin-web (asserted from
  `browser.tizen`, not probed), so they reproduce faithfully off-device.
- The shell's `enableMkvProgressive:false` keeps MKV out of _progressive/HTTP_
  direct play (forcing HLS for MKV-over-http) while HW direct play of the
  container is still offered — appropriate for the TV.
- `enableSsaRender:true` enables external SSA/ASS subtitle rendering (3 subtitle
  profiles in both modes).

## Limitation (device-only)

The UA-gated list is jellyfin-web _claiming_ Samsung HW support; whether the TV's
Chromium-63 webview + AVPlay actually decodes/renders a given file can only be
confirmed on the physical set via REST/`__shellDiag` (no framebuffer capture is
possible — JEL-7). This harness proves **the profile sent and the decision made
are correct**; final pixels-on-panel for an HEVC/VC1 title remain a physical-TV
check. Recommend a one-time on-device spot-check of an HEVC and a VC1 title
against this profile when the set is available.

_Raw report: `last-run.json` (rotates each run; random item picks vary)._
