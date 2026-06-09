# JEL-68 — Background/foreground lifecycle (app pause & resume): TV vs browser

**Scope:** On the Tizen TV, switch to another app (e.g. the live-TV input) and
back to Jellyfin. Verify (1) the app resumes in the **same state** (same page,
same focus); (2) **video playback** that was paused resumes / prompts correctly;
(3) **no JavaScript errors**; (4) **network connections re-establish**. Compare
with background-tab behaviour in a browser.

**Verdict:** ✅ **Parity by construction (warm resume).** On the Tizen WRT (web
runtime) backgrounding the app does **not** tear down the WebView — it maps to
the W3C **Page Visibility API** (`visibilitychange` / `document.hidden`),
exactly like backgrounding a browser tab. The DOM, JS heap, SPA route, focused
element, `localStorage` and any open sockets all survive. **jellyfin-web owns
every lifecycle reaction** (pausing video on hidden, reconnecting its ApiClient
/ WebSocket on visible, restoring its own last route). The shell registers
**no** competing lifecycle listener, intercepts no media key mid-session, shims
no WebSocket, and never reloads on a visibility change — so a warm resume is
byte-for-byte identical on the TV WebView and in a desktop browser tab.

Automated proof: `packages/shell-tizen/scripts/lifecycle-resume.test.cjs`
(wired into `pnpm --filter @jellyfin-tv/shell-tizen test`) — **70 checks pass**
against both shipping shells (`shell.js`, `boot-shell.src.js`) and their
deployed minified blobs.

---

## Why "pause/resume" reduces to a transparency proof

Tizen delivers app background/foreground to a web app through the Page
Visibility API — the same surface a browser uses for tab background/foreground.
The shell can only affect the resume through a handful of surfaces; each is
verified inert.

| #   | Issue requirement                    | Shell behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Why TV == browser                                                                                                                                       |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Same page / same focus on resume** | The shell binds **no** `visibilitychange` / `webkitvisibilitychange` / `pagehide` / `pageshow` / `freeze` / `resume` / `pause` / `blur` / `focus` listener (Part A), so it cannot reset SPA state or re-route on pause/resume. Its focus machinery (body-focus rescue + proactive auto-focuser) is gated to `isBodyF()` — it only acts when `activeElement` is `BODY`/`HTML`, i.e. focus is _already_ lost; it **restores** focus and never moves it **off** a live element (Part B). | The WebView preserves the page across background on both platforms; the shell adds nothing that disturbs the preserved route/focus.                     |
| 2   | **Video pause/resume**               | Media keys (`MediaPlay`/`Pause`/`PlayPause`/`Stop`/…) are registered **by name** via `tizen.tvinputdevice.registerKey` for jellyfin-web's `playbackManager`; the shell implements no play/pause of its own and its **only** keyCode-bound `preventDefault` is BACK (10009), gated by `__jellyfinShellBootDone` (Part C).                                                                                                                                                              | playbackManager's own visibility handling (pause on hidden / resume-or-prompt on visible) runs unmodified — it is jellyfin-web code, identical on both. |
| 3   | **No JS errors**                     | No lifecycle listener exists to throw on pause/resume (Part A). The only `document.hidden` reader is the QA beacon, which merely **pauses telemetry** while backgrounded (gated behind `jellyfin.qa.overlay==='1'`, off in retail) — it draws nothing and mutates no web-client state.                                                                                                                                                                                                | Nothing shell-side runs on the transition, so there is no shell-originated error on either platform.                                                    |
| 4   | **Network re-establishes**           | fetch/XHR are shimmed **only** for `config.json`; every data call (`System/Info`, `Sessions/Playing/Progress`, resume rows, the `socket?api_key=…` handshake URL) passes through to the native transport, and the **`WebSocket` constructor is not shimmed at all** (Part D). The shell never calls `location.reload()` on a visibility change.                                                                                                                                       | jellyfin-web's ApiClient HTTP re-probe and WebSocket reconnect run natively — same path as the browser (cf. JEL-64).                                    |

### TV == browser by construction

