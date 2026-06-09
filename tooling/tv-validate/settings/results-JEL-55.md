# JEL-55 — Compare: Settings pages (display, navigation, save) — TV vs browser

**Verdict: parity confirmed — expected behavior, no shell defect.**

The Settings ("My Preferences") section is **100% jellyfin-web + server driven**.
The Tizen shell does not implement, wrap, or customize any settings page, form,
or persistence path, so settings display/navigation/save on the TV are identical
to the desktop browser **by construction**. The empirical harness
(`verify-settings.mjs`) (1) unit-tests the shell's `__qaIsSettingsView()`
detector against the real jellyfin-web 10.11 settings routes, and (2) drives both
server-side persistence backends under a real-TV identity and a browser identity
(plus a third fresh "restart" session) and confirms every saved value round-trips
**identically** and survives a restart. **15/15 checks pass.**

## What the shell does (and doesn't do) for Settings

A `grep` of `shell.js` / `boot-shell.src.js` finds **zero** references to
`DisplayPreferences`, user `Configuration`, `SubtitleLanguagePreference`,
`AudioLanguagePreference`, subtitle size, or any settings form. The only
localStorage keys the shell owns are shell-internal (`serverUrl`, bundle cache,
`_deviceId2`, `layout="tv"`). Three things the shell _does_ near Settings:

| Concern                                      | Owner                                                       | TV vs browser                                               |
| -------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| Settings UI / forms (toggles, dropdowns)     | jellyfin-web                                                | Same bundle, identical                                      |
| D-pad navigation between categories/controls | jellyfin-web `focusManager` (+ shell JEL-1580 focus-rescue) | Identical traversal; rescue only lands the focus ring       |
| `__qaIsSettingsView()`                       | shell QA overlay (gated on `jellyfin.qa.overlay==="1"`)     | Detector only — emits Settings field-id evidence for QA OCR |

### Navigation

Settings navigation is jellyfin-web's `focusManager`; the shell only intercepts
BACK (`10009`) and is otherwise transparent to D-pad keys. On TV, post-hashchange
the shell's **JEL-1580 body-focus-rescue + proactive auto-focuser** (validated
under [JEL-33](/JEL/issues/JEL-33)) guarantees the first D-pad press lands on a
focusable control instead of being swallowed while focus sits on `<body>`. It
changes only _whether the focus ring appears_, never _which categories/controls
exist or how they are traversed_ — so every settings category is reachable by
D-pad exactly as in the browser.

## Why saved settings cannot diverge TV vs browser

Both persistence backends store under a **device-agnostic** key, so a value saved
on TV is byte-identical when read on the browser and survives an app restart (a
restart is just a new login against the same server state):

| Setting class (ticket example)                                               | Endpoint                                            | Why device-agnostic                                                                              |
| ---------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Preferred audio language, subtitle language/mode, play-default-audio         | `POST /Users/{uid}/Configuration`                   | Stored on the **user**, no client/device key                                                     |
| Display / appearance: subtitle size, theme, skip lengths, next-video overlay | `POST /DisplayPreferences/usersettings?client=emby` | jellyfin-web **always** uses the fixed client literal `"emby"`, never the device `Client` header |

The `"emby"` client key was verified against the **live 10.11.10 main bundle**:

```
getDisplayPreferences("usersettings", userId, "emby")
updateDisplayPreferences("usersettings", displayPrefs, currentUserId, "emby")
```

So the TV (`Client="Jellyfin Shell for Tizen"`) and the browser
(`Client="Jellyfin Web"`) read and write **one shared** DisplayPreferences bucket
— the harness proves this directly (both identities return the same `Id`,
`Client=emby`).

## `__qaIsSettingsView()`

The detector (extracted **verbatim** from `shell.js`) matches the active page by
`location.hash` regex (`preferences|displaysettings|…|userprofile|usersettings|
settings.html`) or `document.body.className`
(`dashboardDocument|userPreferencesPage|preferencesContainer`). Tested against the
**real** jellyfin-web 10.11 settings routes extracted from the live bundle —
`#/mypreferencesmenu`, `#/mypreferencesdisplay`, `#/mypreferenceshome`,
`#/mypreferencesplayback`, `#/mypreferencessubtitles`, `#/mypreferencescontrols`,
`#/mypreferencesquickconnect`, `#/userprofile`, `#/dashboard` — all detected; a
set of non-settings routes (`#/home.html`, `#/movies.html`, `#/details`,
`#/video`, `#/search.html`, …) all correctly excluded.

