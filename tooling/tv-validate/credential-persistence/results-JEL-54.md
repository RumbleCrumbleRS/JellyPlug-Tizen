# JEL-54 — User login & credential persistence: TV vs browser

**Verdict: PARITY — identical by construction.** The login flow and the entire
`jellyfin_credentials` lifecycle are owned by jellyfin-web; the Tizen shell is
transparent to credentials. Token format, stored credential structure, and
cross-boot persistence are the same on TV and browser because the same
jellyfin-web code produces them. **21/21 automated checks pass.**

Harness: [`verify-credential-persistence.mjs`](./verify-credential-persistence.mjs)
Run: `node tooling/tv-validate/credential-persistence/verify-credential-persistence.mjs`
(live PART A/B need `JELLYFIN_URL` / `JELLYFIN_USER` / `JELLYFIN_PASS`; source + sim run offline)

## What the ticket asked, and how each point is covered

| # | Requirement | Result |
|---|---|---|
| 1 | Fresh session shows a login surface (user list or username input) | The login UI is 100% jellyfin-web (shell authors **no** login DOM). Sim: empty store → `isAuthed()` false → login path. Live: invalid token → `401`. |
| 2 | PIN/password entry works | `POST /Users/AuthenticateByName` succeeds (200) under **both** the browser and TV/NativeShell identities. |
| 3 | `jellyfin_credentials` saved to localStorage after login | jellyfin-web's credentialProvider writes it; shell **never** writes it. Sim: after the blob is written, `isAuthed()` flips to true. |
| 4 | Next boot: login not required (token persists) | Shell **never clears** `jellyfin_credentials` (only its own `jellyfin.shell.serverUrl`). Sim: new context + same backing store → still authed. Live: the captured token alone authenticates `/Users/Me`. |
| — | Token format + structure match TV vs browser | AccessToken is 32-char hex on both; `AuthenticationResult` keys (`AccessToken,ServerId,SessionInfo,User`) and the assembled credential shape are identical. |

## The parity story (why this is parity-by-construction)

The shell does not implement login. A `grep` of `shell.js` and
`boot-shell.src.js` proves:

- **No write** — neither shell ever calls `setItem("jellyfin_credentials", …)`.
  The credential blob is written exclusively by jellyfin-web's credentialProvider,
  identically on every client.
- **No clear** — neither shell ever `removeItem`s `jellyfin_credentials`. The
  only credential-ish key the shell clears is its own `jellyfin.shell.serverUrl`
  (JEL-31, server-URL persistence). So once jellyfin-web writes a token it
  survives every shell reboot untouched → "login not required again" holds by
  construction.
- **No login DOM** — the shell builds no username field, PIN form, or user
  picker. The only login-adjacent code is a **read** of `jellyfin_credentials`:
  - `isAuthed()` in the body-focus auto-focuser (only auto-focuses once authed);
  - the QA beacon's `qcState` detector (reads jellyfin-web's selectors
    `.userItemContainer/.btnUser`, `#txtUserName/.manualLoginForm`,
    `.btnUseQuickConnect/.qcCode` — it reports state, never creates it).
- **isAuthed() is byte-identical** (252 chars) between `shell.js` and
  `boot-shell.src.js`, and reads via the canonical `Servers[0].AccessToken`
  shape — the same shape jellyfin-web writes.

## Checks (21/21)

**PART A/B — live server (browser identity vs TV `Jellyfin Shell for Tizen` / `Samsung Smart TV`):**
1. AuthenticateByName succeeds 200 under both identities (PIN/password path)
2. Same user resolved under both identities
3. AccessToken format identical — 32-char hex on both
4. AuthenticationResult top-level structure identical (`AccessToken,ServerId,SessionInfo,User`)
5. Assembled `jellyfin_credentials` object shape identical (`Servers[0].{Id,AccessToken,UserId,…}`)
6. Persisted token authenticates a fresh `/Users/Me` request → next boot needs no re-login
7. Invalid/garbage token rejected `401` → fresh/empty session must show login

**PART C — source transparency (asserted on BOTH shells):**
8–15. never writes / never clears `jellyfin_credentials`; reads via canonical `Servers[0].AccessToken`; authors no login DOM
16. `isAuthed()` credential gate byte-identical across TV + hosted shell

**PART D — real `isAuthed()` lifted from `shell.js`, run over a fake localStorage:**
17. fresh session (no creds) → `isAuthed()` false → login required (#1)
18. after login → `isAuthed()` true (creds persisted, #3)
19. next boot (new context, persisted store) → `isAuthed()` true → no re-login (#4)
20. creds without AccessToken → false (no false-positive auth)
21. corrupt creds JSON → false, never throws

## Notes / scope

- The harness never prints tokens or credentials. It revokes the two live
  sessions it creates (`POST /Sessions/Logout`) so it leaves no dangling tokens
  on the shared test account.
- The credential **values** (the token string) differ per session — that is
  expected and correct; what must match across TV/browser is the **format** and
  the **structure**, which it does.
- On-device confirmation is not required: the shell code paths that touch
  credentials are reads, byte-identical to the browser shell, and the writer is
  jellyfin-web (same bundle on both). No TV-only credential behavior exists to
  observe.
