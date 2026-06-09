# JEL-41 — Video playback compare (browser vs Tizen TV)

Reproducible harness that verifies the four things JEL-41 asks for and notes
codec/container differences between the TV and browser device profiles.

## What it checks

For a real movie and a real episode on the live Jellyfin server, in **browser**
mode and **Tizen** mode:

1. **Playback starts without error** — the `/Items/{id}/PlaybackInfo`
   negotiation returns 200 with a `PlaySessionId` and a usable `MediaSources[0]`.
2. **Device profile appropriate for the TV** — the `DeviceProfile` the client
   actually sends is captured from the real PlaybackInfo POST and summarized
   (DirectPlay / Transcoding / Codec profiles).
3. **Direct play vs transcode decision** — the server's decision
   (`SupportsDirectPlay` / `SupportsDirectStream` / `TranscodingUrl` /
   `TranscodeReasons`) is read from the PlaybackInfo response for each item under
   each profile.
4. **Resume/seek position** — for a resumable item, the harness confirms the
   negotiation honors a non-zero `StartTimeTicks` (the value jellyfin-web derives
   from `UserData.PlaybackPositionTicks`).

## Why this is a faithful comparison — and where it stops

The shell's `getDeviceProfile` (`packages/shell-tizen/src/shell.js`) contains
**no codec logic**. It delegates entirely to jellyfin-web's own profile builder:

```js
getDeviceProfile: function (profileBuilder) {
  return profileBuilder({ enableMkvProgressive: false, enableSsaRender: true });
}
```

So the only TV-vs-browser difference the *shell* can introduce is those two
flags. Everything else is jellyfin-web's `browserDeviceProfile`, which is driven
by (a) UA-gated branches (`browser.tizen` / `tizenVersion`) and (b) the running
engine's `MediaSource.isTypeSupported` / `video.canPlayType`.

- **BROWSER mode** — default UA, no `NativeShell` (jellyfin-web's own apphost).
- **TIZEN mode** — a real Samsung **Tizen 5.0 / Chromium 69** UA override **plus**
  a `NativeShell` shim whose `getDeviceProfile` flags are byte-extracted from
  `shell.js` at runtime, so apphost routes through the exact flags the WGT ships.
  (The shim is injected with `Page.addScriptToEvaluateOnNewDocument`; the login
  navigation is routed through `about:blank` so it lands on a *new document* and
  the shim actually fires — a same-URL hash nav is same-document and would skip it.)

**What this reproduces faithfully:** jellyfin-web 10.11's Tizen codec additions
are **UA-gated** — when `browser.tizen` is true it *asserts* the Samsung
hardware-decoder format list (HEVC, VC1, MPEG-2, WMV/ASF, AVI, MPEG-TS, …)
rather than probing the engine. That list is engine-independent, so the Tizen UA
+ shim here produces the same DirectPlayProfiles the real TV sends (31 vs the
browser's 18 in `last-run.json`), and the **server-side direct-play/transcode
decision** is the genuine one for real media.

**Limitation (not hidden):** the UA-gated list is jellyfin-web *claiming*
Samsung HW support; whether the TV's Chromium-63 webview + AVPlay actually
decodes and renders a given file can only be confirmed on the physical set
(REST / `__shellDiag` — no framebuffer capture is possible, see the JEL-7
memory). So this harness proves the profile sent and the decision made are
correct; it does not prove pixels on the panel. See `results-JEL-41.md`.

## Run

```bash
# 1. bring up a real headless Chromium with CDP on :9222.
#    Any headless Chrome/Chromium works; the JEL-33 PR ships a no-root
#    bootstrap (tooling/tv-validate/dpad-nav-test/bootstrap-chromium.sh) that
#    does this in this sandbox. Point CDP_BASE elsewhere if you run your own.

# 2. run (needs the live server env)
JELLYFIN_URL=… JELLYFIN_USER=… JELLYFIN_PASS=… node verify-video-playback.mjs
```

`cdp.mjs` (a ~50-line dependency-free CDP client) is vendored locally so this
harness is self-contained and does not depend on sibling PRs being merged first.
Prints a JSON report (also written to `last-run.json`), exits non-zero on FAIL.
Env: `JELLYFIN_URL`, `JELLYFIN_USER`, `JELLYFIN_PASS`, `CDP_BASE` (optional).
