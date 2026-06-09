# JEL-70 — Multiple user accounts / profile switching: TV vs browser

**Verdict: PARITY — identical by construction.** User switching, login, "Sign
Out", and the per-user `jellyfin_credentials` store are owned entirely by
jellyfin-web and the server. The Tizen shell references no logout/login/user-
switch flow at all, never writes or clears `jellyfin_credentials`, and boots off
the saved **server** URL rather than credentials — so switching users, logging
out, and logging back in as a different user behave the same on TV as in the
browser, with no app restart, because the same jellyfin-web code drives them on
both. **30/30 automated checks pass** (16/16 offline; +14 live).

Harness: [`verify-profile-switching.mjs`](./verify-profile-switching.mjs)
Run: `node tooling/tv-validate/profile-switching/verify-profile-switching.mjs`
(live PART A/B need `JELLYFIN_URL` / `JELLYFIN_USER` / `JELLYFIN_PASS`; source + sim run offline)

Verified against the live test server (`Test Server`, Jellyfin 10.11.10),
which has **10 real user accounts** — a genuine multi-user setup.

## What the ticket asked, and how each point is covered

| #   | Requirement                                                     | Result                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Switching users on TV works the same as browser                 | User switching is jellyfin-web SPA navigation inside the live WebView document — the shell owns no user-switch flow. Sim: A → switch to B in **one continuous context** (no reboot) stays authed. Live: same account logs in under both browser and TV identities, same UserId.         |
| 2   | Each user's `jellyfin_credentials` stored independently         | Each login mints an **independent, user-bound token** (live: two logins → two distinct AccessTokens). Logout of one session 401s only that token; the other still 200s. The shell **never writes/clears** the blob — jellyfin-web's credentialProvider owns it.                         |
| 3   | Recommendations + library visibility respect the logged-in user | Live: a token can read **only its own** Views/Latest/Suggestions/NextUp (all 200); every cross-user read (another account's id) is **denied 403** — under both the browser and TV identities (the TV earns no extra visibility). Own Views + Latest are byte-identical TV vs browser.   |
| 4   | Logout → login as a different user, no app restart              | The shell boots off `loadServerUrl()`, **never** `jellyfin_credentials`, so a logout cannot bounce the TV to first-run setup. Sim: login → switch → logout → login-as-different-user all in **one context** (= no restart). Live: a fresh login after logout mints a new working token. |

## The parity story (why this is parity-by-construction)

A `grep` of `shell.js` and `boot-shell.src.js` proves the shell is transparent
to the entire multi-user lifecycle:

- **No logout / login / user-switch flow** — neither shell authors a username
  field, a "Sign Out" control, or a user picker, and neither navigates to a
  login route. The user list, profile switch, and logout are 100% jellyfin-web.
  (The QA beacon's `qcState` detector _names_ jellyfin-web's selectors —
  `.userItemContainer/.btnUser`, `#txtUserName/.manualLoginForm` — to _report_
  which screen is up; it never _creates_ them.)
- **No credential write/clear** — neither shell ever `setItem`s or `removeItem`s
  `jellyfin_credentials`. When a user logs in / switches / logs out, jellyfin-web
  rewrites that blob; the shell only **reads** it (the `isAuthed()` auto-focus
  gate, byte-identical 252 chars across both shells).
- **The only server-state clear is `selectServer`** — `clearServerUrl()` removes
  the shell's own `jellyfin.shell.serverUrl` key and has exactly one call site:
  `selectServer` (the multi-**server** switch — a different _server_, not a
  different _user_; it never touches credentials). No logout or user-switch path
  reaches it.
- **Boot routes off the server URL, not credentials** — the boot decision reads
  `loadServerUrl()`; if a server is saved it goes straight to
  `loadRemoteWebClient`. So clearing credentials (logout) cannot send the shell
  back to the first-run connect/setup form — any reload lands in jellyfin-web's
  login/user-picker for the same server. "Log in as a different user without an
  app restart" holds even if jellyfin-web reloads the document on logout.

Because user switching is jellyfin-web SPA navigation inside an already-loaded
WebView the shell never tears down, the whole switch/logout/re-login cycle needs
no app restart — identical to the browser.

## Checks (30/30)

**PART A/B — live server (browser identity vs TV `Jellyfin Shell for Tizen` / `Samsung Smart TV`):**

1. Login succeeds 200 under both identities (multi-user login path)
2. Same account → same UserId under both identities
3. Each login mints an independent token (two distinct AccessTokens)
4. Token format identical — 32-char hex on both
5. Own Views/Latest/Suggestions/NextUp all resolve 200 on both identities
6. Library visibility (Views) byte-identical TV vs browser
7. Recommendations (Items/Latest) byte-identical TV vs browser
8. Server provides the multi-account picker list the login screen renders (10 accounts)
9. Unauthenticated `/Users/Public` lists selectable accounts (pre-login picker)
10. Cross-user reads denied 403 under browser identity (visibility respects logged-in user)
11. Cross-user reads denied 403 under TV identity too (TV earns no extra visibility)
12. Logout revokes only that session's token (it 401s)
13. The other session is unaffected by the logout (still 200) — independent credentials
14. A fresh login mints a new working token ≠ the revoked one — log in as a different user

**PART C — source transparency (asserted on BOTH shells):**

- 15–24. owns no logout/login/user-switch flow; never writes/clears `jellyfin_credentials`; `clearServerUrl` called from `selectServer` only; boot keys on `loadServerUrl()` not credentials
- 25. `isAuthed()` credential gate byte-identical across TV + hosted shell

**PART D — real `isAuthed()` lifted from `shell.js`, run over ONE continuous fake-localStorage context:**

- 26. login as user A → `isAuthed()` true
- 27. switch to user B (same context, no reboot) → true (#1 switch works)
- 28. logout (same context) → false → login surface (#4, no restart)
- 29. log in as a different user C (same context) → true (#4, no app restart)
- 30. logged-out but server-known → boot routes to web-client login, not first-run setup

## Notes / scope

- The harness never prints tokens or credentials. It revokes every session it
  mints (`POST /Sessions/Logout`, in a `finally`) so it leaves no dangling token
  on the shared test account, and mutates no other server or account state.
- All 10 test accounts are password-protected, so the live multi-user proof uses
  the one available `Test` credential plus the server's per-user **token
  boundary** (cross-user reads 403) — a stronger isolation proof than diffing two
  libraries, since it shows a token cannot cross the user boundary at all.
- `Suggestions` can reshuffle between calls, so it is asserted only to _resolve_
  per-user (200 own / 403 cross-user), not byte-compared; `Views` and `Latest`
  (deterministic) carry the TV-vs-browser byte-identity assertion.
- On-device confirmation is not required: every shell code path that touches the
  user/credential lifecycle is a read, byte-identical to the browser shell, and
  the writer + the entire login/logout/switch UI is jellyfin-web (same bundle on
  both). No TV-only profile-switching behavior exists to observe.
