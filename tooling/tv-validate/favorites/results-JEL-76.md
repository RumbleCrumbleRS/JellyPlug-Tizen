# JEL-76 — Favorites: mark/unmark and persistence across sessions: TV vs browser

**Verdict: PARITY — identical by construction.** A "favorite" is **server
state**, not client state. jellyfin-web's heart button calls
`apiClient.updateFavoriteStatus()` → a POST/DELETE on the server's
`FavoriteItems` endpoint, and the server stamps `UserData.IsFavorite` on the
item, keyed by `(user, item)`. The Favorites view and every `Filters=IsFavorite`
query read that same server state back. The Tizen shell references **no**
favorite / heart / `FavoriteItems` / `IsFavorite` code, its fetch/XHR shim
intercepts **only** `config.json` (so every favorite request passes through to
the server untouched), and it **never** writes favorites/user-data to
localStorage — so the heart toggle, the Favorites filter, cross-session
persistence, and cross-client reflection are the same on TV as in the browser,
driven by the same jellyfin-web code against the same server. **21/21 automated
checks pass** (7/7 offline source; +14 live).

Harness: [`verify-favorites.mjs`](./verify-favorites.mjs)
Run: `node tooling/tv-validate/favorites/verify-favorites.mjs`
(live PART A needs `JELLYFIN_URL` / `JELLYFIN_USER` / `JELLYFIN_PASS`; source checks run offline)

Verified against the live test server (`Test Server`, Jellyfin 10.11.10).

## What the ticket asked, and how each point is covered

| #   | Requirement                                            | Result                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The heart icon toggles correctly                       | Live, under **both** identities: `POST FavoriteItems` → `IsFavorite` **true**, `DELETE` → **false**, re-`POST` → **true** again. The mutation response **and** a fresh item GET agree every time — the toggle is correct, symmetric, and idempotent. The shell owns none of the heart UI.      |
| 2   | The Favorites library/filter shows the same items      | Live: `Filters=IsFavorite` returns a **byte-identical** item set on TV vs browser, containing exactly the items marked under each client. Same server query, same jellyfin-web code → same list.                                                                                               |
| 3   | Favorites persist after a TV power cycle (API-backed)  | Live: after marking, a **brand-new session** with a new DeviceId + new token (a cold TV boot that never participated in the mark — the worst case, beyond a power cycle, modelling even a clean reinstall) still reads `IsFavorite=true` and sees the item in its Favorites filter. Not local. |
| 4   | A browser change immediately reflects on TV on refresh | Live: mark under the **browser** identity → a fresh read under the **TV** identity (the "refresh") already sees it (true + in the TV favorites filter). Unmark on **TV** → the browser's next read sees it gone. Bidirectional, immediate, no stale client cache between.                      |

## The parity story (why this is parity-by-construction)

A favorite never touches the client. The toggle is a server mutation; the state
lives on the server keyed by user. A `grep` of `shell.js` and
`boot-shell.src.js` proves the shell is transparent to all of it:

- **No favorite / heart code** — neither shell references `FavoriteItems`,
  `IsFavorite`, `updateFavoriteStatus`, or any heart/favorite button. The toggle
  UI and the mutation call are 100% jellyfin-web.
- **The fetch + XHR shim intercepts only `config.json`** — the allowlist is a
  single predicate, `matches = /(^|\/)config\.json(\?|$)/`, **byte-identical**
  across both shells (83 chars). Every `FavoriteItems` POST/DELETE and every
  `Filters=IsFavorite` read fails that match and flows straight to native
  networking → the server (memory: `jel64-network-error-transparency`). The
  shell cannot alter, drop, or cache a favorite.
- **No favorites/user-data in localStorage** — the shell's only LS keys are
  boot infrastructure (bundle/web/config cache, `serverUrl`, `_deviceId2`,
  `layout`, transpile caches). There is **no client-side copy** of a favorite to
  go stale, and a power cycle (which loses client memory) has nothing favorite-
  related to lose — persistence is purely the server's.

Because the heart, the Favorites view, and the favorite state are all
server-and-jellyfin-web owned, with the shell a transparent host, TV behaves
exactly like the browser by construction.

## Checks (21/21)

**PART A — live server (browser identity vs TV `Jellyfin Shell for Tizen` / `Samsung Smart TV`):**

1. Login succeeds 200 under both identities
2. Server returns items to mark as favorites
3. `[TV]` mark → `IsFavorite` true (mutation response + reread agree)
4. `[TV]` unmark → `IsFavorite` false (response + reread agree)
5. `[TV]` re-mark → true again (idempotent/symmetric)
6. `[browser]` mark → `IsFavorite` true (response + reread agree)
7. `[browser]` unmark → `IsFavorite` false (response + reread agree)
8. `[browser]` re-mark → true again (idempotent/symmetric)
9. Favorites filter (`Filters=IsFavorite`) byte-identical TV vs browser
10. Favorites filter contains exactly the items marked under each client
11. Favorite persists for a NEW session/token (cold TV boot after power cycle) — API-backed, not local-only
12. A session that never set the favorite still sees it in the filter (server-stored, user-keyed)
13. browser→TV: favorite marked on browser is seen by a fresh TV read (refresh) + TV favorites filter
14. TV→browser: unmark on TV is seen by a fresh browser read (bidirectional, immediate)

**PART C — source transparency (asserted on BOTH shells):**

- 15, 18. owns no favorite / heart / `FavoriteItems` code (jellyfin-web does)
- 16, 19. fetch/XHR shim matches ONLY `config.json` (favorite traffic passes through to server)
- 17, 20. never writes favorites/user-data to localStorage (no client copy to go stale)
- 21. config-only `matches` predicate byte-identical across TV + hosted shell (83 chars)

## Notes / scope

- **Why no vm simulation** (unlike JEL-70's profile-switch lifecycle): favorite
  persistence is genuinely **server** state, so PART A(11–12)'s fresh-token,
  never-saw-the-mark reads are direct real-server evidence of the power-cycle
  guarantee — stronger than any in-process model could be.
- The "power cycle" check goes beyond the ticket: it uses a brand-new DeviceId
  **and** a brand-new token, so it also covers a clean reinstall, not just a
  reboot. Both still read the favorite back from the server.
- The harness never prints tokens or credentials. It **restores** every touched
  item to its original favorite state and revokes every session it mints (in a
  `finally`), leaving the shared test account clean — verified 0 leftover
  favorites after the run. No other server or account state is mutated.
- On-device confirmation is not required: every shell code path is a config-only
  passthrough or a read, byte-identical to the browser shell, and the entire
  favorite UI + mutation is jellyfin-web (same bundle on both). No TV-only
  favorites behavior exists to observe.
