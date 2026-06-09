# JEL-43 — Compare: Audio track selection during playback (TV vs browser)

**Verdict: parity confirmed — expected behavior, no shell defect.**

Audio track selection during playback is **100% jellyfin-web + server driven**.
The Tizen shell does not implement, wrap, or customize any part of the
audio-track-selection code path, so TV behavior is identical to the desktop
browser by construction. The empirical harness
(`verify-audio-track.mjs`) exercises the actual server contract that the player
overlay drives under the hood and passes 6/6 for both a browser-like and a
TV-like device profile.

## What the shell touches (and what it doesn't)

| Concern | Owner | Shell involvement |
| --- | --- | --- |
| Audio-track selector UI (player overlay) | jellyfin-web | none |
| `playbackManager.setAudioStreamIndex` / `changeStream` | jellyfin-web | none — `grep` of `shell.js`, bootstrap, and `shell-core` finds zero references |
| Direct-play vs transcode decision | server, from device profile | `NativeShell.AppHost.getDeviceProfile` **delegates to jellyfin-web's own `profileBuilder`** (`shell.js:518`) with only `enableMkvProgressive:false, enableSsaRender:true`; the shell adds **no audio-codec list** of its own |
| Per-user "remembered track for resume" | server (`MediaSources.DefaultAudioStreamIndex`) | none — shell only persists the server URL in localStorage |
| Playback dispatch patch | shell seed (`shell.js`) | wraps `playbackManager.play` for **ServerId injection only**; switching audio goes through `setAudioStreamIndex → changeStream`, which never reaches that patch |

Because the only shell hook near playback (`pm.play` ServerId injection) is not
on the track-switch path, and `getDeviceProfile` is delegated upstream, there is
no shell code that can make audio-track selection diverge between TV and
browser. The only TV/browser difference is which codecs the **webview** reports
as directly playable — that determination is jellyfin-web's `profileBuilder`
logic running on the webview, not shell code.

## Empirical verification (live server, Jellyfin 10.11.x)

Harness: `tooling/tv-validate/audio-track/verify-audio-track.mjs`
(Node ≥18, uses built-in `fetch`; reads `JELLYFIN_URL/USER/PASS` from env; never
prints credentials; restores the shared test account's state on exit).

```
PASS  authenticate
PASS  found item with >=2 audio tracks  — "3 Men and a Little Lady" (2 tracks)
PASS  [browser] every audio track selectable via PlaybackInfo  — 1->1(tc) 2->2(tc)
PASS  [tv] every audio track selectable via PlaybackInfo  — 1->1(tc) 2->2(tc)
PASS  selected track remembered for resume  — picked idx 2, server now defaults to 2
PASS  test-account default audio index restored  — back to 1

6/6 checks passed.
```

### (1) Open the audio track selector
The server enumerates audio tracks in `MediaSources[].MediaStreams` (`Type:Audio`).
The test server has 147 items with ≥2 audio tracks (e.g. *9 to 5* exposes 5×
ac3: eng/eng/fra/spa/eng at indices 1–5). The selector is jellyfin-web's native
overlay; on TV it is the same code, rendered in the TV layout.

### (2)+(3) Switch tracks → audio changes immediately
Picking a track makes jellyfin-web POST `Items/{id}/PlaybackInfo` with the new
`AudioStreamIndex`. Verified for **every** track index, under both profiles, the
server returns a stream targeting exactly that track:
- **Transcode path** (the test server's multi-audio content is `mpeg2video`/ac3,
  so it always transcodes): the returned `TranscodingUrl` carries
  `AudioStreamIndex=<picked>` and `AudioCodec=ac3`. A fresh URL per switch ⇒ the
  player tears down and restarts the stream on the new track — the
  "changes immediately" behavior.
- **Direct-play/stream path**: the server reports the active
  `DefaultAudioStreamIndex` for the chosen track. (On a true direct-play file,
  jellyfin-web cannot switch in-container audio in Chromium/M63, so selecting a
  non-default track triggers the same PlaybackInfo re-request → remux/transcode
  to that track. Same contract, exercised above.)

### (4) Remembered for resume
The selected track is persisted **server-side, per user**: after reporting a
play session + progress carrying `AudioStreamIndex=2` and stopping, the item's
`MediaSources[0].DefaultAudioStreamIndex` flips `1 → 2`. On the next launch
(TV or browser) jellyfin-web preselects that index for resume. The harness then
restores it to the original (`→ 1`) so the shared test account is unchanged.
Persistence is keyed off the **progress report's** `AudioStreamIndex` at a
non-trivial position — not the bare PlaybackInfo call.

## Scope notes
- Not driven through a headless browser UI: Chromium-headless cannot decode the
  server's mpeg2video/ac3 content, so a player-overlay click-through would be
  flaky and prove less than this protocol-level check. The harness verifies the
  exact server calls the overlay makes.
- This server has no h264 multi-audio content, so direct-play audio-switch was
  verified by contract (PlaybackInfo re-request) rather than by a direct-play
  sample. Track switching on a direct-play title would still re-request as
  above; flagged here for transparency.
- Subtitle-track selection is the sibling task [JEL-44](/JEL/issues/JEL-44).
```
Re-run: `node tooling/tv-validate/audio-track/verify-audio-track.mjs`
```
