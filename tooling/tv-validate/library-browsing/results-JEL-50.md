# JEL-50 — Compare: Library browsing — Movies and TV Shows grids (TV vs browser)

**Verdict: parity confirmed — expected behavior, no shell defect.**

Library browsing (the Movies and TV Shows library grids) is **100% jellyfin-web +
server driven**. The Tizen shell does not implement, wrap, or customize any part
of the grid rendering, intra-grid navigation, filter/sort, or paging code paths,
so TV behavior is identical to the desktop browser by construction. The empirical
harness (`verify-library-browsing.mjs`) exercises the actual server `/Items`
contract that the grids drive under the hood and passes **25/25**, including a
byte-identical full-library enumeration under a browser-like and a TV-like client
identity.

## What the shell touches (and what it doesn't)

| Concern | Owner | Shell involvement |
| --- | --- | --- |
| Grid of posters + titles (cardBuilder) | jellyfin-web | none — `grep` of `shell.js` + bootstrap finds zero item-list / image / card / `cardBuilder` code |
| **Horizontal/vertical D-pad movement between cards** | jellyfin-web `focusManager` (geometric spatial nav) | none on card→card movement. The shell's *only* focus contribution is the body-focus-rescue + proactive auto-focuser (JEL-1580) that lands focus **into** the grid when `activeElement` is `<body>`; once a card is focused, jellyfin-web owns movement |
| Filters & sort (UI + query params) | jellyfin-web | none — server query params `SortBy`/`SortOrder`/`Genres`/`Filters` are built by jellyfin-web; the shell adds none |
| Paging / infinite scroll | jellyfin-web (`StartIndex`+`Limit`, `TotalRecordCount`) | none |
| Server URL the grid queries | shell (localStorage) | only seeds the server URL + a `config.json` fetch shim; never touches `/Items` |

Because no shell code sits on the grid-render, focus-movement, filter/sort, or
paging paths, there is nothing that can make library browsing diverge between TV
and browser. The single shell hook near navigation (the body-focus-rescue) only
*delivers* focus into the page — it is the same ES5 bytes on TV and browser and
was verified browser-side on the Library page itself (see D-pad section).

## Empirical verification (live server, Jellyfin 10.11.x)

Harness: `tooling/tv-validate/library-browsing/verify-library-browsing.mjs`
(Node ≥18, built-in `fetch`; reads `JELLYFIN_URL/USER/PASS` from env; never
prints credentials; **read-only** — mutates no server or account state).

```
PASS  authenticate
PASS  Movies library view present  — "Movies"
PASS  TV Shows library view present  — "Special TV Shows"
PASS  [Movies] every grid item has a title  — 58/58
PASS  [Movies] every grid item has a Primary poster tag  — 58/58
PASS  [Movies] sample poster image resolves  — "3 Men and a Little Lady" -> 200 image/jpeg
PASS  [TV Shows] every grid item has a title  — 29/29
PASS  [TV Shows] every grid item has a Primary poster tag  — 29/29
PASS  [TV Shows] sample poster image resolves  — "99 to Beat" -> 200 image/jpeg
PASS  [Movies] SortBy/SortOrder honored (asc non-decreasing, desc non-increasing, orders differ)  — 58 items
PASS  [Movies] alternate SortBy (DateCreated) returns same set  — 58 items
PASS  [Movies] filter options available (genres exposed)  — 16 genres, e.g. Action, Adventure, Animation
PASS  [Movies] genre filter narrows the grid  — "Action": 15/58
PASS  [TV Shows] SortBy/SortOrder honored (asc non-decreasing, desc non-increasing, orders differ)  — 29 items
PASS  [TV Shows] alternate SortBy (DateCreated) returns same set  — 29 items
PASS  [TV Shows] filter options available (genres exposed)  — 10 genres, e.g. Action & Adventure, Animation, Comedy
PASS  [TV Shows] genre filter narrows the grid  — "Action & Adventure": 11/29
PASS  [Movies] paging covers all 58 items (count matches TotalRecordCount)  — paged 58/58
PASS  [Movies] paging has no duplicate items  — 58 unique of 58
PASS  [Movies] paged order == unpaged order (no skipped/reordered items)  — paged 58 vs unpaged 58
PASS  [Movies] TV enumeration byte-identical to browser enumeration  — tv 58 vs browser 58
PASS  [TV Shows] paging covers all 29 items (count matches TotalRecordCount)  — paged 29/29
PASS  [TV Shows] paging has no duplicate items  — 29 unique of 29
PASS  [TV Shows] paged order == unpaged order (no skipped/reordered items)  — paged 29 vs unpaged 29
PASS  [TV Shows] TV enumeration byte-identical to browser enumeration  — tv 29 vs browser 29

25/25 checks passed.
```

