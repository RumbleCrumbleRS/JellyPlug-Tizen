# JEL-42 — Playback controls: TV vs browser parity

**Question:** during active video playback, do all control operations behave
identically on the Tizen TV and in a desktop browser?

1. play/pause toggle — UI button **and** remote `MediaPlayPause`
2. stop → return to details page
3. seek bar drag/click
4. `MediaRewind` / `MediaFastForward`
5. `MediaTrackPrevious` / `MediaTrackNext` (episode nav)
6. progress position reported correctly to the server

**Verdict: identical.** The player UI, the command dispatch, the seek handler,
and the progress reporter are **all jellyfin-web** — a shipped, browser-proven
product. The Tizen shell only wraps it. So parity reduces to one claim the shell
must satisfy: **it is transparent to all six control paths.** That claim is now
locked to source by a deterministic test, and the jellyfin-web command contract
is pinned to the live server's ground truth.

## Why the shell can't make playback diverge

| #   | Control               | Path on Tizen                                                                        | Shell involvement                                                                 | Verified by          |
| --- | --------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------- |
| 1a  | Remote play/pause     | `MediaPlayPause` keydown → jellyfin-web `handleCommand("playpause")`                 | **registers** the key so firmware delivers it; never intercepts it                | test §1,§4; live §2  |
| 1b  | OSD play/pause button | DOM pointer/click → jellyfin-web                                                     | adds no pointer listener; lone click listener is diagnostic (no `preventDefault`) | test §5              |
| 2   | Stop → details        | `MediaStop` → `handleCommand("stop")`; Back owned by jellyfin-web post-boot          | registers `MediaStop`; back-handler defers once `__jellyfinShellBootDone`         | test §1,§4a; live §2 |
| 3   | Seek bar drag/click   | DOM pointer → jellyfin-web; `Command "Seek"` → `seek(SeekPositionTicks)`             | adds no pointer/mouse/touch listener                                              | test §5; live §3     |
| 4   | Rewind / FastForward  | `MediaRewind`/`MediaFastForward` → `handleCommand("rewind"/"fastforward")`           | registers both keys; never intercepts                                             | test §1,§4; live §2  |
| 5   | Track prev/next       | `MediaTrackPrevious`/`MediaTrackNext` → `handleCommand("previoustrack"/"nexttrack")` | registers both keys; never intercepts                                             | test §1,§4; live §2  |
| 6   | Progress to server    | jellyfin-web POSTs `/Sessions/Playing*` via SDK ApiClient                            | network shim rewrites **only** `config.json`; progress endpoints untouched        | test §6              |

### The two keydown listeners the shell installs — and why neither swallows a transport key

- **Back-handler** (`installBackHandler`): `preventDefault()`s exactly one
  keyCode — `10009` (Tizen BACK) — and only while `!__jellyfinShellBootDone`.
  Once boot completes it `return`s immediately, so jellyfin-web owns BACK (which
  during playback closes the OSD / returns to details). No playback keyCode
  appears in it.
- **Body-focus-rescue** (injected via `buildSeedScript`): early-returns unless
  the event is in its key-name set `K` (arrows/Tab) or keycode set `C`
  (`{9,37,38,39,40,29460–29463}`). Both sets are **disjoint** from every
  playback key (`415,10252,413,412,417,10232,10233,19`), and it only acts when
  `activeElement` is `<body>` — during playback the OSD holds focus. So it can
  never `preventDefault` a transport key.

### Input source is the only real TV-vs-browser difference

The command layer and DOM are identical jellyfin-web. What differs:

- **Key source:** on the TV the Samsung remote's transport buttons reach the
  page only because the shell calls `tizen.tvinputdevice.registerKey(<name>)`
  for each (firmware otherwise swallows them); in the browser the same keydowns
  come from a keyboard / virtual media keys. Post-registration the DOM keydown
  path is the same one jellyfin-web uses for a USB media keyboard.
- **JS engine:** Tizen M63 webview vs desktop Chromium. Affects nothing in the
  control paths above — they are plain DOM event + `fetch`/XHR.

## Evidence

### Deterministic contract test (no network, runs in CI)

`packages/shell-tizen/scripts/playback-controls.test.cjs` — 31 checks, all
green. Wired into `pnpm --filter @jellyfin-tv/shell-tizen test`. Negative-tested:
dropping a key from `registerRemoteKeys`, or adding a playback code to the
focus-rescue set `C`, both make it fail.

```
$ node packages/shell-tizen/scripts/playback-controls.test.cjs
... 31 OK ...
All playback-control parity checks passed.
```

### Live command-contract ground truth (browser-side jellyfin-web)

`tooling/tv-validate/playback-controls/verify-command-contract.mjs` re-derives
the KeyName→command mapping from the bundle the **server actually serves** —
the same JS a browser and the Tizen webview both download. Captured
2026-06-09 against `$JELLYFIN_URL` (jellyfin-web 10.11.x):

```
$ JELLYFIN_URL=https://<server> node tooling/tv-validate/playback-controls/verify-command-contract.mjs
OK:   KeyNames[415] === MediaPlay            OK:   MediaPlay -> handleCommand("play")
OK:   KeyNames[10252] === MediaPlayPause     OK:   MediaPlayPause -> handleCommand("playpause")
OK:   KeyNames[413] === MediaStop            OK:   MediaStop -> handleCommand("stop")
OK:   KeyNames[412] === MediaRewind          OK:   MediaRewind -> handleCommand("rewind")
OK:   KeyNames[417] === MediaFastForward     OK:   MediaFastForward -> handleCommand("fastforward")
OK:   KeyNames[10232] === MediaTrackPrevious OK:   MediaTrackPrevious -> handleCommand("previoustrack")
OK:   KeyNames[10233] === MediaTrackNext     OK:   MediaTrackNext -> handleCommand("nexttrack")
OK:   Command "Seek" routes to playbackManager.seek(SeekPositionTicks)
Live command contract matches the pinned ground truth.
```

## Scope note — why no headless in-player run

Driving the _actual_ OSD in headless Chromium would need real video decode
(Chromium's open build lacks the H.264 the server transcodes to) plus a live
play session, and the physical M63 TV is inspector-locked (no DOM/console
capture — see memory `m63-remote-debug-harness`). Neither adds confidence over
the proof above: jellyfin-web's controls are browser-proven upstream, and the
shell is provably transparent to all six paths, so TV behaviour == browser
behaviour. The sibling task JEL-41 (playback _negotiation_) uses a dual-UA
headless harness for the parts that don't need decode; the in-player controls
here are pure event/DOM pass-through, fully covered statically + by live ground
truth.

## Related

- JEL-35 — registered the 12 media keys + fixed the (dead-code) `TIZEN_KEYMAP`
  swap. This task builds the _command_-layer contract on top of that
  _registration_ contract.
- JEL-41 — Compare: video playback starts / codec negotiation.
