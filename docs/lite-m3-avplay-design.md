# JELA-67 M3 — Native AVPlay playback for JellyPlug Lite (design)

Status: APPROVED — CEO design review 2026-07-12 (PR #118 comment 4951415733); next: go/no-go device spike on the Q60R.
Scope: the M3 phase of JELA-67 ("Native playback: Tizen AVPlay pipeline for
direct-play items so the 90% path — boot → browse → play → resume — never
touches the SPA"). Everything here is flag-dark and independent of the
v2.0.24 / v1.0.80–81 deploy hold.

## 1. Where M3 plugs in

Today (M2, code-complete on main):

- Lite home boots from the LS byte-cache; `app.onOpen(item)` in the shell
  lite-loader (`shell.js`, `maybeBootLite`) hands EVERY OK-press to
  `toSpa("#/details?id=…&serverId=…")` — full SPA teardown + boot.
- The idle-deferred bg-warm (v1.0.81) only softens that cost; the SPA still
  owns playback.

M3 forks `app.onOpen`:

```
OK on a card
 ├─ item is a playable leaf (Movie / Episode / Video / MusicVideo)
 │   ├─ PlaybackInfo says direct-play OK  →  NATIVE: Lite player (AVPlay)
 │   └─ transcode / odd format / any error →  toSpa details deep-link (M2 path)
 └─ container item (Series / BoxSet / Playlist) → toSpa details deep-link (M2 path)
```

The SPA path stays byte-identical as the universal fallback. Native playback
failing at ANY point before first frame falls through to `toSpa` — the user
is never stuck, worst case is exactly today's M2 behaviour.

## 2. Hard prerequisite: a WGT event (privileges cannot be flag-flipped)

Audit of both widgets on main (`packages/shell-tizen-bootstrap/src/config.xml`
v2.0.23, `packages/shell-tizen/tizen/config.xml` v1.0.81):

- Privileges today: `productinfo`, `tv.inputdevice` only. **No
  `http://developer.samsung.com/privilege/avplay`.**
- **No `<script src="$WEBAPIS/webapis/webapis.js">` include in either
  index.html** — `webapis.*` is never injected. (Side-effect: the existing
  qa-beacon `webapis.productinfo.getDuid()` branch can never have fired; the
  include fixes that for free.)

AVPlay therefore needs a new signed WGT carrying:

1. `<tizen:privilege name="http://developer.samsung.com/privilege/avplay"/>`
   (both config.xml files — parity rule).
2. `<script src="$WEBAPIS/webapis/webapis.js"></script>` in the widget
   index.html, before the bootstrap IIFE. On-TV this resolves from the
   platform; in desktop QA it 404s harmlessly (`webapis` guarded everywhere).
3. NOT included: `drmplay` — Jellyfin direct play is unencrypted; DRM is out
   of scope for Lite entirely.

**Recommendation — do NOT touch v2.0.24's scope.** v2.0.24
(background-support flip + resume configEpoch check) is green-lit with an
exact scope by the user and blocked on their tree hold; folding privileges in
would reopen that approval. Instead:

- **Spike**: build a local dev WGT (`v2.0.25-dev`, privileges + include only)
  and side-load it on the Q60R via the human-free `sdb push` +
  `0 vd_appinstall` recipe. Never rides the release train.
- **Production**: after a GO spike verdict, ship `v2.0.25` (privileges +
  include, no behaviour change — inert without the flag) on the normal rail
  whenever convenient after v2.0.24. Lite native stays behind its own flag
  until the WGT is on both panels.

## 3. Playback decision: PlaybackInfo, not URL guessing

On OK for a playable leaf:

```
POST {base}/Items/{id}/PlaybackInfo?userId={userId}
body: { DeviceProfile: <M63 profile>, AutoOpenLiveStream: false }
```

- Pick the first MediaSource with `SupportsDirectPlay === true` →
  `{base}/Videos/{id}/stream.{container}?static=true&mediaSourceId={msId}&api_key={token}`.
- `SupportsDirectStream` (server remux, no transcode) is a cheap follow-up —
  slice 3 candidate, off by default in the spike.
- Anything else (TranscodingUrl only, error, timeout ≥ 3s) → `toSpa` details
  deep-link. Timeout matters: PlaybackInfo is one POST on a LAN server,
  but the fallback must be prompt.

M63 (2019, Tizen 5.0) device profile — deliberately conservative for the
spike, widened only with on-device evidence:

- Containers: `mp4,mkv,mov` · Video: `h264` (L5.1), `hevc` (main/main10)
- Audio: `aac,mp3,ac3,eac3` · MaxStreamingBitrate ~40 Mbps (LAN)
- No subtitle profiles in the spike (see §6).

## 4. Player module (`Lite.createPlayer`, lite.src.js)

Same pattern as the rest of Lite: pure-ES5, dependency-injected, node-testable.

- **AVPlay adapter injected** (`opts.avplay`), real impl =
  `webapis.avplay` wired in `Lite.boot` when
  `typeof webapis !== "undefined" && webapis.avplay`; absent → player
  reports "unsupported" and onOpen falls back to toSpa. Node tests fake the
  adapter (same trick as `fetchJson` / image pool).
- **Lifecycle**: `open(url) → setListener → setDisplayRect(0,0,vw,vh) →
prepareAsync → (resume? seekTo(posMs)) → play`. `back`/error/exit →
  `stop() + close()` ALWAYS (leaked players wedge the platform pipeline).
- **Video plane / canvas hole**: AVPlay renders on a plane BEHIND the web
  layer; pixels above it must be transparent. The Lite home canvas paints an
  opaque bg, so on play we hide the home canvas and show a dedicated
  OSD canvas cleared to transparent (`clearRect`), drawing only OSD widgets.
  `document.body` background must also be transparent during playback.
  **This interaction is spike gate G2 — if the hole doesn't work on the M63
  web runtime we redesign the OSD (destroy canvas + absolutely-positioned
  minimal DOM; still no SPA).**
- **OSD**: reuses Lite renderer idioms — title, play/pause glyph, seek bar
  (position/duration from `getCurrentTime`/duration), buffering spinner on
  `onbufferingstart/…progress/…complete`. Auto-hides after ~4s idle; any key
  re-shows.
- **Keys** (`tv.inputdevice` privilege already present): OK = play/pause;
  left/right = seek −10s/+30s (repeat compounds); down = OSD show; back =
  stop → restore Lite home (canvas re-shown, input re-attached, focus
  preserved, Resume row locally patched with the new position). Register
  `MediaPlayPause`, `MediaPlay`, `MediaPause`, `MediaRewind`,
  `MediaFastForward` alongside the existing key set.
- **Progress reporting** (what makes "resume" real): POST
  `/Sessions/Playing` on start, `/Sessions/Playing/Progress` every 10s +
  on pause/seek, `/Sessions/Playing/Stopped` (final PositionTicks) on
  stop/back/error. Fire-and-forget XHR, same `X-Emby-Token` header;
  `PlaySessionId` comes from the PlaybackInfo response.
- **Resume entry**: `UserData.PlaybackPositionTicks` already arrives on the
  home-sections items — carried onto the card model (`posTicks`,
  `runtimeTicks`) so the player can seek without an extra fetch.
- **v2.0.24 interplay**: once background-support=enable ships, backgrounding
  during playback must `avplay.suspend()` / `restore()` on
  visibilitychange, and the v2.0.24 resume-time configEpoch teardown must
  treat "player active" as: stop+close the player FIRST, then decide. Noted
  here so the v2.0.24 implementation (JELA-66) and M3 don't collide; the
  spike runs pre-v2.0.24 so nothing blocks.

Flag: new `jellyfin.lite.native` (default OFF) gating only the onOpen fork —
Lite home can ship/deploy fully without native playback. Diag:
`__shellLite.player = {st: idle|info|preparing|playing|paused|err|closed,
ms: prepare→firstFrame, url: none-vs-direct}` for CDP QA.

## 5. Spike plan (go/no-go gate, pre-registered — same discipline as M2 jank)

Needs: Q60R re-debugged (known recipe), dev WGT v2.0.25-dev side-loaded,
a LAN test movie (h264/mp4 + one hevc/mkv). Panels are currently OFF —
spike runs whenever one comes back.

| Gate                   | Pass bar                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 prepare→first-frame | < 3s, LAN h264 mp4 direct-play                                                                                                                                |
| G2 canvas hole         | video visible under transparent OSD canvas; OSD text renders above video                                                                                      |
| G3 seek                | ±10s seek settles < 1.5s median (5 seeks)                                                                                                                     |
| G4 exit                | back → Lite home interactive < 500ms, `close()` verified **and `getCurrentTime()` stops advancing after `close()`**, second playback works (no pipeline leak) |
| G5 resume loop         | Progress lands server-side (UserData position moves); re-entering item resumes within ±5s                                                                     |

Verdict handling: all-pass → M3 GO, slices below. G2-only failure →
DOM-OSD variant, re-spike. G1/G3/G4 fail → M3 NO-GO, SPA stays the playback
path permanently (M2 bg-warm already softens it), issue re-scoped.

Additional check (CEO review, non-gating): once the `webapis.js` include
ships in a WGT (v2.0.25-dev for the spike, v2.0.25 for production),
stopwatch one full Lite boot to confirm the extra script include does not
move the launch→navigable-home number.

## 6. Slices after a GO verdict

1. **Slice 1** — WGT v2.0.25 (privileges + webapis include, both config.xml,
   no behaviour change) + `Lite.createPlayer` skeleton with fake-adapter node
   tests + onOpen fork behind `jellyfin.lite.native` (default off).
2. **Slice 2** — PlaybackInfo client + progress reporter + resume seek +
   OSD; on-device QA vs gates G1–G5 as acceptance.
3. **Slice 3 (optional)** — DirectStream remux acceptance, hevc/main10
   profile widening per device evidence.
4. **Deferred to backlog (explicitly NOT M3)**: audio/subtitle track
   selection, external subtitle rendering (setExternalSubtitlePath is
   model-flaky), trickplay thumbnails, DRM, 4K UHD property tuning.

## 7. Open questions — RESOLVED (CEO review 2026-07-12, PR #118 comment 4951415733)

1. Direct-play only in the spike, DirectStream as slice 3 — **agreed**.
2. `v2.0.25` as its own tiny WGT release after v2.0.24 — **agreed**; do NOT
   reopen the held v2.0.24 scope.
3. Seek step left/right = −10s/+30s (Netflix-style asymmetric) — **keep**.