### (1) Grid renders with correct thumbnails and titles
cardBuilder draws one card per item from the server's `/Items` response, needing
a `Name` (title) and a `Primary` image tag (poster). Verified **every** item in
the Movies (58) and TV Shows (29) grids has both, and that a real poster URL
(`/Items/{id}/Images/Primary?tag=…`) resolves to `200 image/jpeg`. On TV this is
the same cardBuilder code rendered in the TV layout (`localStorage.layout="tv"`,
seeded by the shell).

### (2) Horizontal and vertical D-pad navigation through the grid
Two layers, neither of which is shell grid code:
- **Into the grid:** post-login, Tizen leaves `activeElement` on `<body>`; the
  shell's body-focus-rescue / auto-focuser (JEL-1580) lands focus on the first
  focusable. This was verified **browser-side on the Library page itself** in
  [JEL-33](/JEL/issues/JEL-33): 1225 focusables, started on `<body>`, rescue
  fired + succeeded, landed on the alphaPicker, 7 distinct non-stuck targets,
  `attempts=13 rescues=13` (no attempt left focus on `<body>`).
- **Card → card / row → row:** once a card is focused, arrow movement is
  jellyfin-web's own `focusManager` geometric spatial navigation — identical
  code on TV and browser. The shell never intercepts arrow keys for movement
  (its only `keydown` interception is BACK `10009`).

### (3) Filters and sort options are accessible
- **Sort:** `SortBy`/`SortOrder` are honored — ascending is monotonic
  non-decreasing by `SortName`, descending monotonic non-increasing, and the two
  orders differ. An alternate `SortBy=DateCreated` returns the same item set in a
  different valid order. (Exact asc/desc mirroring is *not* asserted: Movies has
  7 titles sharing `SortName` "superman iv", and the server keeps tied items in a
  stable secondary order both directions — monotonicity is the tie-tolerant
  proof.)
- **Filters:** `/Items/Filters` exposes the genre vocabulary the filter dialog
  lists (16 genres for Movies, 10 for TV Shows), and applying `Genres=<g>` narrows
  the grid to a strict non-empty subset (Action: 15/58 movies; Action & Adventure:
  11/29 series).

### (4) Paging / infinite scroll — complete, no skips, no duplicates
jellyfin-web's infinite scroll requests `/Items` with `StartIndex`+`Limit` and
reads `TotalRecordCount`. Paging each library in chunks of 7 (forcing many page
turns) and assembling the id list:
- count equals `TotalRecordCount` (58 Movies, 29 TV Shows) — **nothing dropped**;
- every id is unique — **no duplicates across page boundaries**;
- the paged order is identical to a single unpaged fetch in the same sort — **no
  skipped or reordered items**.

**TV vs browser parity (the core comparison):** the full enumeration was run
twice — once under a browser-like client identity, once under a TV-like one — and
the two id sequences are **byte-identical**. Paging is a device-profile-independent
server contract that no shell code touches, so the grids enumerate identically on
both platforms.

## Scope notes
- Not driven through a headless-browser pixel walk of the cards: intra-grid
  spatial focus is jellyfin-web `focusManager` (covered behaviorally by
  [JEL-33](/JEL/issues/JEL-33)); the open question specific to *library browsing*
  is the data contract (right items, right images, sort/filter honored, paging
  complete with no skip/dup), which is exactly what the harness proves at the
  protocol level.
- The harness matched the first `tvshows` view ("Special TV Shows"); the result
  holds for any TV Shows library grid since the `/Items` contract is identical
  across views.
- On-device M63 pixel capture is firmware-blocked on the Q60R (see
  [JEL-7](/JEL/issues/JEL-7)); the shell's grid involvement is *nil*, so there is
  no TV-only grid code to capture — parity is established by the server contract
  plus the shared, byte-identical rescue/auto-focus bytes.

```
Re-run: node tooling/tv-validate/library-browsing/verify-library-browsing.mjs
```