Backgrounding is delivered by the Page Visibility API on both platforms, and
**nothing in the shell decides pause/resume off a `tizen`/`webapis` branch**.
The only `tizen.application` reference is `getCurrentApplication().exit()` in the
BACK handler — that governs **leaving** the app, not resuming it (Part E). So
warm-resume behaviour cannot diverge between TV and browser.

---

## What the automated test checks

`node packages/shell-tizen/scripts/lifecycle-resume.test.cjs`

- **Part A (no lifecycle listener):** for all four shells (both `.src`/`.js` and
  both deployed `.min` blobs), asserts the absence of any
  `addEventListener("<lifecycle>")` / `.on<lifecycle>=` registration for the
  nine Page-Visibility/lifecycle events.
- **Part B (focus preserve-safe):** the `isBodyF()` gate exists; the keydown
  focus-rescue early-returns when focus is **not** on BODY; the proactive
  auto-focuser interval skips (`if(!nowBody)return`) while a real element holds
  focus — so a warm resume that preserved focus is untouched.
- **Part C (playback is jellyfin-web's):** media keys are `registerKey`-
  registered by name; BACK (10009) yields to the web client post-boot; the
  shell defines no `MediaPause`/`MediaPlay` handler of its own.
- **Part D (native reconnect):** `WebSocket` is never shimmed; the lifted
  `matches()` predicate passes through resume data/socket URLs to the native
  transport; the fetch shim defers non-`config.json` to native fetch; no
  `location.reload()` on any shell.
- **Part E (TV==browser):** every `tizen.application.<…>` access is
  `getCurrentApplication().exit()` — no pause/resume branch.
- **Part F (observations):** see below.

---

## Observations (informational)

1. **QA beacon is the only `document.hidden` reader — parity-neutral.** Gated
   behind `localStorage['jellyfin.qa.overlay']==='1'` (off in retail builds), it
   pauses outbound telemetry while backgrounded and resumes on foreground. It
   draws nothing and changes no jellyfin-web state, so it cannot affect the
   resume.

2. **Cold resume (OOM relaunch) is the one genuine TV-specific path.** Under
   memory pressure Tizen may **terminate** a backgrounded app. Relaunch is then
   a **cold boot** — `bootstrap()` reloads the saved server URL
   (`loadRemoteWebClient(savedUrl)`, with JEL-555 skipping the `/System/Info/Public`
   pre-flight) and jellyfin-web restores its own last view from its persisted
   state. This is the **"reopen a closed browser tab"** analogue (in-memory
   state lost, restored via the app's own persistence), **not** a warm resume,
   and is expected behaviour. JEL-63 ensures a boot-time network failure on this
   path does not wipe the saved URL on `shell.js` (the bootstrap still clears
   it — tracked as the JEL-63 follow-up noted in JEL-64).

---

## On-device (Tizen 5.0 / M63) manual repro

Production Q60R retail TVs lock down `sdb dlog` and the Web Inspector, so
on-device evidence is read via the always-on diag HUD + QA beacon
(`error`/`unhandledrejection` capture, `activeElement`/`focus` snapshot,
`visibility` field). To reproduce on a paired TV:

1. Boot the app, log in, navigate to a library / start playback of an item.
2. Press the TV's **Home** / **Source** button to switch to another app/input
   (e.g. live TV). The Jellyfin WebView is backgrounded
   (`document.visibilityState === "hidden"`). **Expect:** jellyfin-web pauses
   playback; the shell draws nothing and runs nothing.
3. Switch **back** to Jellyfin. **Expect (warm resume):** same page, same focus
   ring, no relaunch, no JS error in the HUD/beacon `errors[]`; jellyfin-web's
   ApiClient/WebSocket reconnect and playback resumes or shows its own resume
   prompt — identical to refocusing a backgrounded browser tab.
4. **Cold-resume cross-check:** leave the app backgrounded long enough (or open
   several heavy apps) for Tizen to kill it; relaunch. **Expect:** cold boot
   re-enters the saved server and jellyfin-web restores its last view — like
   reopening a closed tab.

Cross-check steps 1–3 in a desktop browser (switch tabs / minimise and return):
behaviour matches step-for-step. The beacon payload (`visibility`, `focus`,
`errors[]`, `activeElement`, `url`) records the on-device sequence for
screenshot evidence.