## Empirical verification (live server, Jellyfin 10.11.10)

Harness: `tooling/tv-validate/settings/verify-settings.mjs`
(Node ≥18, built-in `fetch`; reads `JELLYFIN_URL/USER/PASS` from env; never
prints credentials; **restores all mutations** to the shared test account).

```
PASS  __qaIsSettingsView() returns true on all real settings routes  — 10/10 settings routes detected
PASS  __qaIsSettingsView() returns false on non-settings routes  — 9/9 non-settings routes correctly excluded
PASS  __qaIsSettingsView() body-class branch detects preferences/dashboard documents  — dashboardDocument / userPreferencesPage / preferencesContainer
PASS  __qaIsSettingsView() body-class branch ignores non-settings documents  — libraryDocument not misdetected
PASS  authenticate (tv + browser + fresh-restart sessions, same user)  — uid c36be5dd…
PASS  read current user Configuration (TV identity)  — SubtitleMode=Default AudioLangPref=undefined
PASS  save Configuration change on TV identity (audio/subtitle language + mode)  — HTTP 204
PASS  Configuration change saved correctly + identical on browser identity  — audio=jpn sub=fre mode=Always
PASS  Configuration prefs persist across restart (fresh TV session)  — preferred audio language + subtitle prefs retained after re-login
PASS  user Configuration restored to original  — restored
PASS  TV + browser read ONE shared DisplayPreferences bucket (client=emby)  — Id=3ce5b65d… Client=emby (device Client header ignored)
PASS  save display setting on TV identity (CustomPrefs round-trip)  — HTTP 204
PASS  display setting saved + identical on browser identity  — jel55-subtitleTextSize=Larger
PASS  display setting persists across restart (fresh TV session)  — subtitle-size-style display pref retained after re-login
PASS  DisplayPreferences restored (test key removed)  — restored

15/15 checks passed.
```

### What each check proves

- **Detector true on settings routes / false elsewhere / body-class branch** —
  the on-TV `__qaIsSettingsView()` returns `true` on every real Settings page
  (this is the ticket's explicit "Check `__qaIsSettingsView()` returns true"
  requirement) and never false-positives on library/detail/playback pages.
- **Save on TV → identical on browser** — a value written through the TV
  identity is read back **byte-identical** through the browser identity, for both
  backends. This is "toggles and dropdowns can be changed" + "changes are saved
  correctly" at the persistence layer that the controls ultimately call.
- **Persist across restart** — a third **freshly-authenticated** session (a new
  device-id / new token, exactly what a cold app restart produces) reads the same
  saved values, because they live server-side. This is the ticket's "display
  settings persist across restarts" — exercised with the named examples
  (preferred audio language + a subtitle-size-style display pref).
- **One shared bucket (client=emby)** — both device identities resolve to the
  same DisplayPreferences `Id` with `Client=emby`, proving the device `Client`
  header is irrelevant to where settings are stored.
- **Restore** — Configuration and DisplayPreferences are returned to their
  original values; the scoped test key is removed, leaving the shared account
  unchanged.

## Scope notes

- **Not driven through a live D-pad on the physical TV.** Per the JEL-7
  blockers, the locked M63 TV cannot be driven by an automated input harness from
  the sandbox. D-pad _mechanics_ (first-press focus rescue + within/between
  movement) were validated automatically in [JEL-33](/JEL/issues/JEL-33); this
  ticket validates settings **content/navigation parity** and **save/persistence
  correctness**, which are the parts that could plausibly differ TV vs browser.
- **Save path.** The harness exercises the same server endpoints the settings
  forms POST to (`/Users/{uid}/Configuration`, `/DisplayPreferences/usersettings`).
  It does not click DOM toggles — the toggle/dropdown widgets are jellyfin-web's
  own controls (identical bundle on both platforms); what is platform-specific is
  _where the saved value lands and whether it is shared/persisted_, which is what
  this proves.
- A scoped `jel55-*` CustomPref key is used for the display round-trip so a real
  user setting is never clobbered; it is deleted on restore.

```
Re-run: node tooling/tv-validate/settings/verify-settings.mjs
```
